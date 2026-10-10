import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { z } from "zod";
import { GameyeClient, GameyeError } from "../../src/client.js";
import { registerApplicationTools } from "../../src/tools/applications.js";
import { makeMockServer, makeMockClient, makeContext, getText, capturedUrl, SANDBOX_PREFIX } from "./helpers.js";

let handlers: ReturnType<typeof makeMockServer>["handlers"];
let configs: ReturnType<typeof makeMockServer>["configs"];
let client: ReturnType<typeof makeMockClient>;

function register(admin: boolean) {
  client = makeMockClient();
  const mock = makeMockServer();
  registerApplicationTools(mock.server, client as never, makeContext(), { admin });
  handlers = mock.handlers;
  configs = mock.configs;
}

beforeEach(() => register(true));
afterEach(() => vi.unstubAllGlobals());

const app = {
  name: "my-game",
  registry: "dockerhub",
  repository: "acme/my-game",
  tagKeep: 5,
  networkMode: "bridge",
  limits: { cpu: 2, ram: 2048 },
  reservation: { cpu: 1, ram: 1024, gpu: 0 },
  nodePool: "default",
  regions: ["europe"],
  ports: [{ requested: 7777, protocol: "udp", tls: false }],
};

function schemaOf(name: string) {
  return z.object(configs[name].inputSchema as z.ZodRawShape).strict();
}

// ─── registration ─────────────────────────────────────────────────────────────

