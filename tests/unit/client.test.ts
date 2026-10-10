import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, open, rm } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { GameyeClient, GameyeError, GameyeTimeoutError, REDACTED, safeFileSegment } from "../../src/client.js";
import { capturedUrl } from "./helpers.js";
import { userAgent, VERSION } from "../../src/version.js";
import { createRequire } from "node:module";

const ARTIFACT_DIR = "/tmp/gameye-artifacts-TEST";

vi.mock("node:fs/promises", () => ({
  open: vi.fn().mockImplementation(async () => ({ write: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) })),
  mkdtemp: vi.fn().mockResolvedValue("/tmp/gameye-artifacts-TEST"),
  rm: vi.fn().mockResolvedValue(undefined),
}));

const BASE = "https://api.gameye.test";
const TOKEN = "test-token";

function makeClient() {
  return new GameyeClient({ token: TOKEN, baseUrl: BASE });
}

function mockFetch(body: unknown, status = 200) {
  const isText = typeof body === "string";
  const response = new Response(isText ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": isText ? "text/plain" : "application/json" },
  });
  const mock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(open).mockClear();
  vi.mocked(mkdtemp).mockClear();
  vi.mocked(rm).mockClear();
  vi.restoreAllMocks();
});

// ─── GameyeError ─────────────────────────────────────────────────────────────

describe("GameyeError", () => {
  it("formats basic error", () => {
    const err = new GameyeError(404, "NOT_FOUND", "Session not found");
    expect(err.toDisplayString()).toBe("Error 404: Session not found (NOT_FOUND)");
  });

  it("formats error with field violations", () => {
    const err = new GameyeError(400, "VALIDATION_ERROR", "Invalid input", [
      { field: "location", description: "must not be empty" },
      { field: "image", description: "required" },
    ]);
    const s = err.toDisplayString();
    expect(s).toContain("Field violations:");
    expect(s).toContain("- location: must not be empty");
    expect(s).toContain("- image: required");
  });

  it("omits violations section when empty", () => {
    const err = new GameyeError(500, "INTERNAL", "Server error", []);
    expect(err.toDisplayString()).not.toContain("Field violations:");
  });

  it("includes details and the trace identifier", () => {
    const err = new GameyeError(404, "not_found", "Unable to describe session.", [], {
      details: "Could not find session.",
      identifier: "trace-123",
    });
    const s = err.toDisplayString();
    expect(s).toContain("Details: Could not find session.");
    expect(s).toContain("Trace ID: trace-123");
  });

  it("surfaces the required scope for a 403", () => {
    const err = new GameyeError(403, "forbidden", "Forbidden request.", [], {
      details: "Token is missing required scope 'session:write'. Assigned scopes: [session:read]",
      identifier: "t-1",
    });
    expect(err.requiredScope).toBe("session:write");
    expect(err.toDisplayString()).toContain("Required scope: session:write");
  });

  it("has no required scope for a 403 without a scope in details, or for other statuses", () => {
    expect(new GameyeError(403, "forbidden", "Forbidden", [], { details: "nope" }).requiredScope).toBeUndefined();
    expect(
      new GameyeError(401, "x", "y", [], { details: "Token is missing required scope 'a:b'" }).requiredScope
    ).toBeUndefined();
  });
});

// ─── launchSession ────────────────────────────────────────────────────────────

