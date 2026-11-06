// Offline Dockerfile check against the gameye-containerize container contract.
//
// A pure function over Dockerfile text: it reads no files, spawns nothing and
// makes no request. Each rule cites the numbered contract item it enforces, so
// a later test can check the numbers against the bundled skill. Any value the
// check flags as a credential is redacted to `***` here, by the check itself;
// the server's own token masking does not know about values in user input.

import { GuardError } from "./guards.js";

export type Severity = "error" | "warning";
export type Protocol = "tcp" | "udp";

export interface DeclaredPort {
  port: number;
  protocol: Protocol;
}

export interface DockerfileFinding {
  severity: Severity;
  code: RuleCode;
  /** 1-based line where the offending instruction starts. */
  line: number;
  message: string;
  fix: string;
}

export interface DockerfileCheckResult {
  findings: DockerfileFinding[];
}

export interface DockerfileRule {
  code: string;
  /** Number of the item in the gameye-containerize "container contract" list. */
  contractNumber: number;
  /** Text that must appear in that contract item. */
  keyword: string;
  severity: Severity;
}

export const DOCKERFILE_RULES = [
  { code: "GC1-arm64-platform", contractNumber: 1, keyword: "linux/amd64", severity: "error" },
  { code: "GC1-windows-base", contractNumber: 1, keyword: "Windows containers", severity: "error" },
  { code: "GC2-expose-missing", contractNumber: 2, keyword: "EXPOSE", severity: "error" },
  { code: "GC2-port-mismatch", contractNumber: 2, keyword: "EXPOSE", severity: "error" },
  { code: "GC2-loopback-bind", contractNumber: 2, keyword: "0.0.0.0", severity: "error" },
  { code: "GC4-exec-form", contractNumber: 4, keyword: "SIGTERM", severity: "error" },
  { code: "GC4-npm-start", contractNumber: 4, keyword: "SIGTERM", severity: "error" },
  { code: "GC7-non-root", contractNumber: 7, keyword: "non-root", severity: "warning" },
  { code: "GC9-token-in-image", contractNumber: 9, keyword: "API token", severity: "error" },
] as const satisfies readonly DockerfileRule[];

export type RuleCode = (typeof DOCKERFILE_RULES)[number]["code"];

export const CANNOT_KNOW =
  "What this check cannot know: whether the image is pushed to a registry Gameye can pull from, " +
  "whether your application's port bindings in the Gameye Admin Panel match these ports and protocols, " +
  "and whether the server binary starts, binds its ports and exits on SIGTERM. It reads only the Dockerfile " +
  "text, not entrypoint scripts, build output or the base image's defaults. A clean result means no contract " +
  "break was found in this text, nothing more; test the image locally before launching it.";

const SKILL = "gameye-containerize";

// ── Parsing ─────────────────────────────────────────────────────────────────

export interface Instruction {
  keyword: string;
  args: string;
  line: number;
}

interface Stage {
  from: Instruction;
  image: string;
  platform?: string;
  name?: string;
  body: Instruction[];
}

/** Split Dockerfile text into instructions, joining continuations and skipping comments and heredoc bodies. */
export function parseDockerfile(text: string): Instruction[] {
  const lines = text.split(/\r?\n/);
  const escapeMatch = /^#\s*escape\s*=\s*([`\\])\s*$/i.exec(lines[0] ?? "");
  const escape = escapeMatch ? escapeMatch[1] : "\\";
  const out: Instruction[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    const start = i + 1;
    let joined = "";
    let current = raw;
    for (;;) {
      const t = current.trimEnd();
      if (t.endsWith(escape)) {
        joined += t.slice(0, -1) + " ";
        i++;
        // Comment and empty lines inside a continuation are dropped.
        while (i < lines.length && (lines[i].trim() === "" || lines[i].trim().startsWith("#"))) i++;
        if (i >= lines.length) break;
        current = lines[i];
      } else {
        joined += t;
        i++;
        break;
      }
    }
    const m = /^\s*(\S+)\s*(.*)$/s.exec(joined);
    if (!m) continue;
    const keyword = m[1].toUpperCase();
    const args = m[2].trim();
    out.push({ keyword, args, line: start });
    // Skip heredoc bodies (RUN <<EOT ... EOT) so their lines are not read as instructions.
    for (const h of args.matchAll(/<<(-?)\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/g)) {
      const [, dash, delim] = h;
      while (i < lines.length) {
        const l = dash ? lines[i].replace(/^\t+/, "") : lines[i];
        i++;
        if (l.trim() === delim) break;
      }
    }
  }
  return out;
}

