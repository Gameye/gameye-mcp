import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_TIMEOUT_MS } from "./env.js";
import { userAgent } from "./version.js";
import type {
  Resources,
  Application,
  ApplicationsOk,
  ArtifactsRequest,
  CreateApplication,
  CreateTokenRequest,
  EditApplication,
  AvailableLocationsOk,
  DescribedSession,
  ErrorResponse,
  GameyeClientConfig,
  JoinSession,
  JoinSessionOk,
  LeaveSession,
  LeaveSessionOk,
  LogsRequest,
  Port,
  PortProtocol,
  RegionsOk,
  RegistryTagsOk,
  SessionListOk,
  SessionRun,
  SessionRunOk,
  SessionStatus,
  TagOk,
} from "./types.js";

// ─── Raw API response types (actual wire format from Gameye) ─────────────────
// The Gameye API returns slightly different field names than the normalised
// TypeScript types used by the rest of the codebase.  These private interfaces
// describe what the wire actually looks like; the client methods normalise on
// the way out so callers always see the canonical shape.

interface RawSessionRunResponse {
  id: string;
  host?: string;
  ports?: Array<{ type: string; container: number; host: number }>;
}

interface RawLocation {
  id: string;
  ips?: string[];
}

interface RawLocationsResponse {
  locations: RawLocation[];
}

interface RawSessionEntry {
  id: string;
  image: string;
  tag?: string;
  location: string;
  host?: string;
  status: string;
  playerCount?: number;
  port?: Record<string, number>; // e.g. { "80/tcp": 23087 }
  labels?: Record<string, string>;
  created: number; // Unix milliseconds
}

interface RawSessionListResponse {
  sessions: RawSessionEntry[];
}

interface RawDescribedSession {
  id: string;
  image: string;
  tag?: string;
  location: string;
  host?: string;
  created: number; // Unix milliseconds
  status: string;
  port: Record<string, number>; // e.g. { "80/tcp": 23087 }
  labels?: Record<string, string>;
  players: { joined: string[] | null; joinedCount: number };
}

interface RawPlayersResponse {
  count?: number;
  players?: string[] | null;
}

interface RawTagResponse {
  exists: boolean;
}

interface RawRegionsResponse {
  regions?: string[] | null;
}


interface RawListedApplication {
  name: string;
  repository: string;
  tagKeep: number;
  networkMode: string;
  limits: Resources;
  reservation: Resources;
  registry?: string;
  nodePool?: string;
  regions?: string[] | null;
  ports?: Array<{ requested: number; protocol: string; tls?: boolean }> | null;
}

interface RawApplicationsResponse {
  applications?: RawListedApplication[] | null;
}

interface RawRegistryTagsResponse {
  tags?: Array<{ version: string }> | null;
}

interface RawTokenCreatedResponse {
  token?: string;
}

/** A request as it would be sent, for dry runs. Holds no credentials. */
export interface PlannedRequest {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Path plus query string, relative to the base URL. */
  path: string;
  body?: unknown;
}

export const MASK = "***";

/** Minimum timeout for a log snapshot, which can be large. */
export const LOGS_TIMEOUT_MS = 60_000;
/** Minimum timeout for an artifact download, which streams a whole tar archive. */
export const ARTIFACTS_TIMEOUT_MS = 120_000;

// ─── Label redaction ─────────────────────────────────────────────────────────
// Session labels returned by list and describe include an `env` label holding
// the launch environment as JSON. It can carry secrets, so its value is never
// passed on to callers.

export const REDACTED = "(hidden)";
const SECRET_LABELS = new Set(["env"]);

export function redactLabels(labels?: Record<string, string>): Record<string, string> | undefined {
  if (!labels) return labels;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    out[k] = SECRET_LABELS.has(k) ? REDACTED : v;
  }
  return out;
}

// Picks the primary game port: prefer UDP (game traffic), fall back to first port
function buildConnectionString(host: string, ports: Port[]): string | undefined {
  if (!ports.length) return undefined;
  const primary = ports.find((p) => p.type === "udp") ?? ports[0];
  return `${host}:${primary.host}`;
}

function parsePortMap(port?: Record<string, number>): Port[] {
  return Object.entries(port ?? {}).map(([key, hostPort]) => {
    const [containerStr, type] = key.split("/");
    return { type: type as PortProtocol, container: parseInt(containerStr, 10), host: hostPort };
  });
}

/** Make a session ID safe to use as one path segment. */
export function safeFileSegment(value: string): string {
  const cleaned = value
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^\./, "_")
    .slice(0, 128);
  return cleaned || "_";
}

