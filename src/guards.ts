// Guardrails for cost-bearing and credential-bearing tools.
//
// Every guard here behaves identically on sandbox, production and custom
// hosts: sandbox carries live matches for self-serve customers, so it gets no
// looser treatment.

import { constants as fsConstants, existsSync } from "node:fs";
import { lstat, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, parse } from "node:path";
import { MASK, type PlannedRequest } from "./client.js";
import type { SessionRun } from "./types.js";

/** TTL applied to a launch that does not give one. */
export const DEFAULT_SESSION_TTL = "30m";
/** Label added to every session launched through this server. */
export const AGENT_LABEL_KEY = "launched-by";
export const AGENT_LABEL_VALUE = "gameye-mcp";
/** `expires_after` sent when create-token is called without one. */
export const DEFAULT_TOKEN_EXPIRY = "24h";

/** A guard refused the call. No request was sent. */
export class GuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

/** The part of the client that knows the token. Guards never see the token itself. */
export interface TokenChecker {
  containsToken(text: string): boolean;
  maskToken(text: string): string;
}

// ─── Launch ───────────────────────────────────────────────────────────────────

/**
 * Return the name of the first launch field that contains the configured API
 * token (e.g. `env.API_KEY`, `args[2]`, `labels key "x"`), or undefined.
 * Never returns the value.
 */
export function findTokenInLaunch(req: SessionRun, checker: TokenChecker): string | undefined {
  for (const [k, v] of Object.entries(req.env ?? {})) {
    if (checker.containsToken(k)) return `an env variable name`;
    if (checker.containsToken(v)) return `env.${k}`;
  }
  for (const [i, a] of (req.args ?? []).entries()) {
    if (checker.containsToken(a)) return `args[${i}]`;
  }
  for (const [k, v] of Object.entries(req.labels ?? {})) {
    if (checker.containsToken(k)) return `a label key`;
    if (checker.containsToken(v)) return `labels.${k}`;
  }
  for (const field of ["id", "location", "image", "version", "ttl"] as const) {
    const v = req[field];
    if (typeof v === "string" && checker.containsToken(v)) return field;
  }
  return undefined;
}

/** Refuse a launch that would pass the API token into the container or its metadata. */
export function assertNoTokenInLaunch(req: SessionRun, checker: TokenChecker): void {
  const where = findTokenInLaunch(req, checker);
  if (where) {
    throw new GuardError(
      `Launch refused: ${where} contains this server's Gameye API token. No request was sent.\n` +
        "A game server never needs the Gameye API token, and session env and labels are readable by any token in your organization with session:read. " +
        "Keep the token on your backend and pass the game server only short-lived per-match values."
    );
  }
}

export interface LaunchDefaults {
  request: SessionRun;
  /** True when no TTL was given and DEFAULT_SESSION_TTL was applied. */
  defaultTtlApplied: boolean;
}

/**
 * Apply the default TTL and the agent label. The label always wins over a
 * caller-supplied `launched-by`, so agent-launched sessions can always be
 * found and cleaned up. Does not modify `req`.
 */
export function applyLaunchDefaults(req: SessionRun): LaunchDefaults {
  const ttl = req.ttl?.trim();
  const defaultTtlApplied = !ttl;
  const labels = { ...(req.labels ?? {}) };
  labels[AGENT_LABEL_KEY] = AGENT_LABEL_VALUE;
  return {
    request: { ...req, ttl: defaultTtlApplied ? DEFAULT_SESSION_TTL : ttl, labels },
    defaultTtlApplied,
  };
}

export function describeTtl(ttl: string, defaultApplied: boolean): string {
  return defaultApplied
    ? `${ttl} (default applied because no ttl was given; pass ttl to change it)`
    : ttl;
}

// ─── Stop ─────────────────────────────────────────────────────────────────────

/** Stop takes exactly one explicit session ID: no empty, wildcard or list values. */
export function assertExplicitSessionId(id: unknown): string {
  if (typeof id !== "string" || id.trim() === "") {
    throw new GuardError("Stop refused: an explicit session ID is required. No request was sent.");
  }
  if (/[*?,\s]/.test(id)) {
    throw new GuardError(
      "Stop refused: the session ID must be one exact ID, not a pattern or a list. Stop sessions one at a time. No request was sent."
    );
  }
  return id;
}

// ─── Dry run ──────────────────────────────────────────────────────────────────

