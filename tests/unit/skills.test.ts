import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { registerSkillsTools } from "../../src/tools/skills.js";
import { compareVersions, LATEST_PACK_URL, parsePackVersion, stripAnsi, type SkillsEnv } from "../../src/skills.js";
import { makeMockServer, makeContext, getText } from "./helpers.js";

const HOME = join("/", "u", "tester");
const CWD = "/work/game";
const skill = (v: string) => `---\nname: gameye\n---\n\n# Gameye\n\nPack version: ${v}\n`;
const lock = (skills: Record<string, string>) =>
  JSON.stringify({ version: 3, skills: Object.fromEntries(Object.entries(skills).map(([n, source]) => [n, { source }])) });

function setup(files: Record<string, string>, latest = "1.5.0", opts: { runFails?: boolean; runNoop?: boolean; fetchFails?: boolean; platform?: NodeJS.Platform } = {}) {
  const disk = { ...files };
  const ran: string[] = [];
  const env: SkillsEnv = {
    home: HOME,
    cwd: CWD,
    platform: opts.platform ?? "linux",
    readText: async (p) => disk[p],
    fetchText: async (url) => {
      expect(url).toBe(LATEST_PACK_URL);
      if (opts.fetchFails) throw new Error("GET failed: 503");
      return skill(latest);
    },
    run: async (cmd, args) => {
      ran.push([cmd, ...args].join(" "));
      if (opts.runFails) throw new Error(`${cmd} failed: exit 1`);
      if (opts.runNoop) return "nothing to update";
      for (const p of Object.keys(disk)) if (p.endsWith(join("gameye", "SKILL.md"))) disk[p] = skill(latest);
      return "updated";
    },
  };
  const mock = makeMockServer();
  registerSkillsTools(mock.server, makeContext(), env);
  const call = async (args: Record<string, unknown> = {}) => mock.handlers["gameye_update_skills"](args);
  return { call, ran, configs: mock.configs };
}

const globalInstall = {
  [join(HOME, ".agents", ".skill-lock.json")]: lock({ gameye: "gameye/gameye-skills", "gameye-launch": "Gameye/gameye-skills", other: "acme/skills" }),
  [join(HOME, ".agents", "skills", "gameye", "SKILL.md")]: skill("1.4.0"),
};

describe("pack version helpers", () => {
  it("reads the Pack version line and compares versions numerically", () => {
    expect(parsePackVersion(skill("1.10.2"))).toBe("1.10.2");
    expect(parsePackVersion("no version here")).toBeUndefined();
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
    expect(compareVersions("2.0.0", "1.10.0")).toBe(1);
    expect(compareVersions("1.4.0", "1.4.0")).toBe(0);
  });

  it("strips terminal codes from updater output", () => {
    expect(stripAnsi("\x1b[38;5;145mUpdated\x1b[0m\r\x1b[K done")).toBe("Updated done");
  });
});

