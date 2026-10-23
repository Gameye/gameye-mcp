import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the `gameye` skill's `Pack version:` line is published. */
export const LATEST_PACK_URL = "https://raw.githubusercontent.com/Gameye/gameye-skills/main/skills/gameye/SKILL.md";

const PACK_VERSION_RE = /^Pack version: (\d+\.\d+\.\d+)[ \t]*$/m;
const SKILLS_SOURCE_RE = /^(https:\/\/github\.com\/|git@github\.com:|github:)?gameye\/gameye-skills(\.git)?\/?$/i;
// Lock files can come from a cloned project, so a name must look like a skill name, never a CLI option.
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** The skills CLI the updater runs, pinned so `npx` never fetches whatever is newest. */
export const SKILLS_CLI = "skills@1.7.4";

/** Set to 1 to let `gameye_update_skills` run updaters; otherwise apply prints the commands. */
export const ENABLE_UPDATE_ENV = "GAMEYE_ENABLE_SKILLS_UPDATE";

// What an updater needs from the parent: where to find programs and home, temp dirs, locale,
// proxy and CA settings, npm and Claude config. Nothing else is passed, so the Gameye token stays here.
const CHILD_ENV_NAMES = new Set([
  "PATH", "Path", "PATHEXT", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH",
  "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "WINDIR", "TEMP", "TMP", "TMPDIR",
  "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "CLAUDE_CONFIG_DIR",
]);
const CHILD_ENV_PREFIXES = ["XDG_", "npm_config_", "NPM_CONFIG_"];
// Never passed, even under an allowed prefix: an npm registry token is not the updater's business either.
const SECRET_NAME_RE = /token|secret|password|passwd|auth|key|credential/i;

/** The environment an updater runs with: the allowlist above, no Gameye variables, nothing that looks like a secret. */
export function childEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined || name.toUpperCase().startsWith("GAMEYE_") || SECRET_NAME_RE.test(name)) continue;
    if (CHILD_ENV_NAMES.has(name) || CHILD_ENV_PREFIXES.some((p) => name.startsWith(p))) env[name] = value;
  }
  return { ...env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" };
}

/** How the Gameye skills were installed. Each kind updates differently. */
export type InstallKind = "skills-cli-global" | "skills-cli-project" | "claude-plugin";

export interface SkillsInstall {
  kind: InstallKind;
  /** Pack version read from the installed `gameye` skill, if it could be read. */
  version?: string;
  /** Skill names installed from gameye-skills (skills CLI installs only). */
  skills: string[];
}

/** Everything the check touches outside this module, so tests can replace it. */
export interface SkillsEnv {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  /** The operator set GAMEYE_ENABLE_SKILLS_UPDATE=1: apply may run updaters. */
  applyEnabled: boolean;
  readText: (path: string) => Promise<string | undefined>;
  fetchText: (url: string) => Promise<string>;
  run: (cmd: string, args: string[], cwd: string) => Promise<string>;
}

export function defaultSkillsEnv(): SkillsEnv {
  return {
    home: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    applyEnabled: process.env[ENABLE_UPDATE_ENV] === "1",
    readText: (path) => readFile(path, "utf8").catch(() => undefined),
    fetchText: async (url) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
      return res.text();
    },
    run: (cmd, args, cwd) =>
      new Promise((resolve, reject) => {
        const options = { cwd, env: childEnv(process.env), timeout: 90_000, killSignal: "SIGKILL" as const, maxBuffer: 4 * 1024 * 1024 };
        const child = execFile(cmd, args, options, (err, stdout, stderr) => {
          const out = stripAnsi(`${stdout}${stderr}`).trim();
          if (err) reject(new Error(`${cmd} ${args.join(" ")} failed: ${err.message}\n${out}`));
          else resolve(out);
        });
        // Closed stdin makes a prompting CLI fail at once instead of waiting for the timeout.
        child.stdin?.end();
      }),
  };
}

// Terminal colour and cursor codes and carriage returns, which some CLIs print even when asked not to.
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\r/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export function parsePackVersion(skillText: string | undefined): string | undefined {
  return skillText ? PACK_VERSION_RE.exec(skillText)?.[1] : undefined;
}