describe("application tool registration", () => {
  it("registers admin tools only when admin is on", () => {
    register(false);
    expect(Object.keys(handlers).sort()).toEqual([
      "gameye_enable_tag",
      "gameye_list_applications",
      "gameye_list_registry_tags",
    ]);
    register(true);
    expect(Object.keys(handlers)).toContain("gameye_create_application");
    expect(Object.keys(handlers)).toContain("gameye_edit_application");
  });

  it("annotates reads read-only and writes not read-only", () => {
    expect(configs["gameye_list_applications"].annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(configs["gameye_list_registry_tags"].annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    for (const t of ["gameye_enable_tag", "gameye_create_application", "gameye_edit_application"]) {
      expect(configs[t].annotations, t).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    }
    expect(configs["gameye_edit_application"].annotations?.destructiveHint).toBe(true);
  });
});

// ─── input schemas ────────────────────────────────────────────────────────────

describe("create application input schema", () => {
  it("accepts a client.yaml-shaped body", () => {
    expect(schemaOf("gameye_create_application").safeParse(app).success).toBe(true);
  });

  it("rejects unknown protocols, network modes and nested fields, and missing required fields", () => {
    const s = schemaOf("gameye_create_application");
    expect(s.safeParse({ ...app, ports: [{ requested: 7777, protocol: "sctp", tls: false }] }).success).toBe(false);
    expect(s.safeParse({ ...app, ports: [{ requested: 7777, protocol: "udp" }] }).success).toBe(false);
    expect(s.safeParse({ ...app, networkMode: "overlay" }).success).toBe(false);
    expect(s.safeParse({ ...app, limits: { cpu: 1 } }).success).toBe(false);
    expect(s.safeParse({ ...app, limits: { cpu: 1, ram: 512, disk: 1 } }).success).toBe(false);
    const { nodePool: _omit, ...missing } = app;
    expect(s.safeParse(missing).success).toBe(false);
  });

  it("edit accepts any subset of fields", () => {
    const s = schemaOf("gameye_edit_application");
    expect(s.safeParse({ name: "my-game", tagKeep: 3 }).success).toBe(true);
    expect(s.safeParse({ name: "my-game", ports: [{ requested: 1, protocol: "tcp", tls: true }] }).success).toBe(true);
    expect(s.safeParse({ name: "my-game", networkMode: "nat" }).success).toBe(false);
  });
});

// ─── handlers ─────────────────────────────────────────────────────────────────

describe("gameye_list_applications", () => {
  it("formats applications", async () => {
    client.listApplications.mockResolvedValue({ items: [{ ...app, ports: [{ requested: 7777, protocol: "udp", tls: true }] }] });
    const text = getText(await handlers["gameye_list_applications"]({}));
    expect(text.split("\n")[0]).toBe(SANDBOX_PREFIX);
    expect(text).toContain("Found 1 application(s)");
    expect(text).toContain("• my-game");
    expect(text).toContain("registry=dockerhub");
    expect(text).toContain("cpu=2 ram=2048MB");
    expect(text).toContain("7777/udp (tls)");
  });

  it("returns empty message", async () => {
    client.listApplications.mockResolvedValue({ items: [] });
    expect(getText(await handlers["gameye_list_applications"]({}))).toContain("No applications");
  });
});

describe("gameye_list_registry_tags", () => {
  it("passes page and pageSize and lists versions", async () => {
    client.listRegistryTags.mockResolvedValue({ versions: ["1.0.0", "1.1.0"] });
    const text = getText(await handlers["gameye_list_registry_tags"]({ name: "my-game", page: 2, pageSize: 50 }));
    expect(client.listRegistryTags).toHaveBeenCalledWith("my-game", 2, 50);
    expect(text).toContain("page 2, page size 50");
    expect(text).toContain("• 1.1.0");
  });

  it("rejects out-of-range paging", () => {
    const s = schemaOf("gameye_list_registry_tags");
    expect(s.safeParse({ name: "x", page: 0 }).success).toBe(false);
    expect(s.safeParse({ name: "x", pageSize: 1001 }).success).toBe(false);
  });
});

describe("gameye_enable_tag", () => {
  it("enables a tag", async () => {
    client.enableTag.mockResolvedValue(undefined);
    const text = getText(await handlers["gameye_enable_tag"]({ name: "my-game", tag: "1.2.3" }));
    expect(client.enableTag).toHaveBeenCalledWith("my-game", "1.2.3");
    expect(text).toContain("Tag 1.2.3 enabled for my-game");
  });

  it("dryRun does not call the client", async () => {
    const text = getText(await handlers["gameye_enable_tag"]({ name: "my-game", tag: "1.2.3", dryRun: true }));
    expect(client.enableTag).not.toHaveBeenCalled();
    expect(text).toContain('"tag": "1.2.3"');
  });

  it("returns a 404 as isError", async () => {
    client.enableTag.mockRejectedValue(new GameyeError(404, "not_found", "Not found"));
    const res = await handlers["gameye_enable_tag"]({ name: "x", tag: "y" });
    expect(res.isError).toBe(true);
  });
});

describe("gameye_create_application / gameye_edit_application", () => {
  it("create description says tls can only be set at creation", () => {
    const d = configs["gameye_create_application"].description ?? "";
    expect(d).toMatch(/only be set at creation/);
  });

  it("edit description warns that ports sent through edit drop tls", () => {
    const d = configs["gameye_edit_application"].description ?? "";
    expect(d).toMatch(/stores tls=false/);
    expect(d).toMatch(/Omit ports to keep existing TLS ports/);
  });

  it("the tls port field states the edit caveat and makes no certificate promises", () => {
    const ports = configs["gameye_create_application"].inputSchema?.ports as z.ZodArray<z.ZodObject<{ tls: z.ZodBoolean }>>;
    const tls = ports.element.shape.tls.description ?? "";
    expect(tls).toMatch(/terminates TLS for this port on the host/);
    expect(tls).toMatch(/gameye_edit_application end up tls=false/);
    expect(tls).not.toMatch(/certificate|wss:\/\//);
  });

  it("create passes the body without dryRun", async () => {
    client.createApplication.mockResolvedValue(undefined);
    await handlers["gameye_create_application"]({ ...app, dryRun: false });
    expect(client.createApplication).toHaveBeenCalledWith(app);
  });

  it("edit sends only the given fields", async () => {
    client.editApplication.mockResolvedValue(undefined);
    const text = getText(await handlers["gameye_edit_application"]({ name: "my-game", tagKeep: 3, regions: ["europe"] }));
    expect(client.editApplication).toHaveBeenCalledWith("my-game", { tagKeep: 3, regions: ["europe"] });
    expect(text).toContain("tagKeep, regions");
  });

  it("edit with no fields is refused without a request", async () => {
    const res = await handlers["gameye_edit_application"]({ name: "my-game" });
    expect(res.isError).toBe(true);
    expect(client.editApplication).not.toHaveBeenCalled();
  });
});

// ─── client ───────────────────────────────────────────────────────────────────

describe("GameyeClient application endpoints", () => {
  const BASE = "https://api.gameye.test";
  function stub(body: unknown, status = 200) {
    const fetchMock = vi.fn().mockResolvedValue(
      status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status })
    );
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, c: new GameyeClient({ token: "t", baseUrl: BASE }) };
  }

  it("listApplications normalizes nulls", async () => {
    const { fetchMock, c } = stub({
      applications: [{ name: "a", repository: "r", tagKeep: 1, networkMode: "host", limits: { cpu: 1, ram: 1 }, reservation: { cpu: 1, ram: 1 }, regions: null, ports: null, registry: "" }],
    });
    const res = await c.listApplications();
    expect(String(fetchMock.mock.calls[0][0])).toBe(`${BASE}/application`);
    expect(res.items[0]).toMatchObject({ name: "a", regions: [], ports: [], registry: undefined });
  });

  it("listRegistryTags sends page and pageSize and maps versions", async () => {
    const { fetchMock, c } = stub({ tags: [{ version: "1" }, { version: "2" }] });
    const res = await c.listRegistryTags("my game", 3, 10);
    const url = capturedUrl(fetchMock);
    expect(url.pathname).toBe("/application/my%20game/tags/available");
    expect(url.searchParams.get("page")).toBe("3");
    expect(url.searchParams.get("pageSize")).toBe("10");
    expect(res).toEqual({ versions: ["1", "2"] });
  });

  it("listRegistryTags omits paging when not given", async () => {
    const { fetchMock, c } = stub({ tags: null });
    expect(await c.listRegistryTags("a")).toEqual({ versions: [] });
    expect(capturedUrl(fetchMock).search).toBe("");
  });

  it("enableTag POSTs {tag} and accepts 204", async () => {
    const { fetchMock, c } = stub(null, 204);
    await c.enableTag("my-game", "1.2.3");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${BASE}/application/my-game/tags`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ tag: "1.2.3" });
  });

  it("createApplication POSTs the full body", async () => {
    const { fetchMock, c } = stub({}, 201);
    await c.createApplication(app as never);
    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(app);
  });

  it("editApplication PUTs to /application/{name}", async () => {
    const { fetchMock, c } = stub(null, 204);
    await c.editApplication("my-game", { tagKeep: 2 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${BASE}/application/my-game`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ tagKeep: 2 });
  });

  it("createToken returns the token and throws when missing", async () => {
    let { c } = stub({ token: "abc" }, 201);
    expect(await c.createToken({ name: "n", scopes: ["s"] })).toBe("abc");
    ({ c } = stub({}, 201));
    await expect(c.createToken({ name: "n", scopes: ["s"] })).rejects.toThrow(/did not return a token/);
  });

  it("errors carry status and code", async () => {
    const { c } = stub({ code: "conflict", message: "Unable to create application.", details: "exists" }, 409);
    await expect(c.createApplication(app as never)).rejects.toMatchObject({ statusCode: 409, code: "conflict" });
  });

  it("containsToken and maskToken never expose the token", () => {
    const c = new GameyeClient({ token: "sekret", baseUrl: BASE });
    expect(c.containsToken("a sekret b")).toBe(true);
    expect(c.containsToken("nothing")).toBe(false);
    expect(c.maskToken("x sekret y sekret")).toBe("x *** y ***");
  });
});
