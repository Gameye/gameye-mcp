import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameyeClient } from "../../src/client.js";
import { DEFAULT_TOKEN_EXPIRY } from "../../src/guards.js";
import { registerTokenTools } from "../../src/tools/tokens.js";
import { makeContext, makeMockServer, getText, SANDBOX_PREFIX, TEST_TOKEN, type ToolResult } from "./helpers.js";

const NEW_TOKEN = "gy_new_secret_token_fedcba9876543210";

let dir: string;

beforeEach(async () => {
  // realpath: on macOS tmpdir() is behind the /var -> /private/var symlink.
  dir = realpathSync(await mkdtemp(join(tmpdir(), "gameye-token-test-")));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

function setup(status = 201, body: unknown = { token: NEW_TOKEN }) {
  const fetchMock = vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  );
  vi.stubGlobal("fetch", fetchMock);
  const mock = makeMockServer();
  const ctx = makeContext();
  registerTokenTools(mock.server, new GameyeClient({ token: TEST_TOKEN, baseUrl: ctx.baseUrl }), ctx);
  const call = (args: Record<string, unknown>): Promise<ToolResult> => mock.handlers["gameye_create_token"](args);
  return { fetchMock, call, configs: mock.configs };
}

const args = (outputPath: string, extra: Record<string, unknown> = {}) => ({
  name: "ci-reader",
  scopes: ["session:read", "logs:read"],
  outputPath,
  ...extra,
});

describe("gameye_create_token", () => {
  it("writes the secret with 0600 permissions and returns only path, scopes and expiry", async () => {
    const { fetchMock, call } = setup();
    const path = join(dir, "token.txt");
    const res = await call(args(path));
    expect(res.isError).toBeUndefined();

    expect(await readFile(path, "utf8")).toBe(`${NEW_TOKEN}\n`);
    if (process.platform !== "win32") expect((await lstat(path)).mode & 0o777).toBe(0o600);

    const text = getText(res);
    expect(text.split("\n")[0]).toBe(SANDBOX_PREFIX);
    expect(text).not.toContain(NEW_TOKEN);
    expect(text).not.toContain(TEST_TOKEN);
    expect(text).toContain(path);
    expect(text).toContain("session:read, logs:read");
    expect(text).toContain(`after ${DEFAULT_TOKEN_EXPIRY}`);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.sandbox-gameye.gameye.net/token");
    expect(init.method).toBe("POST");
  });

  it("sends expires_after 24h when none is given", async () => {
    const { fetchMock, call } = setup();
    await call(args(join(dir, "t")));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      name: "ci-reader",
      scopes: ["session:read", "logs:read"],
      expires_after: "24h",
    });
  });

  it("sends an explicit expires_after", async () => {
    const { fetchMock, call } = setup();
    const res = await call(args(join(dir, "t"), { expires_after: "2h30m" }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).expires_after).toBe("2h30m");
    expect(getText(res)).not.toContain("default applied");
  });

  it("refuses an existing file unless overwrite is explicit", async () => {
    const { fetchMock, call } = setup();
    const path = join(dir, "existing");
    await writeFile(path, "old\n");
    const res = await call(args(path));
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/already exists/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(path, "utf8")).toBe("old\n");
  });

  it("replaces an existing file with overwrite: true, leaving no temp file and 0600 perms", async () => {
    const { call } = setup();
    const path = join(dir, "existing");
    await writeFile(path, "old\n", { mode: 0o644 });
    const res = await call(args(path, { overwrite: true }));
    expect(res.isError).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(`${NEW_TOKEN}\n`);
    if (process.platform !== "win32") expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["existing"]);
  });

  it("refuses a path inside a git working tree", async () => {
    const { fetchMock, call } = setup();
    await mkdir(join(dir, "repo", ".git"), { recursive: true });
    await mkdir(join(dir, "repo", "secrets"));
    const path = join(dir, "repo", "secrets", "token");
    const res = await call(args(path));
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/inside the git working tree/);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(lstat(path)).rejects.toThrow();
  });

  it("refuses a git tree reached through a symlinked parent directory", async () => {
    const { fetchMock, call } = setup();
    await mkdir(join(dir, "repo", ".git"), { recursive: true });
    await symlink(join(dir, "repo"), join(dir, "link-to-repo"));
    const res = await call(args(join(dir, "link-to-repo", "token")));
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a symlink, dangling or not, even with overwrite", async () => {
    const { fetchMock, call } = setup();
    const target = join(dir, "target");
    await writeFile(target, "victim\n");
    await symlink(target, join(dir, "link"));
    await symlink(join(dir, "nowhere"), join(dir, "dangling"));
    for (const p of ["link", "dangling"]) {
      const res = await call(args(join(dir, p), { overwrite: true }));
      expect(res.isError, p).toBe(true);
      expect(getText(res)).toMatch(/symlink/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(target, "utf8")).toBe("victim\n");
    await expect(lstat(join(dir, "nowhere"))).rejects.toThrow();
  });

  it("refuses a relative path", async () => {
    const { fetchMock, call } = setup();
    const res = await call(args("token.txt"));
    expect(res.isError).toBe(true);
    expect(getText(res)).toMatch(/absolute/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes the reserved file when the API call fails", async () => {
    const { call } = setup(403, { code: "forbidden", message: "Forbidden request.", details: "The caller does not hold the requested scope(s)" });
    const path = join(dir, "token");
    const res = await call(args(path));
    expect(res.isError).toBe(true);
    expect(getText(res)).toContain("Error 403");
    await expect(lstat(path)).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  describe("when the file cannot be written after the token was minted", () => {
    const LOST = /^Token "ci-reader" was created on api\.sandbox-gameye\.gameye\.net but could not be written to (.+): (.+)\. The secret is lost; revoke this token \(it expires in 24h\)\.$/;

    /** Make the next FileHandle.writeFile reject, as a full disk would. */
    async function failNextWrite() {
      const probe = await open(join(dir, ".probe"), "w");
      const proto = Object.getPrototypeOf(probe) as { writeFile: (...a: unknown[]) => Promise<void> };
      await probe.close();
      await unlink(join(dir, ".probe"));
      return vi
        .spyOn(proto, "writeFile")
        .mockRejectedValueOnce(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));
    }

    afterEach(() => vi.restoreAllMocks());

    it("says the token exists and must be revoked, and leaves no file behind", async () => {
      const { fetchMock, call } = setup();
      const spy = await failNextWrite();
      const path = join(dir, "token");
      const res = await call(args(path));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalled();
      expect(res.isError).toBe(true);
      const text = getText(res);
      expect(text.split("\n")[0]).toBe(SANDBOX_PREFIX);
      const body = text.split("\n").slice(1).join("\n");
      expect(body).toMatch(LOST);
      expect(body).toContain(`written to ${path}: ENOSPC`);
      expect(text).not.toContain(NEW_TOKEN);
      expect(text).not.toContain(TEST_TOKEN);
      expect(text).not.toContain("Request to");
      expect(await readdir(dir)).toEqual([]);
    });

    it("with overwrite, keeps the original file and removes the temp file", async () => {
      const { call } = setup();
      const path = join(dir, "existing");
      await writeFile(path, "old\n");
      await failNextWrite();
      const res = await call(args(path, { overwrite: true }));
      expect(res.isError).toBe(true);
      expect(getText(res).split("\n").slice(1).join("\n")).toMatch(LOST);
      expect(await readFile(path, "utf8")).toBe("old\n");
      expect(await readdir(dir)).toEqual(["existing"]);
    });

    it("when the target became a symlink during minting: no temp file left, symlink target unchanged", async () => {
      const path = join(dir, "existing");
      const victim = join(dir, "victim");
      await writeFile(path, "old\n");
      await writeFile(victim, "victim\n");
      const fetchMock = vi.fn().mockImplementation(async () => {
        // Swap the target for a symlink between reservation and commit.
        await unlink(path);
        await symlink(victim, path);
        return new Response(JSON.stringify({ token: NEW_TOKEN }), { status: 201, headers: { "Content-Type": "application/json" } });
      });
      vi.stubGlobal("fetch", fetchMock);
      const mock = makeMockServer();
      const ctx = makeContext();
      registerTokenTools(mock.server, new GameyeClient({ token: TEST_TOKEN, baseUrl: ctx.baseUrl }), ctx);
      const res = await mock.handlers["gameye_create_token"](args(path, { overwrite: true }));

      expect(res.isError).toBe(true);
      const body = getText(res).split("\n").slice(1).join("\n");
      expect(body).toMatch(LOST);
      expect(body).toMatch(/symlink/);
      expect(getText(res)).not.toContain(NEW_TOKEN);
      expect(await readFile(victim, "utf8")).toBe("victim\n");
      expect(await readlink(path)).toBe(victim);
      expect((await readdir(dir)).sort()).toEqual(["existing", "victim"]);
    });
  });

  it("dryRun checks the path, sends nothing and creates nothing", async () => {
    const { fetchMock, call } = setup();
    const path = join(dir, "token");
    const res = await call(args(path, { dryRun: true }));
    expect(res.isError).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
    const text = getText(res);
    expect(text).toContain("POST https://api.sandbox-gameye.gameye.net/token");
    expect(text).toContain('"expires_after": "24h"');
    expect(text).not.toContain(TEST_TOKEN);

    await writeFile(path, "x");
    const refused = await call(args(path, { dryRun: true }));
    expect(refused.isError).toBe(true);
  });

  it("requires an output path in its input schema", async () => {
    const { configs } = setup();
    expect(configs["gameye_create_token"].inputSchema).toHaveProperty("outputPath");
    expect(configs["gameye_create_token"].annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });
});
