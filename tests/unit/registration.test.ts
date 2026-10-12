import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer } from "../../src/server.js";
import { BETA_NOTICE } from "../../src/beta.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GameyeClient } from "../../src/client.js";
import { registerAllTools } from "../../src/tools/register.js";
import { makeContext, TEST_TOKEN } from "./helpers.js";

async function connect() {
  const server = createServer("0.0.0-test");
  const ctx = makeContext();
  const gameye = new GameyeClient({ token: "t", baseUrl: ctx.baseUrl });
  registerAllTools(server, gameye, ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

afterEach(() => vi.unstubAllGlobals());

describe("registration through the real MCP SDK", () => {
  it("tells connecting clients the server is in beta", async () => {
    const client = await connect();
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain(BETA_NOTICE);
    expect(instructions).toMatch(/beta/i);
    expect(client.getServerVersion()?.name).toBe("gameye");
  });

  it("exposes every tool with annotations and openWorldHint set", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "gameye_check_tag",
      "gameye_context",
      "gameye_create_application",
      "gameye_create_token",
      "gameye_describe_session",
      "gameye_edit_application",
      "gameye_enable_tag",
      "gameye_get_artifacts",
      "gameye_get_locations",
      "gameye_get_logs",
      "gameye_launch_session",
      "gameye_list_applications",
      "gameye_list_regions",
      "gameye_list_registry_tags",
      "gameye_list_sessions",
      "gameye_player_join",
      "gameye_player_leave",
      "gameye_stop_session",
      "gameye_update_skills",
    ]);
    for (const t of tools) {
      expect(t.annotations, t.name).toBeDefined();
      expect(typeof t.annotations?.readOnlyHint, t.name).toBe("boolean");
      expect(typeof t.annotations?.openWorldHint, t.name).toBe("boolean");
      expect(t.title, t.name).toBeTruthy();
    }
    const stop = tools.find((t) => t.name === "gameye_stop_session");
    expect(stop?.annotations?.destructiveHint).toBe(true);
  });

  it("registers the application and token tools without any opt-in", async () => {
    const { tools } = await (await connect()).listTools();
    for (const name of ["gameye_create_application", "gameye_create_token", "gameye_edit_application"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations?.readOnlyHint, name).toBe(false);
      expect(tool?.annotations?.openWorldHint, name).toBe(true);
    }
  });

  it("calls a tool end to end and prefixes the result", async () => {
    const client = await connect();
    const res = await client.callTool({ name: "gameye_context", arguments: {} });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(text.split("\n")[0]).toBe("[sandbox · api.sandbox-gameye.gameye.net]");
  });

  it("rejects an empty players array before any request is sent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({ name: "gameye_player_join", arguments: { session: "s1", players: [] } });
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns isError for an API 403 through the SDK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ statusCode: 403, code: "forbidden", message: "Forbidden request.", details: "Token is missing required scope 'session:write'. Assigned scopes: []", identifier: "tr-x" }),
          { status: 403 }
        )
      )
    );
    const client = await connect();
    const res = await client.callTool({ name: "gameye_stop_session", arguments: { id: "s1" } });
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(res.isError).toBe(true);
    expect(text).toContain("Required scope: session:write");
    expect(text).toContain("Trace ID: tr-x");
  });
});

describe("token masking on every tool result", () => {
  async function connectWithToken() {
    const server = createServer("0.0.0-test");
    const gameye = new GameyeClient({ token: TEST_TOKEN, baseUrl: makeContext().baseUrl });
    // Wired as in src/index.ts: the context gets a mask function, never the token.
    const ctx = makeContext({ mask: (text: string) => gameye.maskToken(text) });
    registerAllTools(server, gameye, ctx);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      return { text: (res.content as Array<{ text: string }>)[0].text, isError: res.isError };
    };
  }

  it("masks the token in log output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(`booting\nAPI_KEY=${TEST_TOKEN}\nready`, { status: 200 })));
    const { text, isError } = await (await connectWithToken())("gameye_get_logs", { id: "s1" });
    expect(isError).toBeFalsy();
    expect(text).not.toContain(TEST_TOKEN);
    expect(text).toContain("API_KEY=***");
  });

  it("masks the token in a described session label", async () => {
    const session = {
      id: "s1",
      image: "img",
      location: "eu",
      created: 0,
      status: "running",
      port: {},
      labels: { note: `key-${TEST_TOKEN}-end` },
      players: { joined: [], joinedCount: 0 },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(session), { status: 200 })));
    const { text } = await (await connectWithToken())("gameye_describe_session", { id: "s1" });
    expect(text).not.toContain(TEST_TOKEN);
    expect(text).toContain("note: key-***-end");
  });

  it("masks the token in a thrown non-API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error(`connect failed (auth ${TEST_TOKEN})`)));
    const { text, isError } = await (await connectWithToken())("gameye_list_regions", {});
    expect(isError).toBe(true);
    expect(text).not.toContain(TEST_TOKEN);
    expect(text).toContain("connect failed (auth ***)");
  });
});
