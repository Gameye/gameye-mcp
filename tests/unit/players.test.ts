import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { GameyeClient, GameyeError } from "../../src/client.js";
import { registerPlayerTools } from "../../src/tools/players.js";
import { makeMockServer, makeMockClient, makeContext, getText, SANDBOX_PREFIX } from "./helpers.js";

let handlers: ReturnType<typeof makeMockServer>["handlers"];
let configs: ReturnType<typeof makeMockServer>["configs"];
let client: ReturnType<typeof makeMockClient>;

beforeEach(() => {
  client = makeMockClient();
  const mock = makeMockServer();
  registerPlayerTools(mock.server, client as never, makeContext());
  handlers = mock.handlers;
  configs = mock.configs;
});

afterEach(() => vi.unstubAllGlobals());

describe("player tool input schema", () => {
  for (const name of ["gameye_player_join", "gameye_player_leave"]) {
    it(`${name} requires at least one player`, () => {
      const schema = z.object(configs[name].inputSchema as z.ZodRawShape);
      expect(schema.safeParse({ session: "s1", players: [] }).success).toBe(false);
      expect(schema.safeParse({ session: "s1", players: ["a"] }).success).toBe(true);
      expect(schema.safeParse({ session: "s1", playerId: "a" }).success).toBe(false);
    });
  }

  it("annotates join/leave as non-read-only, non-destructive", () => {
    expect(configs["gameye_player_join"].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(configs["gameye_player_leave"].annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  });
});

describe("gameye_player_join", () => {
  it("reports the server's count, prefixed with environment and host", async () => {
    client.playerJoin.mockResolvedValue({ count: 5, players: ["a", "b", "c", "d", "e"] });
    const text = getText(await handlers["gameye_player_join"]({ session: "s1", players: ["a", "b"] }));
    expect(text.startsWith(SANDBOX_PREFIX)).toBe(true);
    expect(text).toContain("Players joined: a, b");
    expect(text).toContain("Player count: 5 (reported by server)");
  });

  it("passes session and players to client", async () => {
    client.playerJoin.mockResolvedValue({ count: 2, players: ["a", "b"] });
    await handlers["gameye_player_join"]({ session: "s1", players: ["a", "b"] });
    expect(client.playerJoin).toHaveBeenCalledWith({ session: "s1", players: ["a", "b"] });
  });

  it("sends {session, players:[a,b]} on the wire and reports the server count (real client)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ count: 2, players: ["a", "b"] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const mock = makeMockServer();
    registerPlayerTools(mock.server, new GameyeClient({ token: "t", baseUrl: "https://x.test" }), makeContext());
    const text = getText(await mock.handlers["gameye_player_join"]({ session: "s1", players: ["a", "b"] }));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ session: "s1", players: ["a", "b"] });
    expect(text).toContain("Player count: 2");
  });

  it("returns GameyeError as isError", async () => {
    client.playerJoin.mockRejectedValue(new GameyeError(404, "NOT_FOUND", "Unable to join session.", [], { details: "Could not find session." }));
    const result = await handlers["gameye_player_join"]({ session: "x", players: ["p1"] });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Error 404");
    expect(getText(result)).toContain("Could not find session.");
  });

  it("returns non-Gameye errors as isError", async () => {
    client.playerJoin.mockRejectedValue(new Error("network error"));
    const result = await handlers["gameye_player_join"]({ session: "s1", players: ["p1"] });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("network error");
  });
});

describe("gameye_player_leave", () => {
  it("reports the server's count", async () => {
    client.playerLeave.mockResolvedValue({ count: 0, players: [] });
    const text = getText(await handlers["gameye_player_leave"]({ session: "s1", players: ["p1"] }));
    expect(text).toContain("Players removed: p1");
    expect(text).toContain("Player count: 0 (reported by server)");
  });

  it("passes session and players to client", async () => {
    client.playerLeave.mockResolvedValue({ count: 0, players: [] });
    await handlers["gameye_player_leave"]({ session: "s1", players: ["p1", "p2"] });
    expect(client.playerLeave).toHaveBeenCalledWith({ session: "s1", players: ["p1", "p2"] });
  });

  it("returns 403 with required scope and isError", async () => {
    client.playerLeave.mockRejectedValue(
      new GameyeError(403, "forbidden", "Forbidden request.", [], {
        details: "Token is missing required scope 'session:write'. Assigned scopes: [session:read]",
      })
    );
    const result = await handlers["gameye_player_leave"]({ session: "s1", players: ["p1"] });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Required scope: session:write");
  });
});

describe("player tools dryRun", () => {
  it("join with dryRun sends nothing and returns the planned PUT request", async () => {
    const text = getText(await handlers["gameye_player_join"]({ session: "s1", players: ["a", "b"], dryRun: true }));
    expect(client.playerJoin).not.toHaveBeenCalled();
    expect(text.startsWith(SANDBOX_PREFIX)).toBe(true);
    expect(text).toContain("Dry run: nothing was sent.");
    expect(text).toContain("PUT");
    expect(text).toContain("/session/player/join");
    expect(text).toContain('"players"');
  });

  it("leave with dryRun sends nothing and returns the planned DELETE request", async () => {
    const text = getText(await handlers["gameye_player_leave"]({ session: "s1", players: ["a"], dryRun: true }));
    expect(client.playerLeave).not.toHaveBeenCalled();
    expect(text).toContain("DELETE");
    expect(text).toContain("/session/player/leave");
    expect(text).toContain('"session": "s1"');
  });
});
