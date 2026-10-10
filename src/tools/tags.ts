import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GameyeClient } from "../client.js";
import { defineTool, type ServerContext } from "./common.js";

export function registerTagTools(server: McpServer, client: GameyeClient, ctx: ServerContext): void {
  defineTool(
    server,
    ctx,
    "gameye_check_tag",
    {
      title: "Check image tag",
      description:
        "Verify that a specific Docker image tag has been deployed to a given region in the Gameye fleet. Use this before launching a session to confirm the version is available.",
      inputSchema: {
        region: z.string().describe("Region/location to check (e.g. 'europe', 'us-east')"),
        image: z.string().describe("Docker image name (e.g. 'csgo', 'tf2')"),
        version: z.string().describe("Docker image tag/version to verify (e.g. '1.2.3', 'latest')"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ region, image, version }) => {
      const result = await client.checkTag(region, image, version);
      const status = result.exists ? "✓ Available" : "✗ Not available";
      return [
        `Tag check result: ${status}`,
        `  Region:  ${result.region}`,
        `  Image:   ${result.image}`,
        `  Version: ${result.version}`,
        "",
        result.exists
          ? `The image ${result.image}:${result.version} is ready to use in ${result.region}.`
          : `The image ${result.image}:${result.version} is NOT deployed in ${result.region}. Check if the image has been pushed to the fleet or try a different region.`,
      ].join("\n");
    }
  );
}
