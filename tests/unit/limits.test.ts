import { describe, it, expect, vi } from "vitest";
import { DEFAULT_LIMITS, type SessionLimits } from "../../src/env.js";
import { GuardError } from "../../src/guards.js";
import { SessionLimiter, parseDurationMs } from "../../src/limits.js";

function makeLimiter(limits: Partial<SessionLimits> = {}, items: Array<{ id: string; status: string }> = []) {
  let now = 1_000_000;
  const listSessions = vi.fn().mockResolvedValue({ items });
  const limiter = new SessionLimiter({ ...DEFAULT_LIMITS, ...limits }, { listSessions } as never, () => now);
  return { limiter, listSessions, advance: (ms: number) => (now += ms) };
}

const HOUR = 3_600_000;

describe("parseDurationMs", () => {
  it.each([
    ["30m", 1_800_000],
    ["1h", HOUR],
    ["2.5h", 2.5 * HOUR],
    ["4h50m", 4 * HOUR + 50 * 60_000],
    ["90s", 90_000],
    ["0", 0],
  ])("parses %s", (text, ms) => expect(parseDurationMs(text)).toBe(ms));

  it.each(["", "1d", "h", "1 h", "-1h", "1h-", "forever"])("rejects %j", (text) => {
    expect(parseDurationMs(text)).toBeUndefined();
  });
});

describe("SessionLimiter.checkTtl", () => {
  it("allows a TTL up to the limit", () => {
    expect(makeLimiter().limiter.checkTtl("4h")).toBe(4 * HOUR);
  });

  it.each(["5h", "4h1m", "0", "1d"])("refuses %s", (ttl) => {
    expect(() => makeLimiter().limiter.checkTtl(ttl)).toThrow(GuardError);
  });
});

describe("SessionLimiter.reserve", () => {
  it("refuses once maxSessions of its own sessions are running", async () => {
    const { limiter } = makeLimiter({ maxSessions: 2 });
    (await limiter.reserve(HOUR)).started("a");
    (await limiter.reserve(HOUR)).started("b");
    await expect(limiter.reserve(HOUR)).rejects.toThrow(/2 session\(s\) started by this server are still running/);
  });

  it("counts launches still in flight", async () => {
    const { limiter } = makeLimiter({ maxSessions: 1 });
    await limiter.reserve(HOUR); // not settled yet
    await expect(limiter.reserve(HOUR)).rejects.toThrow(GuardError);
  });

  it("frees a slot when the session has exited, been stopped, or passed its TTL", async () => {
    const items = [{ id: "a", status: "exited" }];
    const { limiter, advance } = makeLimiter({ maxSessions: 1 }, items);
    (await limiter.reserve(HOUR)).started("a");
    (await limiter.reserve(HOUR)).started("b"); // a is exited in the list
    limiter.stopped("b");
    (await limiter.reserve(HOUR)).started("c");
    advance(HOUR);
    await expect(limiter.reserve(HOUR)).resolves.toBeDefined();
  });

  it("keeps counting a session missing from the labelled list (warm pool) until its TTL", async () => {
    const { limiter, advance } = makeLimiter({ maxSessions: 1 }, []);
    (await limiter.reserve(HOUR)).started("warm-1");
    await expect(limiter.reserve(HOUR)).rejects.toThrow(GuardError);
    advance(HOUR - 1);
    await expect(limiter.reserve(HOUR)).rejects.toThrow(GuardError);
    advance(1);
    await expect(limiter.reserve(HOUR)).resolves.toBeDefined();
  });

  it("only lists sessions with the agent label, all statuses", async () => {
    const { limiter, listSessions } = makeLimiter();
    (await limiter.reserve(HOUR)).started("a");
    await limiter.reserve(HOUR);
    expect(listSessions).toHaveBeenCalledWith({ all: true, filter: { "launched-by": "gameye-mcp" } });
  });

  it("fails closed when the list call fails", async () => {
    const { limiter, listSessions } = makeLimiter();
    (await limiter.reserve(HOUR)).started("a");
    listSessions.mockRejectedValueOnce(new Error("timeout"));
    await expect(limiter.reserve(HOUR)).rejects.toThrow(/fails closed/);
    await expect(limiter.reserve(HOUR)).resolves.toBeDefined(); // the failed attempt released its slot
  });

  it("refuses after maxLaunches launches in one run, even when they ended", async () => {
    const { limiter, advance } = makeLimiter({ maxLaunches: 2 });
    (await limiter.reserve(HOUR)).started("a");
    (await limiter.reserve(HOUR)).started("b");
    advance(2 * HOUR);
    await expect(limiter.reserve(HOUR)).rejects.toThrow(/GAMEYE_MAX_LAUNCHES=2/);
  });

  it("counts a launch with an unknown outcome as running, but not a refused one", async () => {
    const { limiter } = makeLimiter({ maxSessions: 1, maxLaunches: 3 });
    (await limiter.reserve(HOUR)).failed(false);
    (await limiter.reserve(HOUR)).failed(true);
    await expect(limiter.reserve(HOUR)).rejects.toThrow(/still running/);
  });

  it("throws if a reservation is settled twice", async () => {
    const r = await makeLimiter().limiter.reserve(HOUR);
    r.started("a");
    expect(() => r.failed(false)).toThrow();
  });
});

describe("SessionLimiter.isOwn", () => {
  it("knows the sessions this process started, even after they stop", async () => {
    const { limiter } = makeLimiter();
    (await limiter.reserve(HOUR)).started("a");
    limiter.stopped("a");
    expect(limiter.isOwn("a")).toBe(true);
    expect(limiter.isOwn("b")).toBe(false);
  });
});
