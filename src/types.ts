// TypeScript types derived from the Gameye OpenAPI specification

// ─── Enums ────────────────────────────────────────────────────────────────────

export type SessionStatus =
  | "created"
  | "running"
  | "restarting"
  | "exited"
  | "dead"
  | "draining"
  | "shuttingdown"
  | "server_unreachable";

export type PortProtocol = "tcp" | "udp";

// ─── Shared ───────────────────────────────────────────────────────────────────

export interface Port {
  type: PortProtocol;
  container: number;
  host: number;
}

export interface FieldViolation {
  field: string;
  description: string;
}

export interface ErrorResponse {
  statusCode?: number;
  code: string;
  message: string;
  /** Human-readable explanation; for 403 it names the missing scope. */
  details?: string;
  path?: string;
  timestamp?: string;
  /** Server trace ID; quote it when contacting Gameye support. */
  identifier?: string;
  violations?: FieldViolation[];
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export interface SessionRun {
  location: string;
  image: string;
  id?: string;
  env?: Record<string, string>;
  args?: string[];
  labels?: Record<string, string>;
  restart?: boolean;
  version?: string;
  ttl?: string;
}

export interface SessionRunOk {
  id: string;
  host?: string;
  ports: Port[];
  connectionString?: string; // "host:port" for the primary game port
}

export interface SessionListEntry {
  id: string;
  location: string;
  image: string;
  version?: string;
  status: SessionStatus;
  playerCount: number;
  labels?: Record<string, string>;
  createdAt: string;
  host?: string;
  ports: Port[];
  connectionString?: string;
}

export interface SessionListOk {
  items: SessionListEntry[];
}

export interface DescribedSessionPlayers {
  count: number;
  ids?: string[];
}

export interface DescribedSession {
  id: string;
  location: string;
  image: string;
  version?: string;
  status: SessionStatus;
  players: DescribedSessionPlayers;
  ports: Port[];
  labels?: Record<string, string>;
  createdAt: string;
  host?: string;
  connectionString?: string;
}

// ─── Players ──────────────────────────────────────────────────────────────────

export interface JoinSession {
  session: string;
  players: string[];
}

/** Server response: the session's player count and IDs after the call. */
export interface JoinSessionOk {
  count: number;
  players: string[];
}

export type LeaveSession = JoinSession;
export type LeaveSessionOk = JoinSessionOk;

// ─── Locations ────────────────────────────────────────────────────────────────

export interface AvailableLocationsEntry {
  location: string;
  pingIps?: string[];
}

export interface AvailableLocationsOk {
  items: AvailableLocationsEntry[];
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

export interface TagOk {
  region: string;
  image: string;
  version: string;
  exists: boolean;
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

export interface LogsRequest {
  id: string;
}

// ─── Artifacts ────────────────────────────────────────────────────────────────

export interface ArtifactsRequest {
  session: string;
  /** Absolute path inside the container to export (file or directory). */
  path: string;
}

// ─── Regions ──────────────────────────────────────────────────────────────────

export interface RegionsOk {
  regions: string[];
}

// ─── Applications ─────────────────────────────────────────────────────────────

/** CPU in cores, RAM in MB, GPU count. */
export interface Resources {
  cpu: number;
  ram: number;
  gpu?: number;
}

export interface PortBinding {
  requested: number;
  protocol: PortProtocol;
  tls: boolean;
}

export type NetworkMode = "host" | "bridge";

export interface Application {
  name: string;
  repository: string;
  tagKeep: number;
  networkMode: string;
  limits: Resources;
  reservation: Resources;
  registry?: string;
  nodePool?: string;
  regions: string[];
  ports: PortBinding[];
}

export interface ApplicationsOk {
  items: Application[];
}

export interface CreateApplication {
  name: string;
  registry: string;
  repository: string;
  tagKeep: number;
  networkMode: NetworkMode;
  limits: Resources;
  reservation: Resources;
  nodePool: string;
  regions: string[];
  ports: PortBinding[];
}

/** Every field is optional; the server leaves omitted fields unchanged. */
export type EditApplication = Partial<Omit<CreateApplication, "name">>;

export interface RegistryTagsOk {
  versions: string[];
}

// ─── Tokens ───────────────────────────────────────────────────────────────────

export interface CreateTokenRequest {
  name: string;
  scopes: string[];
  expires_after?: string;
}

// ─── Client config ────────────────────────────────────────────────────────────

export interface GameyeClientConfig {
  token: string;
  baseUrl: string;
  /** Default per-request timeout in milliseconds. Logs and artifacts get at least 60s and 120s. */
  timeoutMs?: number;
}
