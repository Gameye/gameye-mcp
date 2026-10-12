import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GameyeClient } from "../client.js";
import type { ServerContext } from "./common.js";
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
import { registerSkillsTools } from "./skills.js";

/** Register every tool. */
export function registerAllTools(
  server: McpServer,
  client: GameyeClient,
  ctx: ServerContext
): void {
  registerContextTool(server, ctx);
  registerSessionTools(server, client, ctx);
  registerPlayerTools(server, client, ctx);
  registerLocationTools(server, client, ctx);
  registerRegionTools(server, client, ctx);
  registerTagTools(server, client, ctx);
  registerApplicationTools(server, client, ctx);
  registerLogTools(server, client, ctx);
  registerArtifactTools(server, client, ctx);
  registerTokenTools(server, client, ctx);
  registerSkillsTools(server, ctx);
}
