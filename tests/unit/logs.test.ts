import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GameyeClient, GameyeError } from "../../src/client.js";
import { registerLogTools } from "../../src/tools/logs.js";
import { makeMockServer, makeMockClient, makeContext, getText, capturedUrl, SANDBOX_PREFIX } from "./helpers.js";

let handlers: ReturnType<typeof makeMockServer>["handlers"];
let configs: ReturnType<typeof makeMockServer>["configs"];
let client: ReturnType<typeof makeMockClient>;

beforeEach(() => {
  client = makeMockClient();
  const mock = makeMockServer();
  registerLogTools(mock.server, client as never, makeContext());
  handlers = mock.handlers;
  configs = mock.configs;
});

afterEach(() => vi.unstubAllGlobals());

describe("gameye_get_logs", () => {
  it("is annotated read-only", () => {
    expect(configs["gameye_get_logs"].annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });

  it("with follow=true still fetches a snapshot and notes it", async () => {
    client.getLogs.mockResolvedValue("line1");
    const text = getText(await handlers["gameye_get_logs"]({ id: "s1", follow: true }));
    expect(client.getLogs).toHaveBeenCalledWith({ id: "s1" });
    expect(text).toContain("follow=true is not supported");
    expect(text).toContain("line1");
  });

  it("with follow=true sends follow=false on the wire (real client)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("hello", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const mock = makeMockServer();
    registerLogTools(mock.server, new GameyeClient({ token: "t", baseUrl: "https://x.test" }), makeContext());
    const text = getText(await mock.handlers["gameye_get_logs"]({ id: "s1", follow: true }));
    expect(capturedUrl(fetchMock).searchParams.get("follow")).toBe("false");
    expect(text).toContain("hello");
  });

  it("a stalled request comes back as isError naming the host and timeout (real client)", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(new DOMException("The operation timed out.", "TimeoutError")), 10);
      void ms;
      return ac.signal;
    });
    const mock = makeMockServer();
    registerLogTools(mock.server, new GameyeClient({ token: "t", baseUrl: "https://x.test" }), makeContext());
    const res = await mock.handlers["gameye_get_logs"]({ id: "s1" });
    expect(res.isError).toBe(true);
    expect(getText(res)).toBe(`${SANDBOX_PREFIX}\nRequest to x.test timed out after 60s`);
    vi.restoreAllMocks();
  });

  it("returns empty-log message when logs are blank", async () => {
    client.getLogs.mockResolvedValue("");
    const text = getText(await handlers["gameye_get_logs"]({ id: "sess-1" }));
    expect(text).toContain("No log output available");
    expect(text).toContain("sess-1");
  });

  it("returns empty-log message when logs are only whitespace", async () => {
    client.getLogs.mockResolvedValue("   \n  ");
    const text = getText(await handlers["gameye_get_logs"]({ id: "s1" }));
    expect(text).toContain("No log output available");
  });

  it("returns log content with prefix and session ID header", async () => {
    client.getLogs.mockResolvedValue("line1\nline2\nline3");
    const text = getText(await handlers["gameye_get_logs"]({ id: "sess-1" }));
    expect(text.startsWith(`${SANDBOX_PREFIX}\nLogs for session sess-1`)).toBe(true);
    expect(text).toContain("line1\nline2\nline3");
  });

  it("truncates logs exceeding 50 000 characters", async () => {
    client.getLogs.mockResolvedValue("x".repeat(60_000));
    const text = getText(await handlers["gameye_get_logs"]({ id: "s1" }));
    expect(text).toContain("showing last 50000 characters of 60000 total");
    expect(text.length).toBeLessThan(50_000 + 500);
  });

  it("does not add truncation note for logs under 50 000 characters", async () => {
    client.getLogs.mockResolvedValue("a".repeat(1000));
    const text = getText(await handlers["gameye_get_logs"]({ id: "s1" }));
    expect(text).not.toContain("showing last");
  });

  it("returns GameyeError as isError", async () => {
    client.getLogs.mockRejectedValue(new GameyeError(404, "NOT_FOUND", "Session not found"));
    const result = await handlers["gameye_get_logs"]({ id: "x" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Error 404");
  });

  it("returns non-Gameye errors as isError", async () => {
    client.getLogs.mockRejectedValue(new Error("socket hang up"));
    const result = await handlers["gameye_get_logs"]({ id: "s1" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("socket hang up");
  });
});