function splitStages(instructions: Instruction[]): Stage[] {
  const stages: Stage[] = [];
  for (const ins of instructions) {
    if (ins.keyword === "FROM") {
      const words = ins.args.split(/\s+/).filter(Boolean);
      let platform: string | undefined;
      const rest: string[] = [];
      for (const w of words) {
        const p = /^--platform=(.*)$/i.exec(w);
        if (p) platform = p[1];
        else if (!w.startsWith("--")) rest.push(w);
      }
      const asIdx = rest.findIndex((w) => w.toUpperCase() === "AS");
      stages.push({
        from: ins,
        image: rest[0] ?? "",
        platform,
        name: asIdx >= 0 ? rest[asIdx + 1]?.toLowerCase() : undefined,
        body: [],
      });
    } else if (stages.length > 0) {
      stages[stages.length - 1].body.push(ins);
    }
  }
  return stages;
}

/** The final stage plus any earlier stages it is built FROM, root first. */
function finalChain(stages: Stage[]): Stage[] {
  const chain: Stage[] = [];
  let idx = stages.length - 1;
  while (idx >= 0) {
    const stage = stages[idx];
    chain.unshift(stage);
    const parent = stage.image.toLowerCase();
    idx = stages.findIndex((s, j) => j < idx && s.name === parent);
  }
  return chain;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseExecForm(args: string): string[] | undefined {
  if (!args.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(args);
    return Array.isArray(parsed) && parsed.every((x) => typeof x === "string") ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Parse `KEY=value KEY2="v w"` (or legacy `KEY value` for ENV) into pairs. */
function parseAssignments(keyword: string, args: string): Array<{ name: string; value: string | undefined }> {
  const legacy = /^([A-Za-z_][A-Za-z0-9_]*)\s+(?!\S*=)(.*)$/s.exec(args);
  if (keyword === "ENV" && legacy && !args.split(/\s+/)[0].includes("=")) {
    return [{ name: legacy[1], value: unquote(legacy[2].trim()) }];
  }
  const pairs: Array<{ name: string; value: string | undefined }> = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)(?:=("(?:[^"\\]|\\.)*"|'[^']*'|\S*))?/g;
  for (const m of args.matchAll(re)) pairs.push({ name: m[1], value: m[2] === undefined ? undefined : unquote(m[2]) });
  return pairs;
}

function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL)/i;
const SECRET_VALUE = /^(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)$/;

function isLiteral(value: string | undefined): value is string {
  return value !== undefined && value !== "" && !/^\$\{?[A-Za-z_][A-Za-z0-9_]*(:-[^}]*)?\}?$/.test(value);
}

