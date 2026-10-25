import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AGENT_LABEL_KEY, AGENT_LABEL_VALUE, DEFAULT_SESSION_TTL, DEFAULT_TOKEN_EXPIRY } from "../guards.js";
import { defineTool, type ServerContext } from "./common.js";
import { BETA_NOTICE } from "../beta.js";

export function registerContextTool(server: McpServer, ctx: ServerContext): void {
  defineTool(
    server,
    ctx,
    "gameye_context",
    {
      title: "Server context",
      description:
        "Show which Gameye environment and host this server targets, the server version and the guardrail defaults. The environment is fixed when the server starts (GAMEYE_ENV / GAMEYE_API_URL) and cannot be changed by a tool call.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      [
        BETA_NOTICE,
        `Environment:    ${ctx.environment}`,
        `Host:           ${ctx.host}`,
        `Base URL:       ${ctx.baseUrl}`,
        `Server version: gameye-mcp ${ctx.version}`,
        "",
        "Guardrail defaults:",
        `  Session TTL:   ${DEFAULT_SESSION_TTL} when a launch gives no ttl`,
        `  Session label: ${AGENT_LABEL_KEY}=${AGENT_LABEL_VALUE} on every launch`,
        `  Token expiry:  ${DEFAULT_TOKEN_EXPIRY} when gameye_create_token gives no expires_after`,
        "",
        "Session limits (set when the server starts):",
        `  Running at once: ${ctx.limits.maxSessions} sessions started by this server (GAMEYE_MAX_SESSIONS)`,
        `  Longest TTL:     ${ctx.limits.maxTtl} (GAMEYE_MAX_TTL)`,
        `  Launches:        ${ctx.limits.maxLaunches} per server run (GAMEYE_MAX_LAUNCHES)`,
        `  Stop:            ${ctx.limits.stopOwnOnly ? "only sessions this server launched (GAMEYE_STOP_OWN_ONLY=1)" : "any session the token can see, by exact ID"}`,
        "",
        "Token scopes: not introspectable. The Gameye API has no endpoint that reports a token's scopes; a call that needs a missing scope fails with 403 and names the required scope.",
        ctx.environment === "custom"
          ? "This server uses a non-standard GAMEYE_API_URL."
          : "To target the other environment, configure a second server entry with a different GAMEYE_ENV.",
      ].join("\n")
  );
}
