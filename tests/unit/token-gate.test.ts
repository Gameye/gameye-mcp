// The token gate: with no GAMEYE_API_TOKEN, every account tool refuses before
// its handler runs, sends nothing, and says how to set a token. Only the
// explicit token-free allowlist works.

import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { GameyeClient } from "../../src/client.js";
import { registerAllTools } from "../../src/tools/register.js";
import { registerSessionTools } from "../../src/tools/sessions.js";
import { registerTokenTools } from "../../src/tools/tokens.js";
import { registerSkillsTools } from "../../src/tools/skills.js";
import { registerContextTool } from "../../src/tools/context.js";
import { defineTool } from "../../src/tools/common.js";
import { LATEST_PACK_URL, type SkillsEnv } from "../../src/skills.js";
import { SCOPE_RECIPES, TOKEN_FREE_TOOLS, TOKEN_REQUIRED_MARKER, TOOL_SCOPE_RECIPE } from "../../src/tokenless.js";
import {
  getText,
  makeContext,
  makeMockClient,
  makeMockServer,
  NO_TOKEN_SANDBOX_PREFIX,
  SANDBOX_PREFIX,
  TEST_TOKEN,
} from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const noTokenContext = () => makeContext({ hasToken: false, mask: (t: string) => t });

/** Minimal valid arguments for every account tool, so input validation passes and the gate is what answers. */
const VALID_ARGS: Record<string, Record<string, unknown>> = {
  gameye_launch_session: { location: "eu", image: "img" },
  gameye_list_sessions: {},
  gameye_describe_session: { id: "s1" },
  gameye_stop_session: { id: "s1" },
  gameye_player_join: { session: "s1", players: ["p1"] },
  gameye_player_leave: { session: "s1", players: ["p1"] },
  gameye_get_locations: { image: "img" },
  gameye_list_regions: {},
  gameye_check_tag: { region: "eu", image: "img", version: "1" },
  gameye_list_applications: {},
  gameye_list_registry_tags: { name: "app" },
  gameye_enable_tag: { name: "app", tag: "1" },
  gameye_create_application: {
    name: "app",
    registry: "dockerhub",
    repository: "org/app",
    tagKeep: 3,
    networkMode: "bridge",
    limits: { cpu: 1, ram: 512 },
    reservation: { cpu: 1, ram: 512 },
    nodePool: "default",
    regions: ["eu"],
    ports: [{ requested: 7777, protocol: "udp", tls: false }],
  },
  gameye_edit_application: { name: "app" },
  gameye_get_logs: { id: "s1" },
  gameye_get_artifacts: { session: "s1", path: "/tmp/x" },
  gameye_create_token: { name: "t", scopes: ["session:read"], outputPath: "/nonexistent-gameye-dir/token" },
};