function parseExpose(args: string): Array<{ from: number; to: number; protocol: Protocol }> {
  const out: Array<{ from: number; to: number; protocol: Protocol }> = [];
  for (const word of args.split(/\s+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?(?:\/(tcp|udp))?$/i.exec(word);
    if (!m) continue; // variables and other forms can't be resolved statically
    out.push({ from: Number(m[1]), to: Number(m[2] ?? m[1]), protocol: (m[3]?.toLowerCase() ?? "tcp") as Protocol });
  }
  return out;
}

function rule(code: RuleCode) {
  return DOCKERFILE_RULES.find((r) => r.code === code)!;
}

// ── Check ───────────────────────────────────────────────────────────────────

export function checkDockerfile(text: string, opts: { ports?: DeclaredPort[] } = {}): DockerfileCheckResult {
  const instructions = parseDockerfile(text);
  const stages = splitStages(instructions);
  if (instructions.length === 0 || stages.length === 0) {
    throw new GuardError("No Dockerfile instructions found: pass the full Dockerfile text, starting with a FROM line.");
  }

  const findings: DockerfileFinding[] = [];
  const add = (code: RuleCode, line: number, message: string, fix: string) =>
    findings.push({ severity: rule(code).severity, code, line, message, fix });

  const chain = finalChain(stages);
  const root = chain[0];
  const finalFrom = chain[chain.length - 1].from;
  const runtime = chain.flatMap((s) => s.body);

  // GC1: linux/amd64 only.
  for (const stage of chain) {
    if (stage.platform && /arm64|aarch64|linux\/arm\b|arm\/v/i.test(stage.platform)) {
      add(
        "GC1-arm64-platform",
        stage.from.line,
        `The runtime image is pinned to ${stage.platform}; the Gameye fleet runs linux/amd64 only.`,
        `Remove the arm64 --platform pin (or use --platform=linux/amd64) and build with docker buildx build --platform=linux/amd64. See ${SKILL}.`
      );
    }
  }
  if (/^mcr\.microsoft\.com\/windows|nanoserver|servercore/i.test(root.image) || /^windows/i.test(root.platform ?? "")) {
    add(
      "GC1-windows-base",
      root.from.line,
      "The runtime image uses a Windows base image; Gameye runs Linux containers only.",
      `Build a Linux dedicated server and use a Linux base image such as debian:bookworm-slim. See ${SKILL}.`
    );
  }

  // GC2: EXPOSE present and consistent with declared ports.
  const exposes = runtime.filter((i) => i.keyword === "EXPOSE");
  if (exposes.length === 0) {
    add(
      "GC2-expose-missing",
      finalFrom.line,
      "The runtime stage has no EXPOSE; the exposed ports must match what the server binds and the application's port bindings.",
      `Add EXPOSE <port>/<protocol> for every port the server binds, e.g. EXPOSE 7777/udp. See ${SKILL}.`
    );
  } else if (opts.ports && opts.ports.length > 0) {
    const exposed = exposes.flatMap((i) => parseExpose(i.args).map((p) => ({ ...p, line: i.line })));
    const lastExpose = exposes[exposes.length - 1].line;
    const isExposed = (d: DeclaredPort) => exposed.some((e) => e.protocol === d.protocol && d.port >= e.from && d.port <= e.to);
    for (const d of opts.ports) {
      if (isExposed(d)) continue;
      const other = exposed.find((e) => d.port >= e.from && d.port <= e.to);
      add(
        "GC2-port-mismatch",
        other?.line ?? lastExpose,
        other
          ? `Port ${d.port} is declared as ${d.protocol} but exposed as ${other.protocol}.`
          : `Declared port ${d.port}/${d.protocol} is not exposed.`,
        `Make EXPOSE list exactly the ports and protocols the server binds (${d.port}/${d.protocol}), and match them in the application's port bindings. See ${SKILL}.`
      );
    }
    for (const e of exposed) {
      const declared = opts.ports.some((d) => d.port >= e.from && d.port <= e.to);
      if (declared) continue;
      const range = e.from === e.to ? `${e.from}` : `${e.from}-${e.to}`;
      add(
        "GC2-port-mismatch",
        e.line,
        `Port ${range}/${e.protocol} is exposed but not among the declared ports.`,
        `Remove the EXPOSE for ports the server does not bind, or declare them. See ${SKILL}.`
      );
    }
  }

  // GC2 / GC4: launch command.
  const lastOf = (kw: string) => [...runtime].reverse().find((i) => i.keyword === kw);
  const launch = [lastOf("ENTRYPOINT"), lastOf("CMD")].filter((i): i is Instruction => i !== undefined).sort((a, b) => a.line - b.line);
  for (const ins of launch) {
    const exec = parseExecForm(ins.args);
    if (!exec) {
      add(
        "GC4-exec-form",
        ins.line,
        `${ins.keyword} uses shell form, so /bin/sh is PID 1 and swallows SIGTERM; the server is hard-killed with no drain.`,
        `Use exec form, e.g. ${ins.keyword} ["/server/game-server", "--port", "7777"], and exec the binary from any entrypoint script. See ${SKILL}.`
      );
    }
    const words = exec ?? ins.args.split(/\s+/);
    const cmd = words.join(" ");
    if (/(^|[\s/])(npm|yarn)(\s+run)?\s+start\b/.test(cmd)) {
      add(
        "GC4-npm-start",
        ins.line,
        `${ins.keyword} launches through npm/yarn start, which sits between PID 1 and the server and swallows SIGTERM.`,
        `Run the server directly, e.g. ${ins.keyword} ["node", "server/server.js"]. See ${SKILL}.`
      );
    }
    if (/(^|[^\d.])127\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])|\blocalhost\b/i.test(cmd)) {
      add(
        "GC2-loopback-bind",
        ins.line,
        `${ins.keyword} binds the server to a loopback address, which is unreachable from outside the container.`,
        `Bind on 0.0.0.0 (all interfaces) instead of 127.0.0.1 or localhost. See ${SKILL}.`
      );
    }
  }

  // GC7: non-root user.
  const user = lastOf("USER");
  const userName = user?.args.split(/\s+/)[0].split(":")[0];
  if (!user || userName === "root" || userName === "0") {
    add(
      "GC7-non-root",
      user?.line ?? finalFrom.line,
      user ? "The runtime stage switches to root." : "The runtime stage sets no USER, so the server runs as root unless the base image says otherwise.",
      `Create a system user and switch to it before ENTRYPOINT, e.g. USER game. See ${SKILL}.`
    );
  }

  // GC9: no Gameye API token or credential in ENV/ARG (any stage; the Dockerfile itself is shared).
  const secrets: string[] = [];
  for (const ins of instructions) {
    if (ins.keyword !== "ENV" && ins.keyword !== "ARG") continue;
    for (const { name, value } of parseAssignments(ins.keyword, ins.args)) {
      const gameye = name.toUpperCase() === "GAMEYE_API_TOKEN";
      const literal = isLiteral(value);
      const credential = gameye || (literal && (SECRET_NAME.test(name) || SECRET_VALUE.test(value)));
      if (!credential) continue;
      if (literal) secrets.push(value);
      add(
        "GC9-token-in-image",
        ins.line,
        `${ins.keyword} ${name}${value === undefined ? "" : "=***"} puts ${gameye ? "a Gameye API token" : "a credential"} in the image or its build history.`,
        `Remove it from the Dockerfile. The Gameye API token belongs to your backend only; pass only short-lived per-match values in the session env. Rotate the token if this was ever pushed. See ${SKILL}.`
      );
    }
  }

  findings.sort((a, b) => a.line - b.line);
  return { findings: redact(findings, secrets) };
}

/** Replace every flagged credential value with `***`, wherever it appears. */
function redact(findings: DockerfileFinding[], secrets: string[]): DockerfileFinding[] {
  const values = [...new Set(secrets)].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
  const clean = (t: string) => values.reduce((acc, v) => acc.split(v).join("***"), t);
  return findings.map((f) => ({ ...f, message: clean(f.message), fix: clean(f.fix) }));
}

export function formatDockerfileReport(result: DockerfileCheckResult): string {
  const errors = result.findings.filter((f) => f.severity === "error").length;
  const warnings = result.findings.length - errors;
  const lines = [`Dockerfile check against the ${SKILL} container contract: ${errors} error(s), ${warnings} warning(s).`, ""];
  if (result.findings.length === 0) {
    lines.push("No contract issues found in the Dockerfile text.", "");
  }
  for (const f of result.findings) {
    lines.push(`${f.severity.toUpperCase()} ${f.code} (line ${f.line}): ${f.message}`, `  Fix: ${f.fix}`, "");
  }
  lines.push(CANNOT_KNOW);
  return lines.join("\n");
}
