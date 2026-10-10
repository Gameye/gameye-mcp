// package.json fields that npm provenance, the MCP Registry and installs
// depend on. npm compares the repository URL case-sensitively with the GitHub
// repo that publishes, so the owner must be spelled Gameye.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const server = JSON.parse(readFileSync(new URL("../../server.json", import.meta.url), "utf8"));

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
    expect(pkg.mcpName).toBe("io.github.Gameye/gameye-mcp");
  });

  it("ships the bin entry inside the files allowlist", () => {
    expect(pkg.bin["gameye-mcp"]).toBe("dist/index.js");
    expect(pkg.files).toContain("dist/**/*.js");
  });

  it("matches server.json, which the MCP Registry publishes", () => {
    // The registry checks mcpName (npm) and the image label against this name.
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    const npm = server.packages.find((p: { registryType: string }) => p.registryType === "npm");
    const oci = server.packages.find((p: { registryType: string }) => p.registryType === "oci");
    expect(npm.identifier).toBe(pkg.name);
    expect(npm.version).toBe(pkg.version);
    expect(oci.identifier).toBe(`ghcr.io/gameye/gameye-mcp:${pkg.version}`);
  });

  it("labels the container image with the same registry name", () => {
    const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    expect(dockerfile).toContain(`io.modelcontextprotocol.server.name="${pkg.mcpName}"`);
  });
});
