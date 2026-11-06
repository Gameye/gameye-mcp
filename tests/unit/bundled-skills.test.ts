// The bundled skills: gameye_list_skills and gameye_get_skill serve only the
// pinned copy in src/generated/skills.ts, offline and without a token, and
// scripts/sync-skills.mjs keeps that copy matched to skills.pin.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { registerBundledSkillsTools, BUNDLED_PACK_LINE, INSTALLED_WINS_LINE } from "../../src/tools/bundled-skills.js";
import { registerSkillsTools } from "../../src/tools/skills.js";
import { BUNDLED_SKILLS, BUNDLED_SKILLS_PACK_VERSION, BUNDLED_SKILLS_TAG, CONTAINER_CONTRACT } from "../../src/generated/skills.js";
import { LATEST_PACK_URL, type SkillsEnv } from "../../src/skills.js";
import { getText, makeContext, makeMockServer, NO_TOKEN_SANDBOX_PREFIX, type ToolResult } from "./helpers.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function tools(hasToken = false) {
  const mock = makeMockServer();
  registerBundledSkillsTools(mock.server, makeContext({ hasToken }));
  return {
    list: () => mock.handlers["gameye_list_skills"]({}),
    get: (args: Record<string, unknown>) => mock.handlers["gameye_get_skill"](args),
    configs: mock.configs,
  };
}

/** The tool output after the environment prefix line. */
function body(result: ToolResult): string[] {
  return getText(result).split("\n").slice(1);
}

describe("the bundled pack", () => {
  it("matches skills.pin", () => {
    const pin = readFileSync(join(repoRoot, "skills.pin"), "utf8").trim();
    expect(BUNDLED_SKILLS_TAG).toBe(pin);
    expect(BUNDLED_SKILLS_PACK_VERSION).toBe(pin.slice(1));
  });

  it("holds the gameye skill, the engine skills and the container contract", () => {
    const names = BUNDLED_SKILLS.map((s) => s.name);
    for (const n of ["gameye", "gameye-containerize", "gameye-godot-server", "gameye-unity-server", "gameye-unreal-server", "gameye-web-server"]) {
      expect(names).toContain(n);
    }
    expect(CONTAINER_CONTRACT.map((i) => i.number)).toEqual(CONTAINER_CONTRACT.map((_, i) => i + 1));
    expect(CONTAINER_CONTRACT[0].text).toContain("linux/amd64");
  });

  it("passes the internal-reference scan", () => {
    const out = spawnSync(process.execPath, [join(repoRoot, "scripts", "scan-internal-refs.mjs"), join(repoRoot, "src", "generated")], { encoding: "utf8" });
    expect(out.stdout + out.stderr).toContain("OK - no internal references found");
    expect(out.status).toBe(0);
  });
});

describe("gameye_list_skills", () => {
  it("works without a token and opens with the pack version and the installed-wins line", async () => {
    const res = await tools(false).list();
    expect(res.isError).toBeFalsy();
    expect(getText(res).split("\n")[0]).toBe(NO_TOKEN_SANDBOX_PREFIX);
    const [first, second] = body(res);
    expect(first).toBe(BUNDLED_PACK_LINE);
    expect(first).toContain(BUNDLED_SKILLS_PACK_VERSION);
    expect(second).toBe(INSTALLED_WINS_LINE);
  });

  it("lists every skill with its version, description and files", async () => {
    const text = getText(await tools().list());
    for (const skill of BUNDLED_SKILLS) {
      expect(text).toContain(`• ${skill.name} (skill ${skill.version}): ${skill.description}`);
      for (const file of Object.keys(skill.files)) expect(text).toContain(file);
    }
  });

  it("is read-only and closed-world", () => {
    const { configs } = tools();
    for (const name of ["gameye_list_skills", "gameye_get_skill"]) {
      expect(configs[name].annotations?.readOnlyHint, name).toBe(true);
      expect(configs[name].annotations?.openWorldHint, name).toBe(false);
    }
  });
});