export class GameyeError extends Error {
  public readonly details?: string;
  public readonly identifier?: string;

  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly violations?: ErrorResponse["violations"],
    extra?: { details?: string; identifier?: string }
  ) {
    super(message);
    this.name = "GameyeError";
    this.details = extra?.details;
    this.identifier = extra?.identifier;
  }

  /** The scope a 403 says the token is missing, when the server names it. */
  get requiredScope(): string | undefined {
    if (this.statusCode !== 403 || !this.details) return undefined;
    return /required scope '([^']+)'/i.exec(this.details)?.[1];
  }

  toDisplayString(): string {
    const lines: string[] = [`Error ${this.statusCode}: ${this.message} (${this.code})`];
    if (this.details) lines.push(`Details: ${this.details}`);
    const scope = this.requiredScope;
    if (scope) {
      lines.push(`Required scope: ${scope}. Create a token that includes it, or ask your organization admin.`);
    }
    if (this.violations && this.violations.length > 0) {
      lines.push("Field violations:");
      for (const v of this.violations) {
        lines.push(`  - ${v.field}: ${v.description}`);
      }
    }
    if (this.identifier) lines.push(`Trace ID: ${this.identifier} (quote this when contacting Gameye support)`);
    return lines.join("\n");
  }
}

/** A request got no complete answer within its timeout and was aborted. */
export class GameyeTimeoutError extends Error {
  constructor(
    public readonly host: string,
    public readonly timeoutMs: number
  ) {
    super(`Request to ${host} timed out after ${timeoutMs / 1000}s`);
    this.name = "GameyeTimeoutError";
  }
}