describe("launchSession", () => {
  it("POSTs to /session with correct headers and body", async () => {
    const mock = mockFetch({ id: "sess-abc" });
    const result = await makeClient().launchSession({ location: "europe", image: "csgo" });

    expect(result.id).toBe("sess-abc");
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/session`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({ location: "europe", image: "csgo" });
  });

  it("includes optional fields when provided", async () => {
    const mock = mockFetch({ id: "s1" });
    await makeClient().launchSession({
      location: "eu", image: "csgo", version: "1.2.3", ttl: "1h",
      labels: { mode: "competitive" }, env: { PORT: "27015" },
    });
    const body = JSON.parse((mock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.version).toBe("1.2.3");
    expect(body.ttl).toBe("1h");
    expect(body.labels).toEqual({ mode: "competitive" });
  });

  it("throws GameyeError on 401", async () => {
    mockFetch({ code: "UNAUTHORIZED", message: "Unable to authorize" }, 401);
    await expect(makeClient().launchSession({ location: "eu", image: "csgo" }))
      .rejects.toBeInstanceOf(GameyeError);
  });
});

// ─── listSessions ─────────────────────────────────────────────────────────────

describe("listSessions", () => {
  it("GETs /session with no query params when called with no args", async () => {
    const mock = mockFetch({ sessions: [] });
    await makeClient().listSessions();
    const url = capturedUrl(mock);
    expect(url.pathname).toBe("/session");
    expect(url.searchParams.toString()).toBe("");
  });

  it("normalises sessions array and maps tag→version, created→createdAt", async () => {
    mockFetch({ sessions: [{ id: "s1", image: "csgo", tag: "1.0", location: "eu", status: "running", playerCount: 3, created: 1000000000000 }] });
    const result = await makeClient().listSessions();
    expect(result.items).toHaveLength(1);
    expect(result.items[0].version).toBe("1.0");
    expect(result.items[0].createdAt).toBe(new Date(1000000000000).toISOString());
  });

  it("sets location, image, tag, host params", async () => {
    const mock = mockFetch({ sessions: [] });
    await makeClient().listSessions({ location: "europe", image: "csgo", tag: "1.0", host: "10.0.0.1" });
    const url = capturedUrl(mock);
    expect(url.searchParams.get("location")).toBe("europe");
    expect(url.searchParams.get("image")).toBe("csgo");
    expect(url.searchParams.get("tag")).toBe("1.0");
    expect(url.searchParams.get("host")).toBe("10.0.0.1");
  });

  it("sets playerCount[lt] and playerCount[gt]", async () => {
    const mock = mockFetch({ sessions: [] });
    await makeClient().listSessions({ playerCountLt: 5, playerCountGt: 1 });
    const url = capturedUrl(mock);
    expect(url.searchParams.get("playerCount[lt]")).toBe("5");
    expect(url.searchParams.get("playerCount[gt]")).toBe("1");
  });

  it("serialises filter object as filter[key]=value", async () => {
    const mock = mockFetch({ sessions: [] });
    await makeClient().listSessions({ filter: { mode: "competitive", map: "de_dust2" } });
    const url = capturedUrl(mock);
    expect(url.searchParams.get("filter[mode]")).toBe("competitive");
    expect(url.searchParams.get("filter[map]")).toBe("de_dust2");
  });

  it("serialises filterNot object as filterNot[key]=value", async () => {
    const mock = mockFetch({ sessions: [] });
    await makeClient().listSessions({ filterNot: { mode: "casual" } });
    const url = capturedUrl(mock);
    expect(url.searchParams.get("filterNot[mode]")).toBe("casual");
    expect(url.searchParams.has("filter[mode]")).toBe(false);
  });

  it("normalises host, port map and connection string", async () => {
    mockFetch({ sessions: [{ id: "s1", image: "csgo", location: "eu", host: "1.2.3.4", status: "running", playerCount: 0, created: 0, port: { "27015/udp": 30000, "80/tcp": 8080 } }] });
    const [item] = (await makeClient().listSessions()).items;
    expect(item.host).toBe("1.2.3.4");
    expect(item.ports).toEqual([
      { type: "udp", container: 27015, host: 30000 },
      { type: "tcp", container: 80, host: 8080 },
    ]);
    expect(item.connectionString).toBe("1.2.3.4:30000");
  });

  it("never returns the value of the env label", async () => {
    mockFetch({ sessions: [{ id: "s1", image: "csgo", location: "eu", status: "running", playerCount: 0, created: 0, labels: { env: '{"SECRET":"hunter2"}', tags: '{"mode":"comp"}' } }] });
    const [item] = (await makeClient().listSessions()).items;
    expect(item.labels).toEqual({ env: REDACTED, tags: '{"mode":"comp"}' });
    expect(JSON.stringify(item)).not.toContain("hunter2");
  });

  it("sets all=true when requested", async () => {
    const mock = mockFetch({ sessions: [] });
    await makeClient().listSessions({ all: true });
    const url = capturedUrl(mock);
    expect(url.searchParams.get("all")).toBe("true");
  });
});

// ─── describeSession ──────────────────────────────────────────────────────────

const RAW_SESSION = { id: "s1", image: "csgo", tag: "1.0", location: "eu", host: "1.2.3.4", status: "running", created: 1000000000000, port: { "80/tcp": 8080 }, labels: {}, players: { joined: [], joinedCount: 0 } };

describe("describeSession", () => {
  it("GETs /session/:id with URL encoding", async () => {
    const mock = mockFetch({ ...RAW_SESSION, id: "my id" });
    await makeClient().describeSession("my id");
    const [url] = mock.mock.calls[0] as [string];
    expect(url).toContain("/session/my%20id");
  });

  it("sends Authorization header", async () => {
    const mock = mockFetch(RAW_SESSION);
    await makeClient().describeSession("s1");
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("normalises port object → ports array and players shape", async () => {
    mockFetch({ ...RAW_SESSION, port: { "27015/udp": 30000 }, players: { joined: ["p1"], joinedCount: 1 } });
    const result = await makeClient().describeSession("s1");
    expect(result.ports).toEqual([{ type: "udp", container: 27015, host: 30000 }]);
    expect(result.players).toEqual({ count: 1, ids: ["p1"] });
  });

  it("does not invent env, restart, ttl, args or updatedAt fields", async () => {
    mockFetch({ ...RAW_SESSION, restart: true, ttl: "1h", args: ["-x"], env: { A: "b" } });
    const result = await makeClient().describeSession("s1");
    for (const key of ["env", "restart", "ttl", "args", "updatedAt"]) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it("never returns the value of the env label", async () => {
    mockFetch({ ...RAW_SESSION, labels: { env: '{"TOKEN":"hunter2"}' } });
    const result = await makeClient().describeSession("s1");
    expect(result.labels?.env).toBe(REDACTED);
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });
});

// ─── stopSession ──────────────────────────────────────────────────────────────

describe("stopSession", () => {
  it("DELETEs /session/:id", async () => {
    const mock = mockFetch("", 200);
    await makeClient().stopSession("sess-1");
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/session/sess-1`);
    expect(init.method).toBe("DELETE");
  });

  it("resolves without a value on success", async () => {
    mockFetch("", 200);
    await expect(makeClient().stopSession("s1")).resolves.toBeUndefined();
  });
});

