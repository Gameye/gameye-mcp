// manifest.json builds the MCPB bundle that Smithery and Claude Desktop install.
// It must ship the same version and tools as the npm package.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GameyeClient } from "../../src/client.js";
import { registerAllTools } from "../../src/tools/register.js";
import { makeContext, makeMockServer } from "./helpers.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));

describe("manifest.json", () => {
  it("has the package version and entry point", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.server.entry_point).toBe(pkg.bin["gameye-mcp"]);
    expect(manifest.compatibility.runtimes.node).toBe(">=22.0.0");
  });

  it("lists exactly the registered tools", () => {
    const mock = makeMockServer();
    const ctx = makeContext();
    registerAllTools(mock.server, new GameyeClient({ token: "t", baseUrl: ctx.baseUrl }), ctx);
    const listed = manifest.tools.map((t: { name: string }) => t.name).sort();
    expect(listed).toEqual(Object.keys(mock.handlers).sort());
  });

  it("passes the token and environment through user config", () => {
    expect(manifest.server.mcp_config.env).toEqual({
      GAMEYE_API_TOKEN: "${user_config.api_token}",
      GAMEYE_ENV: "${user_config.environment}",
    });
    expect(manifest.user_config.api_token.sensitive).toBe(true);
    expect(manifest.user_config.environment.default).toBe("sandbox");
  });
});