function isAbortError(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

export class GameyeClient {
  private readonly baseUrl: string;
  private readonly host: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private userAgent = userAgent();

  constructor(config: GameyeClientConfig) {
    this.token = config.token;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.host = new URL(this.baseUrl).host;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Name the MCP client in the User-Agent, e.g. `gameye-mcp/0.1.0 (claude-code)`.
   * Called once the client has introduced itself in `initialize`.
   */
  setClientName(name: string | undefined): void {
    this.userAgent = userAgent(name);
  }

  /**
   * Send one request with a timeout. The timeout covers both the fetch and
   * `read`, so a server that stalls mid-body is cut off too. Every request
   * goes through here.
   */
  private async request<T>(
    target: string | URL,
    init: RequestInit,
    timeoutMs: number,
    read: (response: Response) => Promise<T>
  ): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetch(target, { ...init, signal });
      return await read(response);
    } catch (err) {
      if (signal.aborted || isAbortError(err)) throw new GameyeTimeoutError(this.host, timeoutMs);
      throw err;
    }
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": this.userAgent,
      ...extra,
    };
  }

  private async handleResponse<T>(response: Response): Promise<T> {
    if (response.ok) {
      const text = await response.text();
      if (!text) return {} as T;
      return JSON.parse(text) as T;
    }

    let code = "UNKNOWN_ERROR";
    let message = `HTTP ${response.status}`;
    let violations: ErrorResponse["violations"];
    let details: string | undefined;
    let identifier: string | undefined;

    try {
      const body = (await response.json()) as ErrorResponse;
      code = body.code ?? code;
      message = body.message ?? message;
      violations = body.violations;
      details = body.details || undefined;
      identifier = body.identifier || undefined;
    } catch {
      // Response body not JSON; keep defaults
    }

    throw new GameyeError(response.status, code, message, violations, { details, identifier });
  }

  static launchSessionRequest(req: SessionRun): PlannedRequest {
    return { method: "POST", path: "/session", body: req };
  }

  static playersRequest(action: "join" | "leave", req: JoinSession | LeaveSession): PlannedRequest {
    return {
      method: action === "join" ? "PUT" : "DELETE",
      path: `/session/player/${action}`,
      body: { session: req.session, players: req.players },
    };
  }

  static stopSessionRequest(id: string): PlannedRequest {
    return { method: "DELETE", path: `/session/${encodeURIComponent(id)}` };
  }

  async launchSession(req: SessionRun): Promise<SessionRunOk> {
    const raw = await this.send<RawSessionRunResponse>(GameyeClient.launchSessionRequest(req));
    const ports: Port[] = (raw.ports ?? []).map((p) => ({
      type: p.type as PortProtocol,
      container: p.container,
      host: p.host,
    }));
    const connectionString = raw.host ? buildConnectionString(raw.host, ports) : undefined;
    return { id: raw.id, host: raw.host, ports, connectionString };
  }

  async listSessions(params?: {
    all?: boolean;
    location?: string;
    image?: string;
    tag?: string;
    host?: string;
    playerCountLt?: number;
    playerCountGt?: number;
    filter?: Record<string, string>;
    filterNot?: Record<string, string>;
  }): Promise<SessionListOk> {
    const q = new URLSearchParams();
    if (params) {
      if (params.all != null) q.set("all", String(params.all));
      if (params.location) q.set("location", params.location);
      if (params.image) q.set("image", params.image);
      if (params.tag) q.set("tag", params.tag);
      if (params.host) q.set("host", params.host);
      if (params.playerCountLt != null)
        q.set("playerCount[lt]", String(params.playerCountLt));
      if (params.playerCountGt != null)
        q.set("playerCount[gt]", String(params.playerCountGt));
      for (const [k, v] of Object.entries(params.filter ?? {})) {
        q.set(`filter[${k}]`, v);
      }
      for (const [k, v] of Object.entries(params.filterNot ?? {})) {
        q.set(`filterNot[${k}]`, v);
      }
    }
    const qs = q.toString();
    const raw = await this.send<RawSessionListResponse>({ method: "GET", path: `/session${qs ? `?${qs}` : ""}` });
    return {
      items: (raw.sessions ?? []).map((s) => {
        const ports = parsePortMap(s.port);
        return {
          id: s.id,
          image: s.image,
          version: s.tag,
          location: s.location,
          host: s.host || undefined,
          ports,
          connectionString: s.host ? buildConnectionString(s.host, ports) : undefined,
          status: s.status as SessionStatus,
          playerCount: s.playerCount ?? 0,
          labels: redactLabels(s.labels),
          createdAt: new Date(s.created).toISOString(),
        };
      }),
    };
  }

  async describeSession(id: string): Promise<DescribedSession> {
    const raw = await this.send<RawDescribedSession>({ method: "GET", path: `/session/${encodeURIComponent(id)}` });
    const ports = parsePortMap(raw.port);
    return {
      id: raw.id,
      image: raw.image,
      version: raw.tag,
      location: raw.location,
      host: raw.host || undefined,
      status: raw.status as SessionStatus,
      players: { count: raw.players?.joinedCount ?? 0, ids: raw.players?.joined ?? [] },
      ports,
      labels: redactLabels(raw.labels),
      createdAt: new Date(raw.created).toISOString(),
      connectionString: raw.host ? buildConnectionString(raw.host, ports) : undefined,
    };
  }

  async stopSession(id: string): Promise<void> {
    await this.send<void>(GameyeClient.stopSessionRequest(id));
  }

  private async players(
    action: "join" | "leave",
    req: JoinSession | LeaveSession
  ): Promise<JoinSessionOk | LeaveSessionOk> {
    const raw = await this.send<RawPlayersResponse>(GameyeClient.playersRequest(action, req));
    const players = raw.players ?? [];
    return { count: raw.count ?? players.length, players };
  }

  async playerJoin(req: JoinSession): Promise<JoinSessionOk> {
    return this.players("join", req);
  }

  async playerLeave(req: LeaveSession): Promise<LeaveSessionOk> {
    return this.players("leave", req);
  }

  async getAvailableLocations(image: string): Promise<AvailableLocationsOk> {
    const raw = await this.send<RawLocationsResponse>({
      method: "GET",
      path: `/available-location/${encodeURIComponent(image)}`,
    });
    return {
      items: (raw.locations ?? []).map((l) => ({
        location: l.id,
        pingIps: l.ips,
      })),
    };
  }

  async checkTag(region: string, image: string, version: string): Promise<TagOk> {
    const raw = await this.send<RawTagResponse>({
      method: "GET",
      path: `/tag/${encodeURIComponent(region)}/${encodeURIComponent(image)}/${encodeURIComponent(version)}`,
    });
    return { region, image, version, exists: raw.exists };
  }

  // ─── Secret handling ────────────────────────────────────────────────────────
  // The token never leaves this class. Guards ask whether a value contains it
  // and get text back with it masked.

  /** True when `text` contains the configured API token. */
  containsToken(text: string): boolean {
    return this.token.length > 0 && text.includes(this.token);
  }

  /** Replace every occurrence of the configured API token with `***`. */
  maskToken(text: string): string {
    return this.token.length > 0 ? text.split(this.token).join(MASK) : text;
  }

  // ─── Regions ────────────────────────────────────────────────────────────────

  async listRegions(): Promise<RegionsOk> {
    const raw = await this.send<RawRegionsResponse>({ method: "GET", path: "/region" });
    return { regions: raw.regions ?? [] };
  }

  // ─── Applications ───────────────────────────────────────────────────────────

  async listApplications(): Promise<ApplicationsOk> {
    const raw = await this.send<RawApplicationsResponse>({ method: "GET", path: "/application" });
    return {
      items: (raw.applications ?? []).map(
        (a): Application => ({
          name: a.name,
          repository: a.repository,
          tagKeep: a.tagKeep,
          networkMode: a.networkMode,
          limits: a.limits,
          reservation: a.reservation,
          registry: a.registry || undefined,
          nodePool: a.nodePool || undefined,
          regions: a.regions ?? [],
          ports: (a.ports ?? []).map((p) => ({
            requested: p.requested,
            protocol: p.protocol as PortProtocol,
            tls: p.tls ?? false,
          })),
        })
      ),
    };
  }

  static registryTagsPath(name: string, page?: number, pageSize?: number): string {
    const q = new URLSearchParams();
    if (page != null) q.set("page", String(page));
    if (pageSize != null) q.set("pageSize", String(pageSize));
    const qs = q.toString();
    return `/application/${encodeURIComponent(name)}/tags/available${qs ? `?${qs}` : ""}`;
  }

  async listRegistryTags(name: string, page?: number, pageSize?: number): Promise<RegistryTagsOk> {
    const raw = await this.send<RawRegistryTagsResponse>({
      method: "GET",
      path: GameyeClient.registryTagsPath(name, page, pageSize),
    });
    return { versions: (raw.tags ?? []).map((t) => t.version) };
  }

  static enableTagRequest(name: string, tag: string): PlannedRequest {
    return { method: "POST", path: `/application/${encodeURIComponent(name)}/tags`, body: { tag } };
  }

  async enableTag(name: string, tag: string): Promise<void> {
    await this.send<void>(GameyeClient.enableTagRequest(name, tag));
  }

  static createApplicationRequest(body: CreateApplication): PlannedRequest {
    return { method: "POST", path: "/application", body };
  }

  async createApplication(body: CreateApplication): Promise<void> {
    await this.send<void>(GameyeClient.createApplicationRequest(body));
  }

  static editApplicationRequest(name: string, body: EditApplication): PlannedRequest {
    return { method: "PUT", path: `/application/${encodeURIComponent(name)}`, body };
  }

  async editApplication(name: string, body: EditApplication): Promise<void> {
    await this.send<void>(GameyeClient.editApplicationRequest(name, body));
  }

  // ─── Tokens ─────────────────────────────────────────────────────────────────

  static createTokenRequest(body: CreateTokenRequest): PlannedRequest {
    return { method: "POST", path: "/token", body };
  }

  /** Returns the new token. Callers must write it to a file and never display it. */
  async createToken(body: CreateTokenRequest): Promise<string> {
    const raw = await this.send<RawTokenCreatedResponse>(GameyeClient.createTokenRequest(body));
    if (!raw.token) throw new Error("The server did not return a token.");
    return raw.token;
  }

  /** Send a planned JSON request and parse the response. */
  private async send<T>(req: PlannedRequest): Promise<T> {
    return this.request(
      `${this.baseUrl}${req.path}`,
      {
        method: req.method,
        headers: this.headers(),
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      },
      this.timeoutMs,
      (response) => this.handleResponse<T>(response)
    );
  }

  /**
   * Fetch a log snapshot. The server streams (follow=true) unless follow=false
   * is sent explicitly, which would never complete in a request/response tool,
   * so follow=false is always sent.
   */
  async getLogs(req: LogsRequest): Promise<string> {
    const url = new URL(`${this.baseUrl}/logs`);
    url.searchParams.set("id", req.id);
    url.searchParams.set("follow", "false");

    return this.request(
      url,
      { headers: { ...this.headers(), Accept: "text/plain" } },
      Math.max(LOGS_TIMEOUT_MS, this.timeoutMs),
      async (response) => {
        if (!response.ok) await this.handleResponse<void>(response); // throws
        return response.text();
      }
    );
  }

  /**
   * Download `path` from the session's container. The server streams the
   * output of a Docker copy, which is an uncompressed tar archive. It is saved
   * into a fresh private temp directory under a sanitized name, so a session ID
   * containing `/` or `..` cannot write anywhere else.
   */
  async getArtifacts(req: ArtifactsRequest): Promise<string> {
    const url = new URL(`${this.baseUrl}/artifacts`);
    url.searchParams.set("session", req.session);
    url.searchParams.set("path", req.path);

    return this.request(
      url,
      { headers: { ...this.headers(), Accept: "application/octet-stream" } },
      Math.max(ARTIFACTS_TIMEOUT_MS, this.timeoutMs),
      async (response) => {
        if (!response.ok) await this.handleResponse<void>(response); // throws

        const dir = await mkdtemp(join(tmpdir(), "gameye-artifacts-"));
        const fileName = basename(`gameye-artifact-${safeFileSegment(req.session)}.tar`);
        const outputPath = join(dir, fileName);
        let handle: FileHandle | undefined;
        try {
          // Stream to disk: artifacts (replays, crash dumps) can be large.
          handle = await open(outputPath, "wx", 0o600);
          if (response.body) {
            for await (const chunk of response.body) await handle.write(chunk);
          }
          const done = handle;
          handle = undefined;
          await done.close();
          return outputPath;
        } catch (err) {
          // Never leave a truncated archive behind.
          await handle?.close().catch(() => undefined);
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
          throw err;
        }
      }
    );
  }
}
