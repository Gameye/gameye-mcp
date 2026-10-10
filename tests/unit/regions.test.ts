import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { GameyeClient, GameyeError } from "../../src/client.js";
import { registerRegionTools } from "../../src/tools/regions.js";
import { makeMockServer, makeMockClient, makeContext, getText, SANDBOX_PREFIX } from "./helpers.js";

let handlers: ReturnType<typeof makeMockServer>["handlers"];
let configs: ReturnType<typeof makeMockServer>["configs"];
let client: ReturnType<typeof makeMockClient>;

beforeEach(() => {
  client = makeMockClient();
  const mock = makeMockServer();
  registerRegionTools(mock.server, client as never, makeContext());
  handlers = mock.handlers;
  configs = mock.configs;
});

afterEach(() => vi.unstubAllGlobals());

describe("gameye_list_regions", () => {
  it("is read-only and open-world", () => {
    expect(configs["gameye_list_regions"].annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });

  it("lists regions with the environment prefix", async () => {
    client.listRegions.mockResolvedValue({ regions: ["europe", "us-east"] });
    const text = getText(await handlers["gameye_list_regions"]({}));
    expect(text.split("\n")[0]).toBe(SANDBOX_PREFIX);
    expect(text).toContain("Found 2 region(s)");
    expect(text).toContain("• europe");
  });

  it("says so when there are none", async () => {
    client.listRegions.mockResolvedValue({ regions: [] });
    expect(getText(await handlers["gameye_list_regions"]({}))).toContain("No regions");
  });

  it("returns a 403 naming region:read as isError", async () => {
    client.listRegions.mockRejectedValue(
      new GameyeError(403, "forbidden", "Forbidden request.", [], { details: "Token is missing required scope 'region:read'." })
    );
    const res = await handlers["gameye_list_regions"]({});
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("Required scope: region:read");
  });
});

describe("GameyeClient.listRegions", () => {
  it("GETs /region with the bearer token and tolerates null", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ regions: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await new GameyeClient({ token: "t", baseUrl: "https://api.gameye.test" }).listRegions();
    expect(res).toEqual({ regions: [] });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.gameye.test/region");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer t");
  });
});
