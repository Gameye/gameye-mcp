import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GameyeClient } from "../client.js";
import { formatDryRun } from "../guards.js";
import { defineTool, dryRunInput, type ServerContext } from "./common.js";
import type { JoinSessionOk } from "../types.js";

function formatPlayersResult(heading: string, session: string, players: string[], result: JoinSessionOk): string {
  return [
    `${heading}: ${players.join(", ")}`,
    `  Session:      ${session}`,
    `  Player count: ${result.count} (reported by server)`,
    ...(result.players.length > 0 ? [`  Players:      ${result.players.join(", ")}`] : []),
  ].join("\n");
}

const playersInput = {
  session: z.string().min(1).describe("Session ID"),
  players: z.array(z.string().min(1)).min(1).describe("One or more player IDs"),
  dryRun: dryRunInput,
};

export function registerPlayerTools(server: McpServer, client: GameyeClient, ctx: ServerContext): void {
  // ─── Player Join ─────────────────────────────────────────────────────────────

  defineTool(
    server,
    ctx,
    "gameye_player_join",
    {
      title: "Players join session",
      description:
        "Register one or more players as joined in a Gameye session. Returns the session's player count and IDs as reported by the server. Pass dryRun=true to preview the request.",
      inputSchema: playersInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ session, players, dryRun }) => {
      if (dryRun) return formatDryRun(ctx, GameyeClient.playersRequest("join", { session, players }), client);
      return formatPlayersResult("Players joined", session, players, await client.playerJoin({ session, players }));
    }
  );

  // ─── Player Leave ────────────────────────────────────────────────────────────

  defineTool(
    server,
    ctx,
    "gameye_player_leave",
    {
      title: "Players leave session",
      description:
        "Remove one or more players from a Gameye session. Returns the session's player count and IDs as reported by the server.",
      inputSchema: playersInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ session, players, dryRun }) => {
      if (dryRun) return formatDryRun(ctx, GameyeClient.playersRequest("leave", { session, players }), client);
      return formatPlayersResult("Players removed", session, players, await client.playerLeave({ session, players }));
    }
  );
}