// ─── playerJoin ───────────────────────────────────────────────────────────────

describe("playerJoin", () => {
  it("PUTs to /session/player/join with {session, players[]} body", async () => {
    const mock = mockFetch({ count: 2, players: ["a", "b"] });
    await makeClient().playerJoin({ session: "s1", players: ["a", "b"] });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/session/player/join`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ session: "s1", players: ["a", "b"] });
  });

  it("returns the server's count and player list", async () => {
    mockFetch({ count: 3, players: ["a", "b", "c"] });
    const result = await makeClient().playerJoin({ session: "s1", players: ["c"] });
    expect(result).toEqual({ count: 3, players: ["a", "b", "c"] });
  });
});

// ─── playerLeave ──────────────────────────────────────────────────────────────

describe("playerLeave", () => {
  it("DELETEs /session/player/leave with {session, players[]} body", async () => {
    const mock = mockFetch({ count: 0, players: [] });
    await makeClient().playerLeave({ session: "s1", players: ["p1"] });
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/session/player/leave`);
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ session: "s1", players: ["p1"] });
  });

  it("returns the server's count, normalising null players to []", async () => {
    mockFetch({ count: 0, players: null });
    const result = await makeClient().playerLeave({ session: "s1", players: ["p1"] });
    expect(result).toEqual({ count: 0, players: [] });
  });

  it("throws GameyeError with details when the session is not found", async () => {
    mockFetch({ statusCode: 404, code: "not_found", message: "Unable to join session.", details: "Could not find session.", identifier: "tr-9" }, 404);
    const err = await makeClient().playerLeave({ session: "x", players: ["p"] }).catch((e) => e);
    expect(err).toBeInstanceOf(GameyeError);
    expect(err.details).toBe("Could not find session.");
    expect(err.identifier).toBe("tr-9");
  });
});

