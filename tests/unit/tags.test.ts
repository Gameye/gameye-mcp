import { describe, it, expect, beforeEach } from "vitest";
import { GameyeError } from "../../src/client.js";
import { registerTagTools } from "../../src/tools/tags.js";
import { makeMockServer, makeMockClient, makeContext, getText } from "./helpers.js";

let handlers: ReturnType<typeof makeMockServer>["handlers"];
let configs: ReturnType<typeof makeMockServer>["configs"];
let client: ReturnType<typeof makeMockClient>;

beforeEach(() => {
  client = makeMockClient();
  const mock = makeMockServer();
  registerTagTools(mock.server, client as never, makeContext());
  handlers = mock.handlers;
  configs = mock.configs;
});

describe("gameye_check_tag", () => {
  it("shows available status when tag exists", async () => {
    client.checkTag.mockResolvedValue({ region: "europe", image: "csgo", version: "1.2.3", exists: true });
    const text = getText(await handlers["gameye_check_tag"]({ region: "europe", image: "csgo", version: "1.2.3" }));
    expect(text).toContain("✓ Available");
    expect(text).toContain("csgo:1.2.3 is ready to use in europe");
  });

  it("shows not-available status when tag does not exist", async () => {
    client.checkTag.mockResolvedValue({ region: "us-east", image: "tf2", version: "2.0", exists: false });
    const text = getText(await handlers["gameye_check_tag"]({ region: "us-east", image: "tf2", version: "2.0" }));
    expect(text).toContain("✗ Not available");
    expect(text).toContain("NOT deployed in us-east");
  });

  it("includes region, image, and version in output", async () => {
    client.checkTag.mockResolvedValue({ region: "europe", image: "csgo", version: "1.0", exists: true });
    const text = getText(await handlers["gameye_check_tag"]({ region: "europe", image: "csgo", version: "1.0" }));
    expect(text).toContain("Region:  europe");
    expect(text).toContain("Image:   csgo");
    expect(text).toContain("Version: 1.0");
  });

  it("passes args to client", async () => {
    client.checkTag.mockResolvedValue({ region: "eu", image: "csgo", version: "1.0", exists: true });
    await handlers["gameye_check_tag"]({ region: "eu", image: "csgo", version: "1.0" });
    expect(client.checkTag).toHaveBeenCalledWith("eu", "csgo", "1.0");
  });

  it("returns GameyeError as isError", async () => {
    client.checkTag.mockRejectedValue(new GameyeError(404, "NOT_FOUND", "Image not found"));
    const result = await handlers["gameye_check_tag"]({ region: "eu", image: "x", version: "1.0" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Error 404");
  });

  it("returns non-Gameye errors as isError", async () => {
    client.checkTag.mockRejectedValue(new Error("timeout"));
    const result = await handlers["gameye_check_tag"]({ region: "eu", image: "csgo", version: "1.0" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("timeout");
  });

  it("is annotated read-only", () => {
    expect(configs["gameye_check_tag"].annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });
});
