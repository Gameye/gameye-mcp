import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BETA_NOTICE } from "./beta.js";

/** The MCP server, with the beta notice sent to clients as its instructions. */
export function createServer(version: string): McpServer {
  return new McpServer({ name: "gameye", version }, { instructions: BETA_NOTICE });
}