// ─── getAvailableLocations ────────────────────────────────────────────────────

describe("getAvailableLocations", () => {
  it("GETs /available-location/:image with URL encoding", async () => {
    const mock = mockFetch({ locations: [] });
    await makeClient().getAvailableLocations("my image");
    const [url] = mock.mock.calls[0] as [string];
    expect(url).toBe(`${BASE}/available-location/my%20image`);
  });

  it("normalises locations array: id→location, ips→pingIps", async () => {
    mockFetch({ locations: [{ id: "europe", ips: ["1.2.3.4"] }, { id: "us-east-1" }] });
    const result = await makeClient().getAvailableLocations("csgo");
    expect(result.items).toEqual([
      { location: "europe", pingIps: ["1.2.3.4"] },
      { location: "us-east-1", pingIps: undefined },
    ]);
  });
});

// ─── checkTag ─────────────────────────────────────────────────────────────────

describe("checkTag", () => {
  it("GETs /tag/:region/:image/:version", async () => {
    const mock = mockFetch({ exists: true });
    await makeClient().checkTag("europe", "csgo", "1.0");
    const [url] = mock.mock.calls[0] as [string];
    expect(url).toBe(`${BASE}/tag/europe/csgo/1.0`);
  });

  it("URL-encodes path segments", async () => {
    const mock = mockFetch({ exists: false });
    await makeClient().checkTag("us east", "my game", "1.0");
    const [url] = mock.mock.calls[0] as [string];
    expect(url).toContain("us%20east");
    expect(url).toContain("my%20game");
  });

  it("supplements response with call args for region/image/version", async () => {
    mockFetch({ exists: true });
    const result = await makeClient().checkTag("europe", "csgo", "2.0");
    expect(result).toEqual({ region: "europe", image: "csgo", version: "2.0", exists: true });
  });
});

// ─── getLogs ──────────────────────────────────────────────────────────────────

describe("getLogs", () => {
  it("GETs /logs with id param and Accept: text/plain", async () => {
    const mock = mockFetch("log line 1\nlog line 2");
    const result = await makeClient().getLogs({ id: "sess-1" });
    expect(result).toBe("log line 1\nlog line 2");
    const url = capturedUrl(mock);
    const [, init] = mock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/logs");
    expect(url.searchParams.get("id")).toBe("sess-1");
    expect((init.headers as Record<string, string>)["Accept"]).toBe("text/plain");
  });

  it("always sends follow=false, because the server streams by default", async () => {
    const mock = mockFetch("logs");
    await makeClient().getLogs({ id: "s1" });
    expect(capturedUrl(mock).searchParams.get("follow")).toBe("false");
  });

  it("throws GameyeError on non-ok response", async () => {
    mockFetch({ code: "NOT_FOUND", message: "Session not found" }, 404);
    await expect(makeClient().getLogs({ id: "x" })).rejects.toBeInstanceOf(GameyeError);
  });
});

// ─── getArtifacts ─────────────────────────────────────────────────────────────