describe("gameye_update_skills", () => {
  it("only checks by default and runs nothing", async () => {
    const { call, ran } = setup(globalInstall);
    const text = getText(await call());
    expect(text).toContain("Latest Gameye skills pack: 1.5.0");
    expect(text).toContain("skills CLI, user-wide: pack 1.4.0 (update available)");
    expect(text).toContain("npx -y skills update gameye gameye-launch -g -y");
    expect(ran).toEqual([]);
  });

  it("updates only the Gameye skills, and reports the new version, with apply=true", async () => {
    const { call, ran } = setup(globalInstall);
    const res = await call({ apply: true });
    expect(res.isError).toBeFalsy();
    expect(ran).toEqual(["npx -y skills update gameye gameye-launch -g -y"]);
    expect(getText(res)).toMatch(/After updating:\n• skills CLI, user-wide: pack 1\.5\.0/);
  });

  it("says up to date and runs nothing when the installs are current", async () => {
    const { call, ran } = setup(globalInstall, "1.4.0");
    const text = getText(await call({ apply: true }));
    expect(text).toContain("pack 1.4.0 (up to date)");
    expect(ran).toEqual([]);
  });

  it("updates a project install with -p and the plugin through claude plugin update", async () => {
    const pluginPath = join(HOME, ".claude", "plugins", "cache", "gameye", "gameye", "abc");
    const { call, ran } = setup({
      [join(CWD, "skills-lock.json")]: lock({ gameye: "gameye/gameye-skills" }),
      [join(CWD, ".claude", "skills", "gameye", "SKILL.md")]: skill("1.3.0"),
      [join(HOME, ".claude", "plugins", "installed_plugins.json")]: JSON.stringify({
        version: 2,
        plugins: { "gameye@gameye": [{ installPath: pluginPath }] },
      }),
      [join(pluginPath, "skills", "gameye", "SKILL.md")]: skill("1.4.0"),
    });
    await call({ apply: true });
    expect(ran).toEqual([
      "npx -y skills update gameye -p -y",
      "claude plugin marketplace update gameye",
      "claude plugin update gameye@gameye",
    ]);
  });

  it("reports a failed update as an error and keeps the command output", async () => {
    const { call } = setup(globalInstall, "1.5.0", { runFails: true });
    const res = await call({ apply: true });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("Failed: npx failed: exit 1");
  });

  it("falls back to the loaded skill's version when no install is found", async () => {
    const { call, ran } = setup({});
    const text = getText(await call({ installedVersion: "1.2.0", apply: true }));
    expect(text).toContain("No skills CLI or Claude Code plugin install");
    expect(text).toContain("reports pack 1.2.0");
    expect(text).toContain("npx skills add gameye/gameye-skills");
    expect(ran).toEqual([]);
  });

  it("ignores skills installed from other sources", async () => {
    const { call } = setup({ [join(HOME, ".agents", ".skill-lock.json")]: lock({ other: "acme/gameye-skills-fork" }) });
    expect(getText(await call())).toContain("No skills CLI or Claude Code plugin install");
  });

  it("is a write tool that reaches the network", () => {
    const { configs } = setup({});
    expect(configs["gameye_update_skills"].annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });

  it("never passes a lock-file name that looks like a CLI option", async () => {
    const { call, ran } = setup({
      ...globalInstall,
      [join(HOME, ".agents", ".skill-lock.json")]: lock({ gameye: "gameye/gameye-skills", "--yes-all": "gameye/gameye-skills" }),
    });
    await call({ apply: true });
    expect(ran).toEqual(["npx -y skills update gameye -g -y"]);
  });

  it("recognises the other ways a lock file names the repository", async () => {
    const { call } = setup({
      [join(HOME, ".agents", ".skill-lock.json")]: lock({
        gameye: "https://github.com/Gameye/gameye-skills.git",
        "gameye-launch": "git@github.com:gameye/gameye-skills.git",
        "gameye-troubleshoot": "gameye/gameye-skills/",
        evil: "evil/gameye-skills",
      }),
    });
    expect(getText(await call())).toContain("npx -y skills update gameye gameye-launch gameye-troubleshoot -g -y");
  });

  it("reports the installs and updates nothing when GitHub can't be read", async () => {
    const { call, ran } = setup(globalInstall, "1.5.0", { fetchFails: true });
    const res = await call({ apply: true });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("Could not read the latest Gameye skills pack version");
    expect(getText(res)).toContain("skills CLI, user-wide: pack 1.4.0");
    expect(ran).toEqual([]);
  });

  it("flags an install that is still behind after its updater succeeds", async () => {
    const { call } = setup(globalInstall, "1.5.0", { runNoop: true });
    const res = await call({ apply: true });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("pack 1.4.0 (still behind)");
  });

  it("counts the oldest copy when the skill is in more than one agent folder", async () => {
    const { call } = setup({ ...globalInstall, [join(HOME, ".claude", "skills", "gameye", "SKILL.md")]: skill("1.2.0") }, "1.4.0");
    expect(getText(await call())).toContain("pack 1.2.0 (update available)");
  });

  it("prints the commands instead of running them on Windows", async () => {
    const { call, ran } = setup(globalInstall, "1.5.0", { platform: "win32" });
    const text = getText(await call({ apply: true }));
    expect(text).toContain("isn't supported on Windows");
    expect(text).toContain("npx -y skills update gameye gameye-launch -g -y");
    expect(ran).toEqual([]);
  });

  it("doesn't suggest updating a loaded skill that is already current", async () => {
    const { call } = setup({}, "1.5.0");
    expect(getText(await call({ installedVersion: "1.5.0" }))).not.toContain("To update");
  });
});
