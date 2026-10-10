import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GameyeClient } from "../client.js";
import { defineTool, type ServerContext } from "./common.js";

export function registerRegionTools(server: McpServer, client: GameyeClient, ctx: ServerContext): void {
  defineTool(
    server,
    ctx,
    "gameye_list_regions",
    {
      title: "List regions",
      description:
        "List the region names available to your organization in this environment. Use a region name when creating or editing an application. " +
        "To see which regions can host a specific image right now, use gameye_get_locations. Needs the region:read scope.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { regions } = await client.listRegions();
      if (regions.length === 0) return "No regions are available to this token's organization.";
      return `Found ${regions.length} region(s):\n${regions.map((r) => `• ${r}`).join("\n")}`;
    }
  );
}