describe("getArtifacts", () => {
  function stubTar() {
    const mock = vi.fn().mockImplementation(async () => new Response(new ArrayBuffer(8), { status: 200 }));
    vi.stubGlobal("fetch", mock);
    return mock;
  }

  it("sends session and path query params", async () => {
    const mock = stubTar();
    await makeClient().getArtifacts({ session: "sess-1", path: "/app/logs" });
    const url = capturedUrl(mock);
    expect(url.pathname).toBe("/artifacts");
    expect(url.searchParams.get("session")).toBe("sess-1");
    expect(url.searchParams.get("path")).toBe("/app/logs");
    expect(url.searchParams.has("id")).toBe(false);
  });

  it("saves an uncompressed .tar (the server streams docker cp output) in a fresh private dir", async () => {
    stubTar();
    const path = await makeClient().getArtifacts({ session: "sess-1", path: "/app/logs" });
    expect(path).toBe(`${ARTIFACT_DIR}/gameye-artifact-sess-1.tar`);
    expect(vi.mocked(mkdtemp)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(open)).toHaveBeenCalledWith(path, "wx", 0o600);
    const handle = await vi.mocked(open).mock.results[0].value;
    expect(handle.write).toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledTimes(1);
  });

  it("cannot write outside the target directory for a session ID with / or ..", async () => {
    stubTar();
    for (const session of ["../../etc/passwd", "a/b/c", "..", "/abs", "..\\win", "...", ""]) {
      const out = await makeClient().getArtifacts({ session, path: "/x" });
      expect(dirname(out)).toBe(ARTIFACT_DIR);
      expect(basename(out)).not.toMatch(/[\/\\]/);
      expect(basename(out)).not.toContain("..");
      expect(basename(out).startsWith("gameye-artifact-")).toBe(true);
    }
  });

  it("safeFileSegment strips separators and leading dots", () => {
    expect(safeFileSegment("../../etc/passwd")).toBe("____etc_passwd");
    expect(safeFileSegment("..")).toBe("_");
    expect(safeFileSegment("")).toBe("_");
    expect(safeFileSegment("ok-id_1.2")).toBe("ok-id_1.2");
    expect(safeFileSegment("x".repeat(500))).toHaveLength(128);
  });

  it("sends the session ID in the query string, URL-encoded", async () => {
    const mock = stubTar();
    await makeClient().getArtifacts({ session: "a/../b", path: "/app/my logs" });
    const url = capturedUrl(mock);
    expect(url.searchParams.get("session")).toBe("a/../b");
    expect(url.searchParams.get("path")).toBe("/app/my logs");
  });

  it("throws GameyeError on non-ok response", async () => {
    mockFetch({ code: "NOT_FOUND", message: "No artifacts" }, 404);
    await expect(makeClient().getArtifacts({ session: "x", path: "/x" })).rejects.toBeInstanceOf(GameyeError);
  });
});

// ─── Error handling ───────────────────────────────────────────────────────────

describe("error handling", () => {
  it("parses error body into GameyeError fields", async () => {
    mockFetch({ code: "NOT_FOUND", message: "Session not found", violations: [] }, 404);
    const err = await makeClient().describeSession("x").catch((e) => e);
    expect(err).toBeInstanceOf(GameyeError);
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("Session not found");
  });

  it("falls back to defaults when error body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("plain text error", { status: 503, headers: { "Content-Type": "text/plain" } })
    ));
    const err = await makeClient().describeSession("x").catch((e) => e);
    expect(err).toBeInstanceOf(GameyeError);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("UNKNOWN_ERROR");
  });

  it("trims trailing slash from baseUrl", async () => {
    const mock = mockFetch({ id: "s1" }); // launchSession returns { id }
    const client = new GameyeClient({ token: TOKEN, baseUrl: `${BASE}/` });
    await client.launchSession({ location: "eu", image: "csgo" });
    const [url] = mock.mock.calls[0] as [string];
    expect(url).toBe(`${BASE}/session`); // no double slash
  });

  it("parses details and identifier from the error body", async () => {
    mockFetch({ statusCode: 403, code: "forbidden", message: "Forbidden request.", details: "Token is missing required scope 'session:read'. Assigned scopes: []", path: "/session", identifier: "abc", timestamp: "now" }, 403);
    const err = await makeClient().listSessions().catch((e) => e);
    expect(err).toBeInstanceOf(GameyeError);
    expect(err.requiredScope).toBe("session:read");
    expect(err.identifier).toBe("abc");
  });
});