async function connect(hasToken: boolean) {
  const server = createServer("0.0.0-test");
  const gameye = new GameyeClient({ token: hasToken ? TEST_TOKEN : "", baseUrl: makeContext().baseUrl });
  const ctx = makeContext({ hasToken, mask: (text: string) => gameye.maskToken(text) });
  registerAllTools(server, gameye, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function callText(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  return { text: (res.content as Array<{ text: string }>)[0].text, isError: res.isError };
}

describe("token gate with no token (AE1)", () => {
  it("refuses every account tool with the marker and sends no request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect(false);
    const { tools } = await client.listTools();
    const accountTools = tools.map((t) => t.name).filter((n) => !TOKEN_FREE_TOOLS.includes(n));

    // Every account tool has arguments here, so a new tool cannot slip past this test.
    expect(accountTools.sort()).toEqual(Object.keys(VALID_ARGS).sort());

    for (const name of accountTools) {
      for (const args of [VALID_ARGS[name], { ...VALID_ARGS[name], dryRun: true }]) {
        const { text, isError } = await callText(client, name, args);
        const lines = text.split("\n");
        expect(isError, name).toBe(true);
        expect(lines[0], name).toBe(NO_TOKEN_SANDBOX_PREFIX);
        expect(lines[1], name).toBe(TOKEN_REQUIRED_MARKER);
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gameye_list_regions: prefix, marker, Observer recipe, nothing sent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { text, isError } = await callText(await connect(false), "gameye_list_regions", {});
    expect(isError).toBe(true);
    expect(text.split("\n")[0]).toBe("[sandbox · api.sandbox-gameye.gameye.net · no token]");
    expect(text.split("\n")[1]).toBe(TOKEN_REQUIRED_MARKER);
    expect(text).toMatch(/Observer/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gameye_context still works and shows the no-token prefix", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { text, isError } = await callText(await connect(false), "gameye_context", {});
    expect(isError).toBeFalsy();
    expect(text.split("\n")[0]).toBe(NO_TOKEN_SANDBOX_PREFIX);
    expect(text).not.toContain(TOKEN_REQUIRED_MARKER);
  });

  it("gameye_update_skills is not gated", async () => {
    const env: SkillsEnv = {
      home: "/u/tester",
      cwd: "/work",
      platform: "linux",
      applyEnabled: false,
      readText: async () => undefined,
      fetchText: async (url) => {
        expect(url).toBe(LATEST_PACK_URL);
        return "---\nname: gameye\n---\n\nPack version: 1.6.1\n";
      },
      run: async () => "",
    };
    const mock = makeMockServer();
    registerSkillsTools(mock.server, noTokenContext(), env);
    const res = await mock.handlers["gameye_update_skills"]({});
    expect(res.isError).toBeFalsy();
    expect(getText(res)).not.toContain(TOKEN_REQUIRED_MARKER);
    expect(getText(res)).toContain("Latest Gameye skills pack: 1.6.1");
  });
});

describe("dryRun is refused the same way (AE3)", () => {
  it("launch, stop and create_token with dryRun never reach the client or the limiter", async () => {
    const client = makeMockClient("");
    const mock = makeMockServer();
    const ctx = noTokenContext();
    registerSessionTools(mock.server, client as never, ctx);
    registerTokenTools(mock.server, client as never, ctx);

    for (const name of ["gameye_launch_session", "gameye_stop_session", "gameye_create_token"]) {
      const res = await mock.handlers[name]({ ...VALID_ARGS[name], dryRun: true });
      expect(res.isError, name).toBe(true);
      expect(getText(res).split("\n")[1], name).toBe(TOKEN_REQUIRED_MARKER);
      expect(getText(res), name).not.toMatch(/Dry run/);
    }
    expect(client.listSessions).not.toHaveBeenCalled();
    expect(client.launchSession).not.toHaveBeenCalled();
    expect(client.stopSession).not.toHaveBeenCalled();
    expect(client.createToken).not.toHaveBeenCalled();
  });
});

describe("refusal text (R6)", () => {
  async function refusal(name: string): Promise<string> {
    vi.stubGlobal("fetch", vi.fn());
    return (await callText(await connect(false), name, VALID_ARGS[name])).text;
  }

  it.each([
    ["gameye_list_regions", "Observer"],
    ["gameye_launch_session", "Operator"],
    ["gameye_create_token", "Token admin"],
  ])("%s names the %s recipe", async (name, recipe) => {
    const text = await refusal(name);
    expect(text).toContain(`Narrowest token scopes for ${name}: ${recipe}`);
    const { scopes } = SCOPE_RECIPES.find((r) => r.name === recipe)!;
    for (const scope of scopes) expect(text, scope).toContain(scope);
  });

  it("gives the steps in R6 order, with no token value", async () => {
    const text = await refusal("gameye_launch_session");
    const order = [
      TOKEN_REQUIRED_MARKER,
      "Nothing was sent to the Gameye API",
      "retrying",
      "trial.gameye.com",
      "Users → API tokens",
      "Narrowest token scopes",
      "Claude Code plugin",
      "claude mcp add",
      "mcpServers",
      "Docker",
      "restart",
      "Do not paste the token into this chat",
      "Works now without a token: gameye_context, gameye_update_skills",
    ];
    let at = -1;
    for (const needle of order) {
      const next = text.indexOf(needle, at + 1);
      expect(next, `"${needle}" after position ${at}`).toBeGreaterThan(at);
      at = next;
    }
    expect(text).toMatch(/sandbox/);
    expect(text).not.toMatch(/GAMEYE_API_TOKEN=\S/);
    expect(text).not.toContain("admin.gameye.com");
  });

  it("every account tool has a scope recipe in the one table", () => {
    for (const name of Object.keys(VALID_ARGS)) expect(TOOL_SCOPE_RECIPE[name], name).toBeDefined();
    for (const name of TOKEN_FREE_TOOLS) expect(TOOL_SCOPE_RECIPE[name], name).toBeUndefined();
  });
});

describe("fail closed", () => {
  it("a tool defined without requiresToken is gated", async () => {
    const mock = makeMockServer();
    const handler = vi.fn().mockResolvedValue("ran");
    defineTool(
      mock.server,
      noTokenContext(),
      "gameye_future_tool",
      { title: "Future", description: "d", inputSchema: { x: z.string().optional() }, annotations: { readOnlyHint: true, openWorldHint: true } },
      handler
    );
    const res = await mock.handlers["gameye_future_tool"]({});
    expect(res.isError).toBe(true);
    expect(getText(res).split("\n")[1]).toBe(TOKEN_REQUIRED_MARKER);
    expect(getText(res)).toMatch(/Token scopes/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("requiresToken: false lets the handler run without a token", async () => {
    const mock = makeMockServer();
    const handler = vi.fn().mockResolvedValue("ran");
    defineTool(
      mock.server,
      noTokenContext(),
      "gameye_offline_tool",
      { title: "Offline", description: "d", inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false }, requiresToken: false },
      handler
    );
    const res = await mock.handlers["gameye_offline_tool"]({});
    expect(res.isError).toBeFalsy();
    expect(getText(res)).toBe(`${NO_TOKEN_SANDBOX_PREFIX}\nran`);
  });
});

describe("with a token set (R3, R7)", () => {
  it("runs account tools and never shows the no-token prefix or marker", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ regions: ["eu"] }), { status: 200 })));
    const { text, isError } = await callText(await connect(true), "gameye_list_regions", {});
    expect(isError).toBeFalsy();
    expect(text.split("\n")[0]).toBe(SANDBOX_PREFIX);
    expect(text).not.toContain(TOKEN_REQUIRED_MARKER);
  });

  it("gameye_context says configured and leaks no value, length or suffix", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { text } = await callText(await connect(true), "gameye_context", {});
    expect(text).toContain("Token: configured");
    expect(text).not.toContain("not configured");
    expect(text).not.toContain(TEST_TOKEN);
    expect(text).not.toContain(TEST_TOKEN.slice(-4));
    expect(text).not.toContain(TEST_TOKEN.slice(0, 8));
    expect(text).not.toMatch(new RegExp(`\\b${TEST_TOKEN.length}\\b`));
  });

  it("gameye_context with no token says not configured", async () => {
    const mock = makeMockServer();
    registerContextTool(mock.server, noTokenContext());
    const text = getText(await mock.handlers["gameye_context"]({}));
    expect(text).toContain("Token: not configured");
  });
});
