import { describe, it, expect, vi, afterEach } from "vitest";
import { ConfigError, DEFAULT_LIMITS, KNOWN_HOSTS, loadConfigOrExit, resolveConfig, resultPrefix } from "../../src/env.js";

const TOKEN = "tok-test";

function expectConfigError(env: Record<string, string | undefined>, match: RegExp) {
  let err: unknown;
  try {
    resolveConfig(env);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConfigError);
  expect((err as Error).message).toMatch(match);
  expect((err as Error).message).not.toContain(TOKEN);
}

describe("resolveConfig", () => {
  it("defaults to sandbox when GAMEYE_ENV is unset", () => {
    const c = resolveConfig({ GAMEYE_API_TOKEN: TOKEN });
    expect(c).toEqual({
      environment: "sandbox",
      baseUrl: KNOWN_HOSTS.sandbox,
      host: "api.sandbox-gameye.gameye.net",
      token: TOKEN,
      timeoutMs: 30_000,
      limits: DEFAULT_LIMITS,
    });
  });

  it("treats an empty GAMEYE_ENV as unset", () => {
    expect(resolveConfig({ GAMEYE_API_TOKEN: TOKEN, GAMEYE_ENV: "" }).environment).toBe("sandbox");
  });

  it("targets the production host with GAMEYE_ENV=production", () => {
    const c = resolveConfig({ GAMEYE_API_TOKEN: TOKEN, GAMEYE_ENV: "production" });
    expect(c.environment).toBe("production");
    expect(c.baseUrl).toBe("https://api.production-gameye.gameye.net");
    expect(resultPrefix(c)).toBe("[production · api.production-gameye.gameye.net]");
  });

  it("requires GAMEYE_API_TOKEN", () => {
    expectConfigError({}, /GAMEYE_API_TOKEN is required/);
    expectConfigError({ GAMEYE_API_TOKEN: "   " }, /GAMEYE_API_TOKEN is required/);
  });

  it.each(["prod", "staging", "Production", "live"])("rejects invalid GAMEYE_ENV=%s with a clear message", (v) => {
    expectConfigError({ GAMEYE_API_TOKEN: TOKEN, GAMEYE_ENV: v }, /GAMEYE_ENV must be one of: sandbox, production/);
  });

  it("refuses the production URL when GAMEYE_ENV is unset", () => {
    expectConfigError(
      { GAMEYE_API_TOKEN: TOKEN, GAMEYE_API_URL: KNOWN_HOSTS.production },
      /points at the production host but GAMEYE_ENV is unset/
    );
  });

  it.each([
    ["a trailing dot", "https://api.production-gameye.gameye.net."],
    ["a trailing dot and slash", "https://api.production-gameye.gameye.net./"],
    ["an uppercase host", "https://API.Production-Gameye.Gameye.NET"],
    ["an explicit :443 port", "https://api.production-gameye.gameye.net:443"],
  ])("refuses the production host written with %s when GAMEYE_ENV is unset", (_what, url) => {
    expectConfigError(
      { GAMEYE_API_TOKEN: TOKEN, GAMEYE_API_URL: url },
      /points at the production host but GAMEYE_ENV is unset/
    );
  });

  it("normalizes a trailing-dot production host to the canonical base URL when GAMEYE_ENV=production", () => {
    const c = resolveConfig({
      GAMEYE_API_TOKEN: TOKEN,
      GAMEYE_ENV: "production",
      GAMEYE_API_URL: "https://api.production-gameye.gameye.net.",
    });
    expect(c.environment).toBe("production");
    expect(c.baseUrl).toBe(KNOWN_HOSTS.production);
    expect(c.host).toBe("api.production-gameye.gameye.net");
  });

  it("treats a known hostname on a non-443 port as custom, not as the known tier", () => {
    const c = resolveConfig({ GAMEYE_API_TOKEN: TOKEN, GAMEYE_API_URL: "https://api.sandbox-gameye.gameye.net:8443" });
    expect(c.environment).toBe("custom");
  });

  it("refuses the sandbox URL when GAMEYE_ENV=production", () => {
    expectConfigError(
      { GAMEYE_API_TOKEN: TOKEN, GAMEYE_ENV: "production", GAMEYE_API_URL: KNOWN_HOSTS.sandbox },
      /points at the sandbox host but GAMEYE_ENV is production/
    );
  });

  it("accepts a known host that matches GAMEYE_ENV, with or without a trailing slash", () => {
    const c = resolveConfig({
      GAMEYE_API_TOKEN: TOKEN,
      GAMEYE_ENV: "production",
      GAMEYE_API_URL: `${KNOWN_HOSTS.production}/`,
    });
    expect(c.environment).toBe("production");
    expect(c.baseUrl).toBe(KNOWN_HOSTS.production);
    expect(resolveConfig({ GAMEYE_API_TOKEN: TOKEN, GAMEYE_API_URL: KNOWN_HOSTS.sandbox }).environment).toBe("sandbox");
  });

  it("labels a non-standard https URL as custom", () => {
    const c = resolveConfig({ GAMEYE_API_TOKEN: TOKEN, GAMEYE_API_URL: "https://gameye.example.test:8443/api/" });
    expect(c.environment).toBe("custom");
    expect(c.baseUrl).toBe("https://gameye.example.test:8443/api");
    expect(c.host).toBe("gameye.example.test:8443");
    expect(resultPrefix(c)).toBe("[custom · gameye.example.test:8443]");
  });

  it("refuses a plain-http URL, including for a known host", () => {
    expectConfigError({ GAMEYE_API_TOKEN: TOKEN, GAMEYE_API_URL: "http://localhost:8080" }, /must use https/);
    expectConfigError(
      { GAMEYE_API_TOKEN: TOKEN, GAMEYE_API_URL: "http://api.sandbox-gameye.gameye.net" },
      /must use https/
    );
  });

  it("refuses an unparseable URL", () => {
    expectConfigError({ GAMEYE_API_TOKEN: TOKEN, GAMEYE_API_URL: "not a url" }, /not a valid URL/);
  });

  it("reads GAMEYE_TIMEOUT_MS as the default request timeout", () => {
    expect(resolveConfig({ GAMEYE_API_TOKEN: TOKEN, GAMEYE_TIMEOUT_MS: "5000" }).timeoutMs).toBe(5000);
    expect(resolveConfig({ GAMEYE_API_TOKEN: TOKEN, GAMEYE_TIMEOUT_MS: " " }).timeoutMs).toBe(30_000);
  });

  it.each(["0", "-5", "1.5", "abc", "30s", "1e4"])("refuses GAMEYE_TIMEOUT_MS=%s", (v) => {
    expectConfigError({ GAMEYE_API_TOKEN: TOKEN, GAMEYE_TIMEOUT_MS: v }, /GAMEYE_TIMEOUT_MS must be a positive whole number of milliseconds/);
  });

  it("refuses the removed GAMEYE_API_ENDPOINT variable instead of silently ignoring it", () => {
    expectConfigError(
      { GAMEYE_API_TOKEN: TOKEN, GAMEYE_API_ENDPOINT: KNOWN_HOSTS.production },
      /GAMEYE_API_ENDPOINT is no longer supported/
    );
  });
});