// ─── Timeouts ─────────────────────────────────────────────────────────────────

/** A fetch that never answers, and rejects only when its signal aborts. */
function hangingFetch() {
  const mock = vi.fn().mockImplementation(
    (_url: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) return; // would hang forever: the test times out
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("timeouts", () => {
  it("aborts a stalled request and says which host timed out after how long", async () => {
    hangingFetch();
    const client = new GameyeClient({ token: TOKEN, baseUrl: BASE, timeoutMs: 20 });
    const err = await client.describeSession("s1").catch((e) => e);
    expect(err).toBeInstanceOf(GameyeTimeoutError);
    expect(err.message).toBe("Request to api.gameye.test timed out after 0.02s");
    expect(err.message).not.toContain(TOKEN);
  });

  it("passes a timeout signal on every request", async () => {
    const mock = vi.fn().mockImplementation(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", mock);
    const c = makeClient();
    await c.launchSession({ location: "eu", image: "x" });
    await c.listSessions({ location: "eu" });
    await c.describeSession("s1").catch(() => undefined);
    await c.stopSession("s1");
    await c.playerJoin({ session: "s1", players: ["a"] });
    await c.playerLeave({ session: "s1", players: ["a"] });
    await c.getAvailableLocations("img");
    await c.checkTag("eu", "img", "1");
    await c.listRegions();
    await c.listApplications();
    await c.listRegistryTags("app");
    await c.enableTag("app", "1");
    await c.createApplication({} as never);
    await c.editApplication("app", {});
    await c.createToken({ name: "n", scopes: ["s"], expires_after: "1h" }).catch(() => undefined);
    await c.getLogs({ id: "s1" });
    await c.getArtifacts({ session: "s1", path: "/x" });
    expect(mock.mock.calls.length).toBe(17);
    for (const [, init] of mock.mock.calls as Array<[unknown, RequestInit]>) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("uses 30s by default, 60s for logs and 120s for artifacts", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("{}", { status: 200 })));
    const c = makeClient();
    await c.listRegions();
    await c.getLogs({ id: "s1" });
    await c.getArtifacts({ session: "s1", path: "/x" });
    expect(spy.mock.calls.map((a) => a[0])).toEqual([30_000, 60_000, 120_000]);
  });

  it("a larger configured default also raises the logs and artifacts timeouts", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("{}", { status: 200 })));
    const c = new GameyeClient({ token: TOKEN, baseUrl: BASE, timeoutMs: 300_000 });
    await c.listRegions();
    await c.getLogs({ id: "s1" });
    await c.getArtifacts({ session: "s1", path: "/x" });
    expect(spy.mock.calls.map((a) => a[0])).toEqual([300_000, 300_000, 300_000]);
  });

  it("a mid-stream artifact failure closes the file and removes the temp directory", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) controller.enqueue(new Uint8Array([1, 2, 3]));
        else controller.error(new Error("connection reset"));
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const err = await makeClient().getArtifacts({ session: "s1", path: "/x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toContain("connection reset");
    const handle = await vi.mocked(open).mock.results[0].value;
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rm)).toHaveBeenCalledWith(ARTIFACT_DIR, { recursive: true, force: true });
  });

  it("an artifact download that times out mid-stream removes the temp directory and reports the timeout", async () => {
    const mock = vi.fn().mockImplementation(async (_url: unknown, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
        },
      });
      return new Response(body, { status: 200 });
    });
    vi.stubGlobal("fetch", mock);
    const c = new GameyeClient({ token: TOKEN, baseUrl: BASE, timeoutMs: 20 });
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(new DOMException("The operation timed out.", "TimeoutError")), 20);
      return ac.signal;
    });
    const err = await c.getArtifacts({ session: "s1", path: "/x" }).catch((e) => e);
    expect(err).toBeInstanceOf(GameyeTimeoutError);
    expect(err.message).toMatch(/^Request to api\.gameye\.test timed out after 120s$/);
    expect(vi.mocked(rm)).toHaveBeenCalledWith(ARTIFACT_DIR, { recursive: true, force: true });
  });
});

