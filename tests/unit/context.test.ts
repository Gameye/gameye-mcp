import { describe, it, expect } from "vitest";
import { registerContextTool } from "../../src/tools/context.js";
import { makeMockServer, makeContext, getText } from "./helpers.js";
import { BETA_NOTICE } from "../../src/beta.js";

async function contextText(admin: boolean): Promise<string> {
  const mock = makeMockServer();
  registerContextTool(mock.server, makeContext(), { admin });
  return getText(await mock.handlers["gameye_context"]({}));
}

describe("gameye_context", () => {
  it("reports environment, host, version and the scope note, read-only", async () => {
    const mock = makeMockServer();
    registerContextTool(mock.server, makeContext({ version: "1.2.3" }), { admin: false });
    const result = await mock.handlers["gameye_context"]({});
    const text = getText(result);
    expect(text.split("\n")[0]).toBe("[sandbox · api.sandbox-gameye.gameye.net]");
    expect(text.split("\n")[1]).toBe(BETA_NOTICE);
    expect(text).toContain("Environment:    sandbox");
    expect(text).toContain("Host:           api.sandbox-gameye.gameye.net");
    expect(text).toContain("gameye-mcp 1.2.3");
    expect(text).toMatch(/scopes: not introspectable/i);
    expect(mock.configs["gameye_context"].annotations).toMatchObject({ readOnlyHint: true });
  });

  it("labels a custom URL", async () => {
    const mock = makeMockServer();
    registerContextTool(mock.server, makeContext({ environment: "custom", host: "gw.example.test", baseUrl: "https://gw.example.test" }), { admin: false });
    const text = getText(await mock.handlers["gameye_context"]({}));
    expect(text.split("\n")[0]).toBe("[custom · gw.example.test]");
    expect(text).toContain("non-standard GAMEYE_API_URL");
  });

  it("production prefix", async () => {
    const mock = makeMockServer();
    registerContextTool(mock.server, makeContext({ environment: "production", host: "api.production-gameye.gameye.net" }), { admin: false });
    const text = getText(await mock.handlers["gameye_context"]({}));
    expect(text.split("\n")[0]).toBe("[production · api.production-gameye.gameye.net]");
  });

  it("says admin tools are disabled and how to enable them", async () => {
    expect(await contextText(false)).toContain("Admin tools:    disabled (set GAMEYE_ENABLE_ADMIN_TOOLS=1 to enable)");
  });

  it("says admin tools are enabled", async () => {
    const text = await contextText(true);
    expect(text).toMatch(/^Admin tools:    enabled$/m);
    expect(text).not.toContain("set GAMEYE_ENABLE_ADMIN_TOOLS=1");
  });

  it("reports the guardrail defaults", async () => {
    const text = await contextText(false);
    expect(text).toContain("Guardrail defaults:");
    expect(text).toMatch(/Session TTL:\s+30m when a launch gives no ttl/);
    expect(text).toMatch(/Session label:\s+launched-by=gameye-mcp on every launch/);
    expect(text).toMatch(/Token expiry:\s+24h when gameye_create_token gives no expires_after/);
  });
});
