import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GameyeClient } from "../client.js";
import { defineTool, type ServerContext } from "./common.js";

export function registerLocationTools(server: McpServer, client: GameyeClient, ctx: ServerContext): void {
  defineTool(
    server,
    ctx,
    "gameye_get_locations",
    {
      title: "Get available locations",
      description:
        "Get the list of available regions/datacenters that can host a given game image, along with ping IPs for latency testing.",
      inputSchema: {
        image: z.string().describe("Docker image name to check availability for (e.g. 'csgo', 'nginx')"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ image }) => {
      const result = await client.getAvailableLocations(image);

      if (result.items.length === 0) {
        return `No available locations found for image "${image}". The image may not be deployed to the fleet yet.`;
      }

      const lines = result.items.map((loc) => {
        const pings = loc.pingIps && loc.pingIps.length > 0 ? `\n  Ping IPs: ${loc.pingIps.join(", ")}` : "";
        return `• ${loc.location}${pings}`;
      });

      return `Available locations for "${image}" (${result.items.length} region(s)):\n\n${lines.join("\n")}`;
    }
  );
}
