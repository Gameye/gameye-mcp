import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { CANNOT_KNOW, DOCKERFILE_RULES, checkDockerfile, formatDockerfileReport, type DeclaredPort } from "../../src/dockerfile-check.js";
import { registerDockerfileCheckTool } from "../../src/tools/dockerfile-check.js";
import { GuardError } from "../../src/guards.js";
import { getText, makeContext, makeMockServer, NO_TOKEN_SANDBOX_PREFIX, SANDBOX_PREFIX } from "./helpers.js";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/dockerfiles/${name}.Dockerfile`, import.meta.url), "utf8");

const codes = (text: string, ports?: DeclaredPort[]) =>
  checkDockerfile(text, { ports }).findings.map((f) => f.code);

const AE5_TOKEN = "gy_fake_dockerfile_token_9f8e7d6c5b4a";

function registerTool(overrides: Parameters<typeof makeContext>[0] = {}) {
  const { server, handlers, configs } = makeMockServer();
  registerDockerfileCheckTool(server, makeContext(overrides));
  return { handler: handlers.gameye_check_dockerfile, config: configs.gameye_check_dockerfile };
}

afterEach(() => vi.restoreAllMocks());

describe("rule list", () => {
  it("cites a container-contract number and keyword for every rule, with codes named after the number", () => {
    expect(DOCKERFILE_RULES.length).toBeGreaterThan(0);
    for (const rule of DOCKERFILE_RULES) {
      expect(rule.code.startsWith(`GC${rule.contractNumber}-`)).toBe(true);
      expect(rule.keyword.length).toBeGreaterThan(0);
    }
    expect(new Set(DOCKERFILE_RULES.map((r) => r.code)).size).toBe(DOCKERFILE_RULES.length);
  });
});

describe("golden Dockerfiles published in gameye-skills", () => {
  it.each(["golden-unreal", "golden-unity", "golden-godot", "golden-godot-1.7.0", "golden-web", "golden-containerize-multistage"])(
    "%s produces no findings",
    (name) => {
      expect(checkDockerfile(fixture(name)).findings).toEqual([]);
    }
  );

  it("passes when declared ports match EXPOSE", () => {
    expect(codes(fixture("golden-unity"), [{ port: 7777, protocol: "udp" }])).toEqual([]);
    expect(codes(fixture("golden-web"), [{ port: 8080, protocol: "tcp" }])).toEqual([]);
  });
});

describe("AE5: shell-form ENTRYPOINT plus a token in ENV", () => {
  it("produces exactly the exec-form and token findings with lines, fixes and the value masked", () => {
    const { findings } = checkDockerfile(fixture("ae5-shell-entrypoint-token"));
    expect(findings.map((f) => [f.code, f.line, f.severity])).toEqual([
      ["GC9-token-in-image", 5, "error"],
      ["GC4-exec-form", 8, "error"],
    ]);
    for (const f of findings) expect(f.fix.length).toBeGreaterThan(0);
    const token = findings[0];
    expect(token.message).toContain("GAMEYE_API_TOKEN=***");
    expect(JSON.stringify(findings)).not.toContain(AE5_TOKEN);
  });

  it("never shows the submitted value with no token configured", async () => {
    const { handler } = registerTool({ hasToken: false, mask: (t: string) => t });
    const result = await handler({ dockerfile: fixture("ae5-shell-entrypoint-token") });
    const text = getText(result);
    expect(result.isError).toBeFalsy();
    expect(text.startsWith(NO_TOKEN_SANDBOX_PREFIX)).toBe(true);
    expect(text).toContain("GC9-token-in-image");
    expect(text).toContain("GC4-exec-form");
    expect(text).toContain("***");
    expect(text).not.toContain(AE5_TOKEN);
  });

  it("never shows the submitted value when a different token is configured", async () => {
    const { handler } = registerTool();
    const text = getText(await handler({ dockerfile: fixture("ae5-shell-entrypoint-token") }));
    expect(text.startsWith(SANDBOX_PREFIX)).toBe(true);
    expect(text).toContain("GAMEYE_API_TOKEN=***");
    expect(text).not.toContain(AE5_TOKEN);
  });

  it("redacts the value wherever else it appears in the Dockerfile", () => {
    const text = [
      "FROM debian:bookworm-slim",
      "ARG GAMEYE_API_TOKEN=gy_other_value_1234567890",
      "USER game",
      "EXPOSE 7777/udp",
      "CMD /server/game-server --token gy_other_value_1234567890",
    ].join("\n");
    const report = formatDockerfileReport(checkDockerfile(text));
    expect(report).toContain("GC9-token-in-image");
    expect(report).not.toContain("gy_other_value_1234567890");
  });
});

describe("seeded contract breaks each produce exactly their code", () => {
  it.each([
    ["arm64-platform", "GC1-arm64-platform"],
    ["windows-base", "GC1-windows-base"],
    ["no-expose", "GC2-expose-missing"],
    ["root-user", "GC7-non-root"],
    ["loopback-bind", "GC2-loopback-bind"],
    ["npm-start", "GC4-npm-start"],
  ])("%s -> %s", (name, code) => {
    expect(codes(fixture(name))).toEqual([code]);
  });

  it("flags a protocol mismatch with declared ports", () => {
    expect(codes(fixture("golden-unity"), [{ port: 7777, protocol: "tcp" }])).toEqual(["GC2-port-mismatch"]);
  });

  it("flags a declared port that is not exposed", () => {
    const found = codes(fixture("golden-unity"), [
      { port: 7777, protocol: "udp" },
      { port: 7778, protocol: "udp" },
    ]);
    expect(found).toEqual(["GC2-port-mismatch"]);
  });

  it("flags a missing USER (the image defaults to root)", () => {
    const text = ["FROM debian:bookworm-slim", "EXPOSE 7777/udp", 'ENTRYPOINT ["/server/game"]'].join("\n");
    const { findings } = checkDockerfile(text);
    expect(findings.map((f) => [f.code, f.line])).toEqual([["GC7-non-root", 1]]);
  });

  it("flags yarn start and npm run start", () => {
    const base = ["FROM node:22-slim", "USER node", "EXPOSE 8080/tcp"];
    expect(codes([...base, 'ENTRYPOINT ["yarn", "start"]'].join("\n"))).toEqual(["GC4-npm-start"]);
    expect(codes([...base, 'CMD ["npm", "run", "start"]'].join("\n"))).toEqual(["GC4-npm-start"]);
  });

  it("flags localhost in the launch command", () => {
    const text = ["FROM node:22-slim", "USER node", "EXPOSE 8080/tcp", 'CMD ["node", "server.js", "--host", "localhost"]'];
    expect(codes(text.join("\n"))).toEqual(["GC2-loopback-bind"]);
  });
});

describe("parsing", () => {
  it("handles line continuations, comments, heredocs and a root build stage without false positives", () => {
    expect(
      codes(fixture("continuations-multistage"), [
        { port: 7777, protocol: "udp" },
        { port: 7778, protocol: "udp" },
      ])
    ).toEqual([]);
  });

  it("follows a final stage built FROM an earlier stage", () => {
    const text = [
      "FROM debian:bookworm-slim AS base",
      "USER game",
      "EXPOSE 7777/udp",
      "FROM base",
      'ENTRYPOINT ["/server/game"]',
    ].join("\n");
    expect(codes(text)).toEqual([]);
  });

  it("reports the line where a continued instruction starts", () => {
    const text = [
      "FROM debian:bookworm-slim",
      "USER game",
      "EXPOSE 7777/udp",
      "ENTRYPOINT /server/game \\",
      "  --port 7777",
    ].join("\n");
    expect(checkDockerfile(text).findings.map((f) => [f.code, f.line])).toEqual([["GC4-exec-form", 4]]);
  });

  it.each(["", "   \n\t\n", "# only a comment\n"])("refuses empty input %j with a clear error", (text) => {
    expect(() => checkDockerfile(text)).toThrow(GuardError);
    expect(() => checkDockerfile(text)).toThrow(/no Dockerfile instructions/i);
  });
});

describe("report text", () => {
  it.each(["golden-unity", "ae5-shell-entrypoint-token"])("%s always states what the check cannot know", (name) => {
    const report = formatDockerfileReport(checkDockerfile(fixture(name)));
    expect(report).toContain(CANNOT_KNOW);
    expect(report.toLowerCase()).not.toContain("will run on gameye");
  });

  it("names the registry, Admin Panel port bindings and whether the binary starts", () => {
    expect(CANNOT_KNOW).toMatch(/registry/i);
    expect(CANNOT_KNOW).toMatch(/Admin Panel/);
    expect(CANNOT_KNOW).toMatch(/starts/);
  });

  it("names gameye-containerize in every fix", () => {
    const all = ["arm64-platform", "windows-base", "no-expose", "root-user", "loopback-bind", "npm-start", "ae5-shell-entrypoint-token"]
      .flatMap((n) => checkDockerfile(fixture(n)).findings);
    for (const f of all) expect(f.fix).toContain("gameye-containerize");
  });
});

describe("gameye_check_dockerfile tool", () => {
  it("does not need a token and is read-only and closed-world", async () => {
    const { handler, config } = registerTool({ hasToken: false, mask: (t: string) => t });
    expect(config.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    const result = await handler({ dockerfile: fixture("golden-godot") });
    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain("No contract issues found");
  });

  it("makes no network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { handler } = registerTool({ hasToken: false, mask: (t: string) => t });
    await handler({ dockerfile: fixture("ae5-shell-entrypoint-token"), ports: [{ port: 7777, protocol: "udp" }] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns an error result for empty input", async () => {
    const { handler } = registerTool({ hasToken: false, mask: (t: string) => t });
    const result = await handler({ dockerfile: "  \n" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/no Dockerfile instructions/i);
  });
});

describe("rule citations match the bundled container contract", () => {
  it("every rule's cited contract number exists in the pinned skill and contains its keyword", async () => {
    const { DOCKERFILE_RULES } = await import("../../src/dockerfile-check.js");
    const { CONTAINER_CONTRACT } = await import("../../src/generated/skills.js");
    for (const rule of DOCKERFILE_RULES) {
      const item = CONTAINER_CONTRACT.find((c) => c.number === rule.contractNumber);
      expect(item, `${rule.code} cites contract rule ${rule.contractNumber}`).toBeDefined();
      expect(item!.text, `${rule.code} keyword`).toContain(rule.keyword);
    }
  });
});
