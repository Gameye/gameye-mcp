import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GameyeClient } from "../client.js";
import { defineTool, type ServerContext } from "./common.js";

const MAX_CHARS = 50_000;

export function registerLogTools(server: McpServer, client: GameyeClient, ctx: ServerContext): void {
  defineTool(
    server,
    ctx,
    "gameye_get_logs",
    {
      title: "Get session logs",
      description:
        "Fetch a snapshot of stdout/stderr logs from a Gameye session (the last 50,000 characters). Live streaming is not available through MCP; call again to see newer output.",
      inputSchema: {
        id: z.string().describe("Session ID to fetch logs for"),
        follow: z
          .boolean()
          .optional()
          .describe("Ignored: MCP is request/response, so a snapshot is always fetched. Call again to see newer output."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id, follow }) => {
      const logs = await client.getLogs({ id });
      const note = follow === true ? "Note: follow=true is not supported via MCP; showing a snapshot instead.\n" : "";

      if (!logs || logs.trim() === "") {
        return `${note}No log output available for session ${id} yet. The container may still be starting up.`;
      }

      const truncated = logs.length > MAX_CHARS;
      const displayLogs = truncated ? logs.slice(-MAX_CHARS) : logs;
      return [
        note.trimEnd(),
        `Logs for session ${id}:`,
        truncated ? `(showing last ${MAX_CHARS} characters of ${logs.length} total)` : "",
        "─".repeat(60),
        displayLogs,
      ]
        .filter(Boolean)
        .join("\n");
    }
  );
}