describe("loadConfigOrExit", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints a clear message to stderr and exits 1 on invalid config", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => loadConfigOrExit({ GAMEYE_API_TOKEN: TOKEN, GAMEYE_ENV: "prod" })).toThrow("exit 1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(err.mock.calls[0][0])).toMatch(/configuration error: GAMEYE_ENV must be one of/);
  });

  it("exits 1 when the token is missing", () => {
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => loadConfigOrExit({})).toThrow("exit 1");
    expect(String(err.mock.calls[0][0])).toContain("GAMEYE_API_TOKEN is required");
  });

  it("returns the resolved config when valid", () => {
    expect(loadConfigOrExit({ GAMEYE_API_TOKEN: TOKEN }).environment).toBe("sandbox");
  });
});

describe("session limits", () => {
  const limits = (env: Record<string, string>) => resolveConfig({ GAMEYE_API_TOKEN: TOKEN, ...env }).limits;

  it("defaults to 5 running, 4h TTL, 20 launches and stop-any", () => {
    expect(limits({})).toEqual({ maxSessions: 5, maxTtl: "4h", maxTtlMs: 14_400_000, maxLaunches: 20, stopOwnOnly: false });
  });

  it("reads each limit from the environment", () => {
    expect(limits({ GAMEYE_MAX_SESSIONS: "2", GAMEYE_MAX_TTL: "90m", GAMEYE_MAX_LAUNCHES: "8", GAMEYE_STOP_OWN_ONLY: "1" })).toEqual({
      maxSessions: 2, maxTtl: "90m", maxTtlMs: 5_400_000, maxLaunches: 8, stopOwnOnly: true,
    });
  });

  it.each([
    ["GAMEYE_MAX_SESSIONS", "0"],
    ["GAMEYE_MAX_SESSIONS", "-1"],
    ["GAMEYE_MAX_SESSIONS", "two"],
    ["GAMEYE_MAX_LAUNCHES", "1.5"],
    ["GAMEYE_MAX_TTL", "10m"],
    ["GAMEYE_MAX_TTL", "0"],
    ["GAMEYE_MAX_TTL", "forever"],
    ["GAMEYE_STOP_OWN_ONLY", "yes"],
  ])("rejects %s=%s", (name, value) => {
    expect(() => limits({ [name]: value })).toThrow(ConfigError);
    expect(() => limits({ [name]: value })).toThrow(name);
  });
});
