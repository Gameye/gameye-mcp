import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GameyeClient, GameyeError } from "../../src/client.js";
import { registerSessionTools } from "../../src/tools/sessions.js";
import { makeMockServer, makeMockClient, makeContext, getText, capturedUrl, SANDBOX_PREFIX } from "./helpers.js";

let handlers: ReturnType<typeof makeMockServer>["handlers"];
let configs: ReturnType<typeof makeMockServer>["configs"];
let client: ReturnType<typeof makeMockClient>;

beforeEach(() => {
  client = makeMockClient();
  const mock = makeMockServer();
  registerSessionTools(mock.server, client as never, makeContext());
  handlers = mock.handlers;
  configs = mock.configs;
});

afterEach(() => vi.unstubAllGlobals());

// ─── registration ─────────────────────────────────────────────────────────────

describe("session tool registration", () => {
  it("annotates reads as read-only and stop as destructive", () => {
    expect(configs["gameye_list_sessions"].annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(configs["gameye_describe_session"].annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(configs["gameye_stop_session"].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(configs["gameye_launch_session"].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
  });

  it("list description states filter semantics and the running-only default", () => {
    const d = configs["gameye_list_sessions"].description ?? "";
    expect(d).toMatch(/filter and filterNot match user labels only/);
    expect(d).toMatch(/only running sessions/);
    expect(d).toMatch(/all=true/);
  });
});

// ─── gameye_launch_session ────────────────────────────────────────────────────

describe("gameye_launch_session", () => {
  it("returns session ID on success, prefixed with environment and host", async () => {
    client.launchSession.mockResolvedValue({ id: "abc-123", ports: [] });
    const result = await handlers["gameye_launch_session"]({ location: "eu", image: "csgo" });
    expect(getText(result).split("\n")[0]).toBe(SANDBOX_PREFIX);
    expect(getText(result)).toContain("abc-123");
    expect(getText(result)).toContain("Session launched successfully");
    expect(result.isError).toBeUndefined();
  });

  it("calls client with all provided args", async () => {
    client.launchSession.mockResolvedValue({ id: "x", ports: [] });
    await handlers["gameye_launch_session"]({
      location: "eu", image: "csgo", version: "1.0", ttl: "30m",
      labels: { mode: "comp" }, env: { PORT: "27015" }, restart: false,
    });
    expect(client.launchSession).toHaveBeenCalledWith(expect.objectContaining({
      location: "eu", image: "csgo", version: "1.0", ttl: "30m",
    }));
  });

  it("does not echo launch env values", async () => {
    client.launchSession.mockResolvedValue({ id: "x", ports: [] });
    const text = getText(await handlers["gameye_launch_session"]({ location: "eu", image: "csgo", env: { SECRET: "hunter2" } }));
    expect(text).not.toContain("hunter2");
  });

  it("returns GameyeError as isError with details and trace id", async () => {
    client.launchSession.mockRejectedValue(
      new GameyeError(400, "bad_request", "Bad location", [], { details: "Unknown location.", identifier: "tr-1" })
    );
    const result = await handlers["gameye_launch_session"]({ location: "", image: "csgo" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain(SANDBOX_PREFIX);
    expect(getText(result)).toContain("Error 400");
    expect(getText(result)).toContain("Details: Unknown location.");
    expect(getText(result)).toContain("Trace ID: tr-1");
  });

  it("returns non-Gameye errors as isError instead of throwing", async () => {
    client.launchSession.mockRejectedValue(new Error("network failure"));
    const result = await handlers["gameye_launch_session"]({ location: "eu", image: "csgo" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("network failure");
  });
});

// ─── gameye_list_sessions ─────────────────────────────────────────────────────

describe("gameye_list_sessions", () => {
  it("returns empty message mentioning all=true when no running sessions found", async () => {
    client.listSessions.mockResolvedValue({ items: [] });
    const text = getText(await handlers["gameye_list_sessions"]({}));
    expect(text).toContain("No running sessions found");
    expect(text).toContain("all=true");
  });

  it("lists sessions with count, host, ports and connection string", async () => {
    client.listSessions.mockResolvedValue({
      items: [
        { id: "s1", image: "csgo", version: "1.0", location: "europe", status: "running", playerCount: 3, createdAt: "2024-01-01T00:00:00Z", host: "1.2.3.4", ports: [{ type: "udp", container: 27015, host: 30000 }], connectionString: "1.2.3.4:30000" },
        { id: "s2", image: "tf2", location: "us-east", status: "created", playerCount: 0, createdAt: "2024-01-02T00:00:00Z", ports: [] },
      ],
    });
    const text = getText(await handlers["gameye_list_sessions"]({}));
    expect(text).toContain("Found 2 session(s)");
    expect(text).toContain("csgo:1.0");
    expect(text).toContain("host=1.2.3.4");
    expect(text).toContain("30000:27015/udp");
    expect(text).toContain("connect=1.2.3.4:30000");
    expect(text).toContain("tf2");
  });

  it("includes labels when present", async () => {
    client.listSessions.mockResolvedValue({
      items: [{ id: "s1", image: "csgo", location: "eu", status: "running", playerCount: 0, createdAt: "", ports: [], labels: { mode: "competitive" } }],
    });
    const text = getText(await handlers["gameye_list_sessions"]({}));
    expect(text).toContain("mode=competitive");
  });

  it("omits label line when labels absent", async () => {
    client.listSessions.mockResolvedValue({
      items: [{ id: "s1", image: "csgo", location: "eu", status: "running", playerCount: 0, createdAt: "", ports: [] }],
    });
    const text = getText(await handlers["gameye_list_sessions"]({}));
    expect(text).not.toContain("labels:");
  });

  it("never prints a value from the env label, even if the client returned one", async () => {
    client.listSessions.mockResolvedValue({
      items: [{ id: "s1", image: "csgo", location: "eu", status: "running", playerCount: 0, createdAt: "", ports: [], labels: { env: '{"DB_PASSWORD":"hunter2"}', mode: "x" } }],
    });
    const text = getText(await handlers["gameye_list_sessions"]({}));
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("DB_PASSWORD");
    expect(text).toContain("env=(hidden)");
  });

  it("passes filter and filterNot args to client", async () => {
    client.listSessions.mockResolvedValue({ items: [] });
    await handlers["gameye_list_sessions"]({ location: "europe", playerCountLt: 5, filter: { a: "1" }, filterNot: { mode: "casual" } });
    expect(client.listSessions).toHaveBeenCalledWith(expect.objectContaining({
      location: "europe", playerCountLt: 5, filter: { a: "1" }, filterNot: { mode: "casual" },
    }));
  });

  it("returns 403 with the required scope and isError", async () => {
    client.listSessions.mockRejectedValue(
      new GameyeError(403, "forbidden", "Forbidden request.", [], {
        details: "Token is missing required scope 'session:read'. Assigned scopes: [artifact:read]",
        identifier: "tr-403",
      })
    );
    const result = await handlers["gameye_list_sessions"]({});
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Error 403");
    expect(getText(result)).toContain("Required scope: session:read");
    expect(getText(result)).toContain("Trace ID: tr-403");
  });
});

// ─── gameye_describe_session ──────────────────────────────────────────────────

describe("gameye_describe_session", () => {
  const session = {
    id: "sess-1",
    image: "csgo",
    version: "2.0",
    location: "europe",
    status: "running",
    players: { count: 4, ids: ["p1", "p2", "p3", "p4"] },
    ports: [{ type: "udp", container: 27015, host: 30000 }],
    host: "10.0.0.1",
    connectionString: "10.0.0.1:30000",
    labels: { mode: "competitive" },
    createdAt: "2024-01-01T00:00:00Z",
  };

  it("formats session details", async () => {
    client.describeSession.mockResolvedValue(session);
    const text = getText(await handlers["gameye_describe_session"]({ id: "sess-1" }));
    expect(text).toContain("Session: sess-1");
    expect(text).toContain("csgo:2.0");
    expect(text).toContain("europe");
    expect(text).toContain("running");
    expect(text).toContain("p1, p2, p3, p4");
    expect(text).toContain("30000:27015/udp");
    expect(text).toContain("Connect:  10.0.0.1:30000");
    expect(text).toContain("mode: competitive");
  });

  it("does not print fabricated env, restart, ttl or updated fields", async () => {
    client.describeSession.mockResolvedValue({ ...session, env: { PORT: "27015" }, restart: true, ttl: "1h", updatedAt: "x" });
    const text = getText(await handlers["gameye_describe_session"]({ id: "sess-1" }));
    expect(text).not.toMatch(/Env:/);
    expect(text).not.toContain("PORT=27015");
    expect(text).not.toMatch(/Restart:/);
    expect(text).not.toMatch(/TTL:/);
    expect(text).not.toMatch(/Updated:/);
  });

  it("shows (none) when labels are empty and host is unassigned", async () => {
    client.describeSession.mockResolvedValue({ ...session, labels: {}, host: undefined, connectionString: undefined });
    const text = getText(await handlers["gameye_describe_session"]({ id: "sess-1" }));
    expect(text).toMatch(/Labels:\n\s+\(none\)/);
    expect(text).toContain("(not yet assigned)");
  });

  it("returns GameyeError as isError", async () => {
    client.describeSession.mockRejectedValue(new GameyeError(404, "NOT_FOUND", "Session not found"));
    const result = await handlers["gameye_describe_session"]({ id: "missing" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Error 404");
    expect(getText(result)).toContain("Session not found");
  });
});

// ─── end to end with the real client: env values never printed ──────────────

describe("list and describe with the real client never print env label values", () => {
  function realHandlers(body: unknown) {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const mock = makeMockServer();
    const real = new GameyeClient({ token: "t", baseUrl: "https://api.sandbox-gameye.gameye.net" });
    registerSessionTools(mock.server, real, makeContext());
    return { handlers: mock.handlers, fetchMock };
  }

  const labels = { env: '{"API_KEY":"s3cr3t-value","GAMEYE_PORT_27015_UDP":"30000"}', tags: '{"mode":"comp"}' };

  it("describe", async () => {
    const { handlers: h } = realHandlers({
      id: "s1", image: "csgo", tag: "1", location: "eu", host: "1.2.3.4", status: "running", created: 0,
      port: { "27015/udp": 30000 }, labels, players: { joined: [], joinedCount: 0 },
    });
    const text = getText(await h["gameye_describe_session"]({ id: "s1" }));
    expect(text).not.toContain("s3cr3t-value");
    expect(text).not.toContain("API_KEY");
    expect(text).toContain("env: (hidden)");
  });

  it("list, and it sends filterNot[key]=value", async () => {
    const { handlers: h, fetchMock } = realHandlers({
      sessions: [{ id: "s1", image: "csgo", location: "eu", host: "1.2.3.4", status: "running", playerCount: 1, created: 0, port: { "27015/udp": 30000 }, labels }],
    });
    const text = getText(await h["gameye_list_sessions"]({ filterNot: { mode: "casual" } }));
    expect(capturedUrl(fetchMock).searchParams.get("filterNot[mode]")).toBe("casual");
    expect(text).not.toContain("s3cr3t-value");
    expect(text).not.toContain("API_KEY");
    expect(text).toContain("connect=1.2.3.4:30000");
  });
});

// ─── gameye_stop_session ──────────────────────────────────────────────────────

describe("gameye_stop_session", () => {
  it("returns draining message with session ID", async () => {
    client.stopSession.mockResolvedValue(undefined);
    const text = getText(await handlers["gameye_stop_session"]({ id: "sess-1" }));
    expect(text).toContain("sess-1");
    expect(text).toContain("draining");
  });

  it("returns GameyeError as isError", async () => {
    client.stopSession.mockRejectedValue(new GameyeError(404, "NOT_FOUND", "No such session"));
    const result = await handlers["gameye_stop_session"]({ id: "x" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Error 404");
  });

  it("returns non-Gameye errors as isError", async () => {
    client.stopSession.mockRejectedValue(new Error("timeout"));
    const result = await handlers["gameye_stop_session"]({ id: "x" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("timeout");
  });
});
