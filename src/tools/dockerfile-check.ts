import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkDockerfile, formatDockerfileReport } from "../dockerfile-check.js";
import { defineTool, type ServerContext } from "./common.js";

const MAX_DOCKERFILE_CHARS = 200_000;

export function registerDockerfileCheckTool(server: McpServer, ctx: ServerContext): void {
  defineTool(
    server,
    ctx,
    "gameye_check_dockerfile",
    {
      title: "Check Dockerfile",
      description:
        "Check game server Dockerfile text against the gameye-containerize container contract, offline: linux/amd64 base, exposed ports and protocols, exec-form launch without npm/yarn start, no loopback bind, non-root user, and no API token or credential in ENV/ARG. Returns findings with severity, rule code, line, message and fix, plus what the check cannot know. Pass the Dockerfile text itself; this tool reads no files and sends nothing.",
      inputSchema: {
        dockerfile: z
          .string()
          .min(1)
          .max(MAX_DOCKERFILE_CHARS)
          .describe("The full Dockerfile text (not a path)"),
        ports: z
          .array(
            z.object({
              port: z.number().int().min(1).max(65535).describe("Container port the server binds"),
              protocol: z.enum(["tcp", "udp"]).describe("Protocol the server binds on that port"),
            })
          )
          .max(64)
          .optional()
          .describe("Optional: the ports and protocols the server binds, to check against EXPOSE"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      requiresToken: false,
    },
    async ({ dockerfile, ports }) => formatDockerfileReport(checkDockerfile(dockerfile, { ports }))
  );
}