describe("gameye_get_skill", () => {
  it("serves every listed skill and reference file without a token or network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { get } = tools(false);
      for (const skill of BUNDLED_SKILLS) {
        for (const [file, text] of Object.entries(skill.files)) {
          const res = await get({ name: skill.name, file });
          expect(res.isError, `${skill.name}/${file}`).toBeFalsy();
          const lines = body(res);
          expect(lines[0]).toBe(BUNDLED_PACK_LINE);
          expect(lines[1]).toBe(INSTALLED_WINS_LINE);
          expect(getText(res).endsWith(text)).toBe(true);
        }
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defaults to SKILL.md", async () => {
    const gameye = BUNDLED_SKILLS.find((s) => s.name === "gameye")!;
    const text = getText(await tools().get({ name: "gameye" }));
    expect(text.endsWith(gameye.files["SKILL.md"])).toBe(true);
    expect(text).toContain(`Pack version: ${BUNDLED_SKILLS_PACK_VERSION}`);
  });

  it.each([
    [{ name: "gameye", file: "../gameye-launch/SKILL.md" }, /parent-directory path/],
    [{ name: "gameye", file: "references/../../../package.json" }, /parent-directory path/],
    [{ name: "gameye", file: "/etc/passwd" }, /absolute path/],
    [{ name: "gameye", file: "C:\\Windows\\win.ini" }, /absolute path/],
    [{ name: "gameye", file: "https://example.com/SKILL.md" }, /URL/],
    [{ name: "https://example.com/skill" }, /URL/],
    [{ name: "../gameye" }, /parent-directory path/],
    [{ name: "/gameye" }, /absolute path/],
    [{ name: "gameye/references" }, /a path/],
  ])("refuses %j", async (args, reason) => {
    const res = await tools().get(args);
    expect(res.isError).toBe(true);
    const lines = body(res);
    expect(lines[0]).toBe(BUNDLED_PACK_LINE);
    expect(lines[1]).toBe(INSTALLED_WINS_LINE);
    expect(getText(res)).toMatch(reason);
  });

  it("refuses an unknown skill and names the bundled ones", async () => {
    const res = await tools().get({ name: "gameye-nope" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain('No bundled skill named "gameye-nope"');
    for (const skill of BUNDLED_SKILLS) expect(getText(res)).toContain(skill.name);
  });

  it("refuses an unknown file and names the skill's files", async () => {
    const res = await tools().get({ name: "gameye", file: "references/missing.md" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("references/routing.md");
  });
});

describe("gameye_update_skills", () => {
  it("reports the bundled pack version next to the latest", async () => {
    const env: SkillsEnv = {
      home: "/h",
      cwd: "/w",
      platform: "linux",
      applyEnabled: false,
      readText: async () => undefined,
      fetchText: async (url) => {
        expect(url).toBe(LATEST_PACK_URL);
        return "Pack version: 9.9.9\n";
      },
      run: async () => "",
    };
    const mock = makeMockServer();
    registerSkillsTools(mock.server, makeContext({ hasToken: false }), env);
    const text = getText(await mock.handlers["gameye_update_skills"]({}));
    expect(text).toContain("Latest Gameye skills pack: 9.9.9");
    expect(text).toContain(`Bundled with this server: pack ${BUNDLED_SKILLS_PACK_VERSION}`);
    expect(mock.configs["gameye_update_skills"].description).toContain("ships a pinned copy of the skills reviewed at build time");
  });
});

describe("scripts/sync-skills.mjs", () => {
  const syncScript = join(repoRoot, "scripts", "sync-skills.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "sync-skills-test-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const skill = (name: string, extra = "") =>
    `---\nname: ${name}\ndescription: ${name}.\nmetadata:\n  version: "1.0.0"\n---\n\n# ${name}\n${extra}`;

  /** A gameye-skills repository tagged with skills.pin's tag, whose gameye skill says `packVersion`. */
  function fixtureRepo(dir: string, packVersion: string): string {
    const repo = join(tmp, dir);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" });
    mkdirSync(join(repo, "skills", "gameye", "references"), { recursive: true });
    mkdirSync(join(repo, "skills", "gameye-containerize"), { recursive: true });
    writeFileSync(join(repo, "skills", "gameye", "SKILL.md"), skill("gameye", `\nPack version: ${packVersion}\n`));
    writeFileSync(join(repo, "skills", "gameye", "references", "routing.md"), "# Routing\n");
    writeFileSync(join(repo, "skills", "gameye-containerize", "SKILL.md"), skill("gameye-containerize", "\n## The container contract\n\n1. **Run as non-root.**\n"));
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "fixture");
    git("tag", BUNDLED_SKILLS_TAG);
    return repo;
  }

  function sync(source: string, out: string, check = false) {
    const args = [syncScript, source, `--out=${out}`, ...(check ? ["--check"] : [])];
    return spawnSync(process.execPath, args, { encoding: "utf8" });
  }

  it("refuses a tag whose Pack version disagrees, and writes nothing", () => {
    const repo = fixtureRepo("mismatch", "0.0.1");
    const out = join(tmp, "mismatch.ts");
    const res = sync(repo, out);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("Pack version 0.0.1");
    expect(existsSync(out)).toBe(false);
  });

  it("--check exits 0 when clean and 1 on drift", () => {
    const repo = fixtureRepo("clean", BUNDLED_SKILLS_PACK_VERSION);
    const out = join(tmp, "clean.ts");
    expect(sync(repo, out).status).toBe(0);
    const written = readFileSync(out, "utf8");
    expect(written).toContain(`// Pack version: ${BUNDLED_SKILLS_PACK_VERSION}`);

    expect(sync(repo, out, true).status).toBe(0);

    writeFileSync(out, written.replace("# Routing", "# Routing, edited"));
    const drift = sync(repo, out, true);
    expect(drift.status).toBe(1);
    expect(drift.stderr).toContain("DRIFT");
    expect(readFileSync(out, "utf8")).not.toBe(written);

    writeFileSync(out, written.replace(/^\/\/ Source commit: [0-9a-f]{40}$/m, `// Source commit: ${"0".repeat(40)}`));
    const moved = sync(repo, out, true);
    expect(moved.status).toBe(1);
    expect(moved.stderr).toContain("source commit");
  });
});
