// gameye_get_template serves each engine's Dockerfile and shutdown hook from
// the pinned skills bundle, word for word, offline and without a token (R10, R12).

import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { registerTemplateTools } from "../../src/tools/templates.js";
import { BUNDLED_PACK_LINE } from "../../src/tools/bundled-skills.js";
import { BUNDLED_SKILLS, BUNDLED_TEMPLATES } from "../../src/generated/skills.js";
import { getText, makeContext, makeMockServer, NO_TOKEN_SANDBOX_PREFIX } from "./helpers.js";

const ENGINES = ["unreal", "unity", "godot", "web"] as const;
const KINDS = ["dockerfile", "shutdown-hook"] as const;
const PAIRS = ENGINES.flatMap((engine) => KINDS.map((kind) => [engine, kind] as const));

function tool(hasToken = false) {
  const mock = makeMockServer();
  registerTemplateTools(mock.server, makeContext({ hasToken }));
  return {
    get: (args: Record<string, unknown>) => mock.handlers["gameye_get_template"](args),
    config: mock.configs["gameye_get_template"],
  };
}

/**
 * The fenced block between `<!-- gameye-template: engine/kind -->` and its
 * closing marker in the skill's SKILL.md, fence lines included, found here
 * independently of the bundler.
 */
function publishedBlock(engine: string, kind: string): { skill: string; block: string } {
  const skill = `gameye-${engine}-server`;
  const text = BUNDLED_SKILLS.find((s) => s.name === skill)!.files["SKILL.md"];
  const open = `<!-- gameye-template: ${engine}/${kind} -->\n`;
  const start = text.indexOf(open);
  expect(start, `${skill} marks ${engine}/${kind}`).toBeGreaterThanOrEqual(0);
  const inner = text.slice(start + open.length, text.indexOf("<!-- /gameye-template -->", start));
  const fenceStart = inner.search(/^```/m);
  const fenceEnd = inner.indexOf("\n```", fenceStart + 3) + "\n```\n".length;
  return { skill, block: inner.slice(fenceStart, fenceEnd) };
}

describe("gameye_get_template", () => {
  it.each(PAIRS)("AE4: %s/%s matches the marked block in the pinned skill byte for byte and names the skill", async (engine, kind) => {
    const { skill, block } = publishedBlock(engine, kind);
    const res = await tool().get({ engine, kind });
    expect(res.isError).toBeFalsy();
    const text = getText(res);
    expect(text).toContain(`\n${block}`);
    expect(text).toContain(skill);
    expect(text).toContain(`gameye_get_skill`);
  });

  it("opens with the bundled pack line and names the section", async () => {
    const text = getText(await tool().get({ engine: "unreal", kind: "dockerfile" }));
    expect(text.split("\n")[1]).toBe(BUNDLED_PACK_LINE);
    expect(text).toContain("gameye-unreal-server");
    expect(text).toContain("Container specifics");
  });

  it("bundles every engine and kind exactly once", () => {
    expect(BUNDLED_TEMPLATES.map((t) => `${t.engine}/${t.kind}`).sort()).toEqual(PAIRS.map(([e, k]) => `${e}/${k}`).sort());
  });

  it("serves the Godot note: the version it was tested on and the advice to rerun the drain test", async () => {
    const godot = BUNDLED_TEMPLATES.find((t) => t.engine === "godot" && t.kind === "shutdown-hook")!;
    expect(godot.note).toMatch(/Godot 4\.\d+\.\d+/);
    const text = getText(await tool().get({ engine: "godot", kind: "shutdown-hook" }));
    expect(text).toContain(godot.note);
    expect(text).toMatch(/Godot 4\.\d+\.\d+/);
    expect(text).toContain("drain test");
  });

  it("serves a template with no note without a note line", async () => {
    const text = getText(await tool().get({ engine: "web", kind: "dockerfile" }));
    expect(text).not.toMatch(/^Note:/m);
  });

  it("takes only a required engine and kind, rejecting unknown values with the allowed ones", () => {
    const { config } = tool();
    expect(Object.keys(config.inputSchema ?? {}).sort()).toEqual(["engine", "kind"]);
    const schema = z.object(config.inputSchema as z.ZodRawShape).strict();
    expect(schema.safeParse({ engine: "godot", kind: "dockerfile" }).success).toBe(true);
    expect(schema.safeParse({ engine: "godot" }).success).toBe(false);
    expect(schema.safeParse({ kind: "dockerfile" }).success).toBe(false);
    expect(schema.safeParse({ engine: "godot", kind: "dockerfile", version: "4.3" }).success).toBe(false);

    const badEngine = schema.safeParse({ engine: "cryengine", kind: "dockerfile" });
    expect(badEngine.success).toBe(false);
    const engineMessage = JSON.stringify(badEngine.error?.issues);
    for (const e of ENGINES) expect(engineMessage).toContain(e);

    const badKind = schema.safeParse({ engine: "godot", kind: "compose" });
    expect(badKind.success).toBe(false);
    const kindMessage = JSON.stringify(badKind.error?.issues);
    for (const k of KINDS) expect(kindMessage).toContain(k);
  });

  it("works with no token and makes no network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { get } = tool(false);
      for (const [engine, kind] of PAIRS) {
        const res = await get({ engine, kind });
        expect(res.isError, `${engine}/${kind}`).toBeFalsy();
        expect(getText(res).split("\n")[0]).toBe(NO_TOKEN_SANDBOX_PREFIX);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is read-only, closed-world and needs no token", () => {
    const { config } = tool();
    expect(config.annotations?.readOnlyHint).toBe(true);
    expect(config.annotations?.openWorldHint).toBe(false);
    expect(config.annotations?.destructiveHint).toBe(false);
  });
});
