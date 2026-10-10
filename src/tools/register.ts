import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GameyeClient } from "../client.js";
import type { RegisterOptions, ServerContext } from "./common.js";
import { registerContextTool } from "./context.js";
import { registerSessionTools } from "./sessions.js";
import { registerPlayerTools } from "./players.js";
import { registerLocationTools } from "./locations.js";
import { registerRegionTools } from "./regions.js";
import { registerTagTools } from "./tags.js";
import { registerApplicationTools } from "./applications.js";
import { registerTokenTools } from "./tokens.js";
import { registerLogTools } from "./logs.js";
import { registerArtifactTools } from "./artifacts.js";

export type { RegisterOptions };

/** Register every tool. Admin tools only when `opts.admin` is true. */
export function registerAllTools(
  server: McpServer,
  client: GameyeClient,
  ctx: ServerContext,
  opts: RegisterOptions
): void {
  registerContextTool(server, ctx, opts);
  registerSessionTools(server, client, ctx);
  registerPlayerTools(server, client, ctx);
  registerLocationTools(server, client, ctx);
  registerRegionTools(server, client, ctx);
  registerTagTools(server, client, ctx);
  registerApplicationTools(server, client, ctx, opts);
  registerLogTools(server, client, ctx);
  registerArtifactTools(server, client, ctx);
  if (opts.admin) registerTokenTools(server, client, ctx);
}
