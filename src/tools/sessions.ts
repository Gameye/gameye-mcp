import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GameyeClient, GameyeError } from "../client.js";
import {
  AGENT_LABEL_KEY,
  AGENT_LABEL_VALUE,
  DEFAULT_SESSION_TTL,
  applyLaunchDefaults,
  assertExplicitSessionId,
  assertNoTokenInLaunch,
  describeTtl,
  formatDryRun,
  GuardError,
} from "../guards.js";
import { SessionLimiter } from "../limits.js";
import type { Port } from "../types.js";
import { defineTool, dryRunInput, formatLabels, type ServerContext } from "./common.js";

function formatPorts(ports: Port[] | undefined): string {
  return (ports ?? []).map((p) => `${p.host}:${p.container}/${p.type}`).join(", ");
}

export function registerSessionTools(server: McpServer, client: GameyeClient, ctx: ServerContext): void {
  const limiter = new SessionLimiter(ctx.limits, client);
  const { maxSessions, maxTtl, maxLaunches, stopOwnOnly } = ctx.limits;

  // ─── Launch Session ──────────────────────────────────────────────────────────

  defineTool(
    server,
    ctx,
    "gameye_launch_session",
    {
      title: "Launch session",
      description:
        "Start a containerized game server session on the Gameye platform. Returns the session ID, host and ports. Starts a billable session in the environment shown in the result prefix. " +
        `When no ttl is given, a ${DEFAULT_SESSION_TTL} TTL is applied and reported. The label ${AGENT_LABEL_KEY}=${AGENT_LABEL_VALUE} is always sent and replaces any ${AGENT_LABEL_KEY} value you pass; ` +
        "if a warm pool serves the image and region, the server ignores request labels (and env and args), so warm-pool sessions do not carry it. " +
        "The launch is refused, with nothing sent, if any env value, arg or label contains this server's Gameye API token. " +
        `It is also refused if the ttl is above ${maxTtl}, if ${maxSessions} sessions started by this server are already running, or after ${maxLaunches} launches by this server process; ` +
        "these limits are set by the user when the server starts, and a refusal says which one applied. Pass dryRun=true to preview the request.",
      inputSchema: {
        location: z.string().describe("Region/datacenter to host the session (e.g. 'europe', 'us-east')"),
        image: z.string().describe("Docker image name to run (e.g. 'csgo', 'tf2')"),
        id: z.string().optional().describe("Custom session ID; auto-generated if omitted. IDs are unique across all of Gameye, so derive it from a UUID. A 409 whose describe returns 404 means another customer owns the ID: retry with a fresh one. Warm-pool launches ignore it; always read the ID from the result"),
        env: z.record(z.string(), z.string()).optional().describe("Environment variables passed to the container"),
        args: z.array(z.string()).optional().describe("Command-line arguments passed to the container entrypoint"),
        labels: z.record(z.string(), z.string()).optional().describe("Arbitrary key-value labels for filtering/grouping"),
        restart: z.boolean().optional().describe("Automatically restart the container on exit"),
        version: z.string().optional().describe("Docker image tag/version to use"),
        ttl: z
          .string()
          .optional()
          .describe(`Session time-to-live, e.g. '1h', '30m'. Session auto-stops after this duration. Defaults to ${DEFAULT_SESSION_TTL}; at most ${maxTtl}`),
        dryRun: dryRunInput,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ dryRun, ...input }) => {
      assertNoTokenInLaunch(input, client);
      const { request, defaultTtlApplied } = applyLaunchDefaults(input);
      const ttl = request.ttl ?? DEFAULT_SESSION_TTL;
      const ttlMs = limiter.checkTtl(ttl);
      const ttlLine = `  TTL:        ${describeTtl(ttl, defaultTtlApplied)}`;
      if (dryRun) {
        return `${formatDryRun(ctx, GameyeClient.launchSessionRequest(request), client)}\n\n${ttlLine.trim()}`;
      }
      const slot = await limiter.reserve(ttlMs);
      let result: Awaited<ReturnType<GameyeClient["launchSession"]>>;
      try {
        result = await client.launchSession(request);
      } catch (err) {
        // A 4xx means nothing started. A 5xx, timeout or network error may have started one.
        slot.failed(!(err instanceof GameyeError && err.statusCode < 500));
        throw err;
      }
      slot.started(result.id);
      const lines = [`Session launched successfully.`, `  Session ID: ${result.id}`, ttlLine];
      if (result.host) lines.push(`  Host:       ${result.host}`);
      if (result.ports?.length > 0) {
        lines.push(`  Ports:      ${result.ports.map((p) => `${p.host}/${p.type}`).join(", ")}`);
      }
      if (result.connectionString) {
        lines.push(`  Connect:    ${result.connectionString}`);
      } else {
        lines.push(`\nServer is starting — use gameye_describe_session to get the host and port once status is 'running'.`);
      }
      return lines.join("\n");
    }
  );

  // ─── List Sessions ───────────────────────────────────────────────────────────

  defineTool(
    server,
    ctx,
    "gameye_list_sessions",
    {
      title: "List sessions",
      description:
        "List game server sessions with host, ports and connection string. By default only running sessions are returned; pass all=true to include sessions in every status. " +
        "filter and filterNot match user labels only (the labels given at launch), not system fields such as image or location — use the dedicated parameters for those. " +
        "Values of the session's environment are never shown.",
      inputSchema: {
        all: z.boolean().optional().describe("Include sessions in every status (default: running sessions only)"),
        location: z.string().optional().describe("Filter by location/region"),
        image: z.string().optional().describe("Filter by image name"),
        tag: z.string().optional().describe("Filter by image tag/version"),
        host: z.string().optional().describe("Filter by host IP"),
        playerCountLt: z.number().int().optional().describe("Only sessions with fewer than N players"),
        playerCountGt: z.number().int().optional().describe("Only sessions with more than N players"),
        filter: z
          .record(z.string(), z.string())
          .optional()
          .describe("Only sessions whose user labels match every key=value pair"),
        filterNot: z
          .record(z.string(), z.string())
          .optional()
          .describe("Exclude sessions whose user labels match these key=value pairs"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      const result = await client.listSessions(args);
      if (result.items.length === 0) {
        return args.all
          ? "No sessions found matching the given filters."
          : "No running sessions found matching the given filters. Pass all=true to include sessions in other statuses.";
      }
      const lines = result.items.map((s) => {
        const labels = formatLabels(s.labels, ", ", "=");
        const parts = [
          `• ${s.id}  ${s.image}${s.version ? `:${s.version}` : ""}  @ ${s.location}  status=${s.status}  players=${s.playerCount}`,
          `    host=${s.host ?? "(none)"}  ports=${formatPorts(s.ports) || "(none)"}${s.connectionString ? `  connect=${s.connectionString}` : ""}  created=${s.createdAt}`,
        ];
        if (labels) parts.push(`    labels: ${labels}`);
        return parts.join("\n");
      });
      return `Found ${result.items.length} session(s):\n\n${lines.join("\n")}`;
    }
  );

  // ─── Describe Session ────────────────────────────────────────────────────────

  defineTool(
    server,
    ctx,
    "gameye_describe_session",
    {
      title: "Describe session",
      description:
        "Get details of a Gameye session: status, players, host, ports, connection string, labels and creation time. Values of the session's environment are never shown.",
      inputSchema: {
        id: z.string().describe("Session ID to describe"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      const s = await client.describeSession(id);
      const labels = formatLabels(s.labels, "\n", ": ");
      const playerIds = s.players.ids && s.players.ids.length > 0 ? ` (${s.players.ids.join(", ")})` : "";
      return [
        `Session: ${s.id}`,
        `  Image:    ${s.image}${s.version ? `:${s.version}` : ""}`,
        `  Location: ${s.location}`,
        `  Status:   ${s.status}`,
        `  Players:  ${s.players.count}${playerIds}`,
        `  Ports:    ${formatPorts(s.ports) || "(none)"}`,
        `  Host:     ${s.host ?? "(not yet assigned)"}`,
        `  Connect:  ${s.connectionString ?? "(not yet available)"}`,
        `  Created:  ${s.createdAt}`,
        `  Labels:\n${labels ? labels.replace(/^/gm, "    ") : "    (none)"}`,
      ].join("\n");
    }
  );

  // ─── Stop Session ────────────────────────────────────────────────────────────

  defineTool(
    server,
    ctx,
    "gameye_stop_session",
    {
      title: "Stop session",
      description:
        "Terminate one Gameye session by its exact ID (sends SIGTERM to the container). Any players connected to it are disconnected. The session transitions to 'draining' then 'shuttingdown' then 'exited'. " +
        "There is no bulk or implicit stop: an empty, wildcard or list ID is refused. " +
        (stopOwnOnly ? "This server only stops sessions it launched itself (GAMEYE_STOP_OWN_ONLY=1). " : "") +
        "Pass dryRun=true to preview the request.",
      inputSchema: {
        id: z.string().min(1).describe("Exact ID of the one session to stop"),
        dryRun: dryRunInput,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id: rawId, dryRun }) => {
      const id = assertExplicitSessionId(rawId);
      if (stopOwnOnly && !limiter.isOwn(id)) {
        throw new GuardError(
          `Stop refused: session ${id} was not launched by this server, and it only stops its own sessions (GAMEYE_STOP_OWN_ONLY=1). ` +
            "Ask the user to stop it in the Admin Panel or from another tool. No request was sent."
        );
      }
      if (dryRun) return formatDryRun(ctx, GameyeClient.stopSessionRequest(id), client);
      await client.stopSession(id);
      limiter.stopped(id);
      return `Session ${id} stop signal sent. The session is now draining.\n\nUse gameye_describe_session to monitor shutdown progress.`;
    }
  );
}