/** -1, 0 or 1 for two X.Y.Z versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Skill names a skills CLI lock file records as coming from gameye-skills. */
function gameyeSkillsInLock(lockText: string | undefined): string[] {
  const lock = parseJson(lockText) as { skills?: Record<string, { source?: string; sourceUrl?: string }> } | undefined;
  return Object.entries(lock?.skills ?? {})
    .filter(([name, s]) => SKILL_NAME_RE.test(name) && (SKILLS_SOURCE_RE.test(s.source ?? "") || SKILLS_SOURCE_RE.test(s.sourceUrl ?? "")))
    .map(([name]) => name)
    .sort();
}

// The skills CLI keeps one copy in .agents/skills when it installs for several agents,
// and copies straight into the agent's own folder when it installs for one.
const SKILL_DIRS = [".agents/skills", ".claude/skills", ".codex/skills", ".cursor/skills", ".config/opencode/skills"];

/** The oldest pack version among the copies found, so one stale copy still counts as outdated. */
async function readInstalledPackVersion(env: SkillsEnv, root: string): Promise<string | undefined> {
  const versions: string[] = [];
  for (const dir of SKILL_DIRS) {
    const version = parsePackVersion(await env.readText(join(root, dir, "gameye", "SKILL.md")));
    if (version) versions.push(version);
  }
  return versions.sort(compareVersions)[0];
}

async function skillsCliInstall(env: SkillsEnv, kind: InstallKind, lockPath: string, root: string): Promise<SkillsInstall | undefined> {
  const skills = gameyeSkillsInLock(await env.readText(lockPath));
  if (skills.length === 0) return undefined;
  return { kind, version: await readInstalledPackVersion(env, root), skills };
}

async function claudePluginInstall(env: SkillsEnv): Promise<SkillsInstall | undefined> {
  const registry = parseJson(await env.readText(join(env.home, ".claude", "plugins", "installed_plugins.json"))) as
    | { plugins?: Record<string, Array<{ installPath?: string }>> }
    | undefined;
  const entry = Object.entries(registry?.plugins ?? {}).find(([id]) => id === "gameye@gameye")?.[1]?.[0];
  if (!entry?.installPath) return undefined;
  const version = parsePackVersion(await env.readText(join(entry.installPath, "skills", "gameye", "SKILL.md")));
  return { kind: "claude-plugin", version, skills: [] };
}

/** Find every install of the Gameye skills this server can see: user-wide, this project, and the Claude Code plugin. */
export async function findSkillsInstalls(env: SkillsEnv): Promise<SkillsInstall[]> {
  const found = await Promise.all([
    skillsCliInstall(env, "skills-cli-global", join(env.home, ".agents", ".skill-lock.json"), env.home),
    skillsCliInstall(env, "skills-cli-project", join(env.cwd, "skills-lock.json"), env.cwd),
    claudePluginInstall(env),
  ]);
  return found.filter((i): i is SkillsInstall => i !== undefined);
}

export async function fetchLatestPackVersion(env: SkillsEnv): Promise<string> {
  const version = parsePackVersion(await env.fetchText(LATEST_PACK_URL));
  if (!version) throw new Error(`No "Pack version: X.Y.Z" line in ${LATEST_PACK_URL}`);
  return version;
}

export function isOutdated(install: SkillsInstall, latest: string): boolean {
  return !install.version || compareVersions(install.version, latest) < 0;
}

/** The commands that update an install, as argv lists. The skills CLI updates only the named Gameye skills. */
export function updateCommands(install: SkillsInstall): string[][] {
  switch (install.kind) {
    case "skills-cli-global":
      return [["npx", "-y", SKILLS_CLI, "update", ...install.skills, "-g", "-y"]];
    case "skills-cli-project":
      return [["npx", "-y", SKILLS_CLI, "update", ...install.skills, "-p", "-y"]];
    case "claude-plugin":
      return [
        ["claude", "plugin", "marketplace", "update", "gameye"],
        ["claude", "plugin", "update", "gameye@gameye"],
      ];
  }
}

export function describeInstall(install: SkillsInstall): string {
  const where = {
    "skills-cli-global": "skills CLI, user-wide",
    "skills-cli-project": "skills CLI, this project",
    "claude-plugin": "Claude Code plugin gameye@gameye",
  }[install.kind];
  return `${where}: pack ${install.version ?? "version unknown"}`;
}
