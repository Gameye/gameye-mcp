import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dirname } from "node:path";
import type { GameyeClient } from "../client.js";
import { defineTool, type ServerContext } from "./common.js";

export function registerArtifactTools(server: McpServer, client: GameyeClient, ctx: ServerContext): void {
  defineTool(
    server,
    ctx,
    "gameye_get_artifacts",
    {
      title: "Download session artifacts",
      description:
        "Download a file or directory (crash dumps, replays, logs) from a session's container. The server returns an uncompressed tar archive, saved to a new private temp directory; the local path is returned.",
      inputSchema: {
        session: z.string().min(1).describe("Session ID to download artifacts from"),
        path: z
          .string()
          .startsWith("/", "path must be an absolute path inside the container, e.g. /app/logs")
          .describe("Absolute path inside the container to export, e.g. /app/logs or /tmp/crash.dmp"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      errorHint: (err) =>
        err.statusCode === 404
          ? "Either the session was not found or the path does not exist in its container. Check the session ID and the absolute container path."
          : undefined,
    },
    async ({ session, path }) => {
      const outputPath = await client.getArtifacts({ session, path });
      return [
        `Artifacts downloaded for session ${session} (container path ${path}).`,
        ``,
        `Saved to: ${outputPath}`,
        ``,
        `To extract (uncompressed tar):`,
        `  tar -xf "${outputPath}" -C "${dirname(outputPath)}"`,
      ].join("\n");
    }
  );
}