/** Render the exact request a tool would send, with the API token masked. Sends nothing. */
export function formatDryRun(
  target: { environment: string; host: string; baseUrl: string },
  req: PlannedRequest,
  checker: TokenChecker
): string {
  const lines = [
    "Dry run: nothing was sent.",
    "",
    `Environment: ${target.environment}`,
    `Host:        ${target.host}`,
    `Request:     ${req.method} ${target.baseUrl}${req.path}`,
    `Path:        ${req.path}`,
    `Headers:     Authorization: Bearer ${MASK}`,
  ];
  if (req.body !== undefined) {
    lines.push("Body:", JSON.stringify(req.body, null, 2));
  }
  return checker.maskToken(lines.join("\n"));
}

// ─── Token output file ────────────────────────────────────────────────────────

/** Walk up from `dir` and return the first directory that contains `.git`, if any. */
export function findGitWorkTree(dir: string): string | undefined {
  let current = dir;
  const { root } = parse(current);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    if (current === root) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Check that `path` is a safe place to write a new token, without creating it.
 * Returns the path with its parent directory resolved through symlinks.
 */
export async function checkTokenOutputPath(path: string, overwrite: boolean): Promise<string> {
  if (!isAbsolute(path)) {
    throw new GuardError(`Token file path must be absolute (got "${path}"). No token was created.`);
  }
  const parentStat = await lstatOrUndefined(dirname(path));
  if (!parentStat) {
    throw new GuardError(`The directory ${dirname(path)} does not exist. No token was created.`);
  }
  const parent = await realpath(dirname(path));
  const resolved = join(parent, basename(path));

  const repo = findGitWorkTree(parent);
  if (repo) {
    throw new GuardError(
      `Refused: ${resolved} is inside the git working tree at ${repo}. A token file there could be committed. ` +
        "Choose a path outside any repository, for example in your home directory. No token was created."
    );
  }

  const existing = await lstatOrUndefined(resolved);
  if (existing?.isSymbolicLink()) {
    throw new GuardError(`Refused: ${resolved} is a symlink. Token files are never written through symlinks. No token was created.`);
  }
  if (existing && !overwrite) {
    throw new GuardError(`Refused: ${resolved} already exists. Pass overwrite: true to replace it. No token was created.`);
  }
  if (existing && !existing.isFile()) {
    throw new GuardError(`Refused: ${resolved} exists and is not a regular file. No token was created.`);
  }
  return resolved;
}

const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const EXCLUSIVE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW;

/**
 * A token file reserved on disk before the token is minted. Without overwrite
 * the target itself is created exclusively; with overwrite a sibling temp file
 * is created exclusively and renamed over the target on commit, so a failed
 * mint never destroys the existing file.
 */
export interface ReservedTokenFile {
  path: string;
  commit(secret: string): Promise<void>;
  abort(): Promise<void>;
}

export async function reserveTokenFile(path: string, overwrite: boolean): Promise<ReservedTokenFile> {
  const resolved = await checkTokenOutputPath(path, overwrite);
  const writePath = overwrite
    ? join(dirname(resolved), `.${basename(resolved)}.${randomBytes(6).toString("hex")}.tmp`)
    : resolved;

  let handle: FileHandle;
  try {
    handle = await open(writePath, EXCLUSIVE_FLAGS, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new GuardError(`Refused: ${resolved} already exists. No token was created.`);
    if (code === "ELOOP") throw new GuardError(`Refused: ${resolved} is a symlink. No token was created.`);
    throw err;
  }
  await handle.chmod(0o600);

  let done = false;
  return {
    path: resolved,
    /**
     * Write the secret and move it into place. On any failure the reserved
     * file (the target itself, or the temp sibling) is removed and the error
     * is rethrown, so no partial token file is left behind.
     */
    async commit(secret: string) {
      if (done) return;
      done = true;
      try {
        try {
          await handle.writeFile(`${secret}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (writePath !== resolved) {
          const now = await lstatOrUndefined(resolved);
          if (now?.isSymbolicLink()) {
            throw new Error(`${resolved} became a symlink, and token files are never written through symlinks`);
          }
          await rename(writePath, resolved);
        }
      } catch (err) {
        await unlink(writePath).catch(() => undefined);
        throw err;
      }
    },
    async abort() {
      if (done) return;
      done = true;
      await handle.close().catch(() => undefined);
      await unlink(writePath).catch(() => undefined);
    },
  };
}
