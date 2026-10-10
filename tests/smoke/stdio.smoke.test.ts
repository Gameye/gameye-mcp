// Stdio smoke test: launches a built server and speaks MCP to it over stdin and
// stdout, as an MCP client does. It needs a build, so it runs through
// `npm run test:smoke`, not `npm test`.
//
// GAMEYE_MCP_SMOKE_CMD overrides the launch command, as a JSON array, so the
// same test checks an installed package or the Docker image, for example
// ["gameye-mcp"] or ["docker","run","-i","--rm","-e","GAMEYE_API_TOKEN","<image>"].
// The token is a dummy: initialize and tools/list never call the Gameye API.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { GameyeClient } from "../../src/client.js";
import { registerAllTools } from "../../src/tools/register.js";
import { VERSION } from "../../src/version.js";
import { makeContext, makeMockServer } from "../unit/helpers.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const command: string[] = process.env.GAMEYE_MCP_SMOKE_CMD
  ? JSON.parse(process.env.GAMEYE_MCP_SMOKE_CMD)
  : [process.execPath, "dist/index.js"];

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
  exitAfterStdinCloseMs: number;
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim());
}

/** Writes the messages, closes stdin once every request has a reply, and waits for the server to exit. */
function run(messages: object[], token: string | undefined, timeoutMs = 30_000): Promise<Run> {
  const env = { ...process.env };
  delete env.GAMEYE_API_TOKEN;
  delete env.GAMEYE_ENABLE_ADMIN_TOOLS;
  if (token !== undefined) env.GAMEYE_API_TOKEN = token;
  const expectedReplies = messages.filter((m) => "id" in m).length;
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd: repoRoot, env });
    let stdout = "";
    let stderr = "";
    let stdinClosedAt = 0;
    const closeStdin = () => {
      if (stdinClosedAt) return;
      stdinClosedAt = Date.now();
      child.stdin.end();
    };
    child.stdout.on("data", (d) => {
      stdout += d;
      if (nonEmptyLines(stdout).length >= expectedReplies) closeStdin();
    });
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not exit within ${timeoutMs} ms\nstderr: ${stderr}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, exitAfterStdinCloseMs: stdinClosedAt ? Date.now() - stdinClosedAt : 0 });
    });
    child.stdin.on("error", () => {}); // the server may exit before reading, e.g. without a token
    child.stdin.write(messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
  });
}

const handshake = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
];

function registeredToolNames(): string[] {
  const mock = makeMockServer();
  const ctx = makeContext();
  registerAllTools(mock.server, new GameyeClient({ token: "t", baseUrl: ctx.baseUrl }), ctx, { admin: false });
  return Object.keys(mock.handlers).sort();
}

describe(`stdio smoke: ${command.join(" ")}`, () => {
  let session: Run;
  beforeAll(async () => {
    session = await run(handshake, "gy_smoke_dummy_token");
  });

  it("answers initialize and tools/list with protocol-only stdout", () => {
    const messages = nonEmptyLines(session.stdout).map((line) => JSON.parse(line)); // throws on any non-JSON stdout
    for (const m of messages) expect(m.jsonrpc).toBe("2.0");

    const init = messages.find((m) => m.id === 1);
    expect(init.result.serverInfo).toEqual({ name: "gameye", version: VERSION });

    const tools = messages.find((m) => m.id === 2).result.tools.map((t: { name: string }) => t.name).sort();
    expect(tools).toContain("gameye_context");
    expect(tools).toEqual(registeredToolNames());

    expect(session.stderr).toContain("running on stdio");
    expect(session.stdout).not.toContain("running on stdio");
  });

  it("exits cleanly and promptly when the client closes stdin", () => {
    expect(session.code).toBe(0);
    expect(session.exitAfterStdinCloseMs).toBeLessThan(5_000);
  });

  it("refuses to start without GAMEYE_API_TOKEN, naming it on stderr only", async () => {
    const result = await run(handshake, undefined);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("GAMEYE_API_TOKEN");
    expect(result.stdout).toBe("");
  });
});
