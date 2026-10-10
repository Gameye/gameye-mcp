import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { GameyeError } from "../../src/client.js";
import { registerArtifactTools } from "../../src/tools/artifacts.js";
import { makeMockServer, makeMockClient, makeContext, getText, SANDBOX_PREFIX } from "./helpers.js";

let handlers: ReturnType<typeof makeMockServer>["handlers"];
let configs: ReturnType<typeof makeMockServer>["configs"];
let client: ReturnType<typeof makeMockClient>;

beforeEach(() => {
  client = makeMockClient();
  const mock = makeMockServer();
  registerArtifactTools(mock.server, client as never, makeContext());
  handlers = mock.handlers;
  configs = mock.configs;
});

describe("gameye_get_artifacts", () => {
  it("requires an absolute container path", () => {
    const schema = z.object(configs["gameye_get_artifacts"].inputSchema as z.ZodRawShape);
    expect(schema.safeParse({ session: "s1" }).success).toBe(false);
    expect(schema.safeParse({ session: "s1", path: "relative/logs" }).success).toBe(false);
    expect(schema.safeParse({ session: "s1", path: "/app/logs" }).success).toBe(true);
  });

  it("returns the saved path and an uncompressed tar extract command", async () => {
    client.getArtifacts.mockResolvedValue("/tmp/gameye-artifacts-x/gameye-artifact-sess-1.tar");
    const text = getText(await handlers["gameye_get_artifacts"]({ session: "sess-1", path: "/app/logs" }));
    expect(text.startsWith(SANDBOX_PREFIX)).toBe(true);
    expect(text).toContain("Artifacts downloaded for session sess-1");
    expect(text).toContain("/tmp/gameye-artifacts-x/gameye-artifact-sess-1.tar");
    expect(text).toContain('tar -xf "/tmp/gameye-artifacts-x/gameye-artifact-sess-1.tar" -C "/tmp/gameye-artifacts-x"');
    expect(text).not.toContain("tar -xzf");
  });

  it("passes session and path to client", async () => {
    client.getArtifacts.mockResolvedValue("/tmp/d/out.tar");
    await handlers["gameye_get_artifacts"]({ session: "abc", path: "/app/logs" });
    expect(client.getArtifacts).toHaveBeenCalledWith({ session: "abc", path: "/app/logs" });
  });

  it("returns 404 as isError with a session-or-path hint", async () => {
    client.getArtifacts.mockRejectedValue(new GameyeError(404, "NOT_FOUND", "Unable to retrieve artifact."));
    const result = await handlers["gameye_get_artifacts"]({ session: "x", path: "/nope" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Error 404");
    expect(getText(result)).toContain("path does not exist");
  });

  it("returns non-404 GameyeError without the hint", async () => {
    client.getArtifacts.mockRejectedValue(new GameyeError(401, "UNAUTHORIZED", "Bad token"));
    const result = await handlers["gameye_get_artifacts"]({ session: "x", path: "/a" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Error 401");
    expect(getText(result)).not.toContain("path does not exist");
  });

  it("returns local errors as isError", async () => {
    client.getArtifacts.mockRejectedValue(new Error("disk full"));
    const result = await handlers["gameye_get_artifacts"]({ session: "s1", path: "/a" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("disk full");
  });
});
