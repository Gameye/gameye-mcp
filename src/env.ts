// Server-level environment resolution.
//
// The Gameye environment is a property of the server process, never of a
// single tool call: an agent cannot switch to production mid-conversation.
// Users who need both environments run two named server entries.

export const KNOWN_HOSTS = {
  sandbox: "https://api.sandbox-gameye.gameye.net",
  production: "https://api.production-gameye.gameye.net",
} as const;

export type Tier = keyof typeof KNOWN_HOSTS;

/** The label shown in every tool result. `custom` means a non-standard GAMEYE_API_URL. */
export type EnvironmentLabel = Tier | "custom";

export interface ResolvedConfig {
  /** Effective environment, derived from the resolved host. */
  environment: EnvironmentLabel;
  /** Base URL requests are sent to, without a trailing slash. */
  baseUrl: string;
  /** Hostname only, for display. */
  host: string;
  /** API token. Never print or return this. */
  token: string;
  /** Default per-request timeout in milliseconds (GAMEYE_TIMEOUT_MS, default 30s). */
  timeoutMs: number;
}

/** Per-request timeout used when GAMEYE_TIMEOUT_MS is not set. */
export const DEFAULT_TIMEOUT_MS = 30_000;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const TIERS = Object.keys(KNOWN_HOSTS) as Tier[];

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseTimeoutMs(raw: string | undefined): number {
  const value = nonEmpty(raw);
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const ms = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new ConfigError(
      `GAMEYE_TIMEOUT_MS must be a positive whole number of milliseconds (got "${value}"). Leave it unset for ${DEFAULT_TIMEOUT_MS / 1000}s.`
    );
  }
  return ms;
}

/** Lowercase a hostname and drop a trailing root dot (`example.com.` is the same host as `example.com`). */
function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

/**
 * The known tier a URL points at, if any. Matches on the normalized hostname
 * on the default https port, so `https://api.production-gameye.gameye.net.`
 * or `...:443` cannot slip past the GAMEYE_ENV check as a "custom" host.
 */
function matchKnownTier(url: URL): Tier | undefined {
  if (url.port !== "" && url.port !== "443") return undefined;
  const hostname = normalizeHostname(url.hostname);
  return TIERS.find((t) => normalizeHostname(new URL(KNOWN_HOSTS[t]).hostname) === hostname);
}

/**
 * Resolve the server configuration from an environment object.
 * Pure: throws ConfigError on any invalid combination and never touches process state.
 */
export function resolveConfig(env: Record<string, string | undefined>): ResolvedConfig {
  const token = nonEmpty(env.GAMEYE_API_TOKEN);
  if (!token) {
    throw new ConfigError(
      "GAMEYE_API_TOKEN is required. Set it in your MCP server configuration:\n" +
        '  "env": { "GAMEYE_API_TOKEN": "<your token>" }'
    );
  }

  if (nonEmpty(env.GAMEYE_API_ENDPOINT)) {
    throw new ConfigError(
      "GAMEYE_API_ENDPOINT is no longer supported. Use GAMEYE_ENV=sandbox|production " +
        "(default sandbox), or GAMEYE_API_URL for a non-standard https host."
    );
  }

  const timeoutMs = parseTimeoutMs(env.GAMEYE_TIMEOUT_MS);

  const rawEnv = nonEmpty(env.GAMEYE_ENV);
  let tier: Tier = "sandbox";
  if (rawEnv !== undefined) {
    if (!(TIERS as string[]).includes(rawEnv)) {
      throw new ConfigError(
        `GAMEYE_ENV must be one of: ${TIERS.join(", ")} (got "${rawEnv}"). Leave it unset for sandbox.`
      );
    }
    tier = rawEnv as Tier;
  }

  const rawUrl = nonEmpty(env.GAMEYE_API_URL);
  if (rawUrl === undefined) {
    const baseUrl = KNOWN_HOSTS[tier];
    return { environment: tier, baseUrl, host: new URL(baseUrl).host, token, timeoutMs };
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError(`GAMEYE_API_URL is not a valid URL: "${rawUrl}"`);
  }

  if (url.protocol !== "https:") {
    throw new ConfigError(
      `GAMEYE_API_URL must use https (got "${url.protocol.replace(/:$/, "")}"). Plain http would send the API token unencrypted.`
    );
  }

  const knownTier = matchKnownTier(url);
  if (knownTier !== undefined) {
    if (knownTier !== tier) {
      throw new ConfigError(
        `GAMEYE_API_URL points at the ${knownTier} host but GAMEYE_ENV is ${rawEnv ?? "unset (sandbox)"}. ` +
          `Set GAMEYE_ENV=${knownTier} to use ${knownTier}, or remove GAMEYE_API_URL.`
      );
    }
    const baseUrl = KNOWN_HOSTS[knownTier];
    return { environment: knownTier, baseUrl, host: new URL(baseUrl).host, token, timeoutMs };
  }

  const baseUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  return { environment: "custom", baseUrl, host: url.host, token, timeoutMs };
}

/** Resolve from process.env, printing a clear message and exiting 1 on any error. */
export function loadConfigOrExit(env: Record<string, string | undefined> = process.env): ResolvedConfig {
  try {
    return resolveConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`gameye-mcp: configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

/** The line every tool result starts with, e.g. `[sandbox · api.sandbox-gameye.gameye.net]`. */
export function resultPrefix(config: { environment: EnvironmentLabel; host: string }): string {
  return `[${config.environment} · ${config.host}]`;
}
