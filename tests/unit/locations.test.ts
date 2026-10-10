import { describe, it, expect, beforeEach } from "vitest";
import { GameyeError } from "../../src/client.js";
import { registerLocationTools } from "../../src/tools/locations.js";
import { makeMockServer, makeMockClient, makeContext, getText } from "./helpers.js";

let handlers: ReturnType<typeof makeMockServer>["handlers"];
let configs: ReturnType<typeof makeMockServer>["configs"];
let client: ReturnType<typeof makeMockClient>;

beforeEach(() => {
  client = makeMockClient();
  const mock = makeMockServer();
  registerLocationTools(mock.server, client as never, makeContext());
  handlers = mock.handlers;
  configs = mock.configs;
});

describe("gameye_get_locations", () => {
  it("returns not-deployed message when no locations found", async () => {
    client.getAvailableLocations.mockResolvedValue({ items: [] });
    const text = getText(await handlers["gameye_get_locations"]({ image: "test_nginx" }));
    expect(text).toContain("No available locations");
    expect(text).toContain("test_nginx");
  });

  it("lists locations with region count", async () => {
    client.getAvailableLocations.mockResolvedValue({
      items: [
        { location: "europe", pingIps: ["1.2.3.4", "5.6.7.8"] },
        { location: "us-east" },
      ],
    });
    const text = getText(await handlers["gameye_get_locations"]({ image: "csgo" }));
    expect(text).toContain("2 region(s)");
    expect(text).toContain("• europe");
    expect(text).toContain("• us-east");
  });

  it("shows ping IPs when present", async () => {
    client.getAvailableLocations.mockResolvedValue({
      items: [{ location: "europe", pingIps: ["1.2.3.4", "5.6.7.8"] }],
    });
    const text = getText(await handlers["gameye_get_locations"]({ image: "csgo" }));
    expect(text).toContain("Ping IPs: 1.2.3.4, 5.6.7.8");
  });

  it("omits ping IPs line when not provided", async () => {
    client.getAvailableLocations.mockResolvedValue({
      items: [{ location: "europe" }],
    });
    const text = getText(await handlers["gameye_get_locations"]({ image: "csgo" }));
    expect(text).not.toContain("Ping IPs");
  });

  it("omits ping IPs line when array is empty", async () => {
    client.getAvailableLocations.mockResolvedValue({
      items: [{ location: "europe", pingIps: [] }],
    });
    const text = getText(await handlers["gameye_get_locations"]({ image: "csgo" }));
    expect(text).not.toContain("Ping IPs");
  });

  it("returns GameyeError as isError", async () => {
    client.getAvailableLocations.mockRejectedValue(new GameyeError(401, "UNAUTHORIZED", "Bad token"));
    const result = await handlers["gameye_get_locations"]({ image: "csgo" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Error 401");
  });

  it("returns non-Gameye errors as isError", async () => {
    client.getAvailableLocations.mockRejectedValue(new Error("DNS failure"));
    const result = await handlers["gameye_get_locations"]({ image: "csgo" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("DNS failure");
  });

  it("prefixes results and is annotated read-only", async () => {
    client.getAvailableLocations.mockResolvedValue({ items: [] });
    const text = getText(await handlers["gameye_get_locations"]({ image: "csgo" }));
    expect(text.startsWith("[sandbox · api.sandbox-gameye.gameye.net]\n")).toBe(true);
    expect(configs["gameye_get_locations"].annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });
});
