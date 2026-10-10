// package.json fields that npm provenance, the MCP Registry and installs
// depend on. npm compares the repository URL case-sensitively with the GitHub
// repo that publishes, so the owner must be spelled Gameye.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

describe("package.json", () => {
  it("points repository, homepage and bugs at github.com/Gameye/gameye-mcp", () => {
    expect(pkg.repository.url).toBe("git+https://github.com/Gameye/gameye-mcp.git");
    expect(pkg.homepage).toBe("https://github.com/Gameye/gameye-mcp#readme");
    expect(pkg.bugs.url).toBe("https://github.com/Gameye/gameye-mcp/issues");
  });

  it("requires a supported Node version", () => {
    expect(pkg.engines.node).toBe(">=22");
  });

  it("names the server for the MCP Registry", () => {
    expect(pkg.mcpName).toBe("io.github.gameye/gameye-mcp");
  });

  it("ships the bin entry inside the files allowlist", () => {
    expect(pkg.bin["gameye-mcp"]).toBe("dist/index.js");
    expect(pkg.files).toContain("dist/**/*.js");
  });
});