// ─── User-Agent attribution ──────────────────────────────────────────────────

describe("User-Agent", () => {
  const { version: PKG_VERSION } = createRequire(import.meta.url)("../../package.json") as { version: string };
  const sentHeaders = (mock: ReturnType<typeof vi.fn>) =>
    (mock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;

  it("reads the version from package.json", () => {
    expect(VERSION).toBe(PKG_VERSION);
    expect(userAgent()).toBe(`gameye-mcp/${PKG_VERSION}`);
  });

  it("is sent on a GET alongside the existing headers", async () => {
    const mock = mockFetch({ regions: ["eu"] });
    await makeClient().listRegions();
    const h = sentHeaders(mock);
    expect(h["User-Agent"]).toBe(`gameye-mcp/${PKG_VERSION}`);
    expect(h["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(h["Accept"]).toBe("application/json");
  });

  it("is sent on a POST alongside the existing headers", async () => {
    const mock = mockFetch({ id: "s1" });
    await makeClient().launchSession({ id: "s1", location: "eu", image: "img", version: "1" });
    const h = sentHeaders(mock);
    expect((mock.mock.calls[0] as [string, RequestInit])[1].method).toBe("POST");
    expect(h["User-Agent"]).toBe(`gameye-mcp/${PKG_VERSION}`);
    expect(h["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(h["Content-Type"]).toBe("application/json");
  });

  it("is sent on log and artifact downloads", async () => {
    const logs = mockFetch("line");
    await makeClient().getLogs({ id: "s1" });
    expect(sentHeaders(logs)["User-Agent"]).toBe(`gameye-mcp/${PKG_VERSION}`);
    expect(sentHeaders(logs)["Accept"]).toBe("text/plain");

    const artifacts = mockFetch("tar");
    await makeClient().getArtifacts({ session: "s1", path: "/tmp" });
    expect(sentHeaders(artifacts)["User-Agent"]).toBe(`gameye-mcp/${PKG_VERSION}`);
    expect(sentHeaders(artifacts)["Accept"]).toBe("application/octet-stream");
  });

  it("appends the MCP client name once known", async () => {
    const client = makeClient();
    client.setClientName("claude-code");
    const mock = mockFetch({ regions: [] });
    await client.listRegions();
    expect(sentHeaders(mock)["User-Agent"]).toBe(`gameye-mcp/${PKG_VERSION} (claude-code)`);
  });

  it("strips unsafe characters from the client name and ignores an empty one", () => {
    expect(userAgent("evil\r\nX-Injected: 1")).toBe(`gameye-mcp/${PKG_VERSION} (evilX-Injected1)`);
    expect(userAgent("  ")).toBe(`gameye-mcp/${PKG_VERSION}`);
    expect(userAgent(undefined)).toBe(`gameye-mcp/${PKG_VERSION}`);
  });

  it("never contains the token", async () => {
    const mock = mockFetch({ regions: [] });
    await makeClient().listRegions();
    expect(sentHeaders(mock)["User-Agent"]).not.toContain(TOKEN);
  });
});
