import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GameyeClient } from "../../src/client.js";
import {
  AGENT_LABEL_KEY,
  AGENT_LABEL_VALUE,
  DEFAULT_SESSION_TTL,
  applyLaunchDefaults,
  findGitWorkTree,
  findTokenInLaunch,
  formatDryRun,
} from "../../src/guards.js";
import { registerAllTools } from "../../src/tools/register.js";
import type { ServerContext } from "../../src/tools/common.js";
import {
  makeContext,
  makeMockServer,
  makeProductionContext,
  getText,
  PRODUCTION_PREFIX,
  SANDBOX_PREFIX,
  TEST_TOKEN,
  type ToolResult,
} from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

/** Real client and every tool, with fetch mocked. */
function setup(ctx: ServerContext = makeContext(), body: unknown = { id: "s-1", host: "1.2.3.4", ports: [] }, status = 201) {
  const fetchMock = vi.fn().mockImplementation(async () =>
    status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  );
  vi.stubGlobal("fetch", fetchMock);
  const mock = makeMockServer();
  const client = new GameyeClient({ token: TEST_TOKEN, baseUrl: ctx.baseUrl });
  registerAllTools(mock.server, client, ctx);
  const call = (name: string, args: Record<string, unknown>): Promise<ToolResult> => mock.handlers[name](args);
  return { fetchMock, call };
}

function sentBody(fetchMock: ReturnType<typeof vi.fn>, idx = 0): Record<string, unknown> {
  return JSON.parse(String(fetchMock.mock.calls[idx][1].body));
}

const base = { location: "europe", image: "my-game" };

// ─── launch: token refusal ────────────────────────────────────────────────────

describe("launch refuses to pass the configured token", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["env value", { env: { GAMEYE_TOKEN: TEST_TOKEN } }],
    ["env value containing it", { env: { AUTH: `Bearer ${TEST_TOKEN}` } }],
    ["env key", { env: { [TEST_TOKEN]: "x" } }],
    ["args", { args: ["--port", "7777", `--token=${TEST_TOKEN}`] }],
    ["label value", { labels: { owner: TEST_TOKEN } }],
    ["label key", { labels: { [TEST_TOKEN]: "x" } }],
  ];

  for (const [what, extra] of cases) {
    for (const [envName, ctx, prefix] of [
      ["sandbox", makeContext(), SANDBOX_PREFIX],
      ["production", makeProductionContext(), PRODUCTION_PREFIX],
    ] as const) {
      it(`${what} on ${envName}: refused, no request sent, token not echoed`, async () => {
        const { fetchMock, call } = setup(ctx);
        const res = await call("gameye_launch_session", { ...base, ...extra });
        expect(res.isError).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled();
        const text = getText(res);
        expect(text.split("\n")[0]).toBe(prefix);
        expect(text).toMatch(/Launch refused/);
        expect(text).toMatch(/No request was sent/);
        expect(text).not.toContain(TEST_TOKEN);
      });
    }
  }

  it("is refused even with dryRun", async () => {
    const { fetchMock, call } = setup();
    const res = await call("gameye_launch_session", { ...base, env: { X: TEST_TOKEN }, dryRun: true });
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the field without its value", () => {
    const checker = { containsToken: (s: string) => s.includes(TEST_TOKEN), maskToken: (s: string) => s };
    expect(findTokenInLaunch({ ...base, env: { API_KEY: TEST_TOKEN } }, checker)).toBe("env.API_KEY");
    expect(findTokenInLaunch({ ...base, args: ["a", TEST_TOKEN] }, checker)).toBe("args[1]");
    expect(findTokenInLaunch({ ...base, labels: { k: TEST_TOKEN } }, checker)).toBe("labels.k");
    expect(findTokenInLaunch({ ...base, env: { SAFE: "value" } }, checker)).toBeUndefined();
  });
});

// ─── launch: dry run ──────────────────────────────────────────────────────────

describe("launch dryRun", () => {
  it("sends nothing and returns method, host, path and body", async () => {
    const { fetchMock, call } = setup();
    const res = await call("gameye_launch_session", { ...base, env: { PORT: "7777" }, dryRun: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.isError).toBeUndefined();
    const text = getText(res);
    expect(text).toContain("Dry run: nothing was sent.");
    expect(text).toContain("Host:        api.sandbox-gameye.gameye.net");
    expect(text).toContain("POST https://api.sandbox-gameye.gameye.net/session");
    expect(text).toContain("Path:        /session");
    expect(text).toContain("Authorization: Bearer ***");
    expect(text).toContain(`"ttl": "${DEFAULT_SESSION_TTL}"`);
    expect(text).toContain(`"${AGENT_LABEL_KEY}": "${AGENT_LABEL_VALUE}"`);
    expect(text).not.toContain(TEST_TOKEN);
  });

  it("masks the token anywhere in the rendered request", () => {
    const checker = {
      containsToken: (s: string) => s.includes(TEST_TOKEN),
      maskToken: (s: string) => s.split(TEST_TOKEN).join("***"),
    };
    const text = formatDryRun(makeContext(), { method: "POST", path: "/x", body: { note: `a${TEST_TOKEN}b` } }, checker);
    expect(text).not.toContain(TEST_TOKEN);
    expect(text).toContain('"note": "a***b"');
  });
});

// ─── launch: default TTL and agent label ──────────────────────────────────────

describe("launch defaults", () => {
  for (const [envName, ctx, prefix] of [
    ["sandbox", makeContext(), SANDBOX_PREFIX],
    ["production", makeProductionContext(), PRODUCTION_PREFIX],
  ] as const) {
    it(`sends the default TTL and agent label on ${envName} and says so`, async () => {
      const { fetchMock, call } = setup(ctx);
      const res = await call("gameye_launch_session", { ...base, labels: { mode: "comp" } });
      expect(res.isError).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = sentBody(fetchMock);
      expect(body.ttl).toBe(DEFAULT_SESSION_TTL);
      expect(body.labels).toEqual({ mode: "comp", [AGENT_LABEL_KEY]: AGENT_LABEL_VALUE });
      const text = getText(res);
      expect(text.split("\n")[0]).toBe(prefix);
      expect(text).toMatch(/TTL:\s+30m \(default applied/);
    });
  }

  it("keeps an explicit TTL and does not claim a default", async () => {
    const { fetchMock, call } = setup();
    const res = await call("gameye_launch_session", { ...base, ttl: "2h" });
    expect(sentBody(fetchMock).ttl).toBe("2h");
    expect(getText(res)).toMatch(/TTL:\s+2h$/m);
    expect(getText(res)).not.toContain("default applied");
  });

  it("overwrites a caller-provided launched-by label, so the provenance marker cannot be hidden", () => {
    const { request } = applyLaunchDefaults({ ...base, labels: { [AGENT_LABEL_KEY]: "my-bot", mode: "comp" } });
    expect(request.labels).toEqual({ [AGENT_LABEL_KEY]: AGENT_LABEL_VALUE, mode: "comp" });
  });

  it("sends launched-by=gameye-mcp even when the caller passes its own value", async () => {
    const { fetchMock, call } = setup();
    await call("gameye_launch_session", { ...base, labels: { [AGENT_LABEL_KEY]: "" } });
    expect(sentBody(fetchMock).labels).toEqual({ [AGENT_LABEL_KEY]: AGENT_LABEL_VALUE });
  });

  it("does not mutate the input", () => {
    const input = { ...base, labels: { a: "1" } };
    applyLaunchDefaults(input);
    expect(input).toEqual({ ...base, labels: { a: "1" } });
  });
});

// ─── stop ─────────────────────────────────────────────────────────────────────

describe("stop requires one explicit session ID", () => {
  for (const [envName, ctx] of [
    ["sandbox", makeContext()],
    ["production", makeProductionContext()],
  ] as const) {
    for (const id of [undefined, "", "   ", "*", "s1,s2", "s1 s2"]) {
      it(`refuses id=${JSON.stringify(id)} on ${envName} without sending`, async () => {
        const { fetchMock, call } = setup(ctx, {}, 204);
        const res = await call("gameye_stop_session", id === undefined ? {} : { id });
        expect(res.isError).toBe(true);
        expect(getText(res)).toMatch(/Stop refused/);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    }
  }

  it("stops an explicit ID", async () => {
    const { fetchMock, call } = setup(makeContext(), {}, 204);
    const res = await call("gameye_stop_session", { id: "s-1" });
    expect(res.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });

  it("dryRun sends nothing and shows DELETE /session/{id}", async () => {
    const { fetchMock, call } = setup(makeContext(), {}, 204);
    const text = getText(await call("gameye_stop_session", { id: "s-1", dryRun: true }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(text).toContain("DELETE https://api.sandbox-gameye.gameye.net/session/s-1");
  });
});

// ─── enable tag and application and token writes: dry run ─────────────────────

describe("dryRun on enable-tag, application and token writes sends nothing", () => {
  const app = {
    name: "my-game",
    registry: "dockerhub",
    repository: "acme/my-game",
    tagKeep: 5,
    networkMode: "bridge",
    limits: { cpu: 2, ram: 2048 },
    reservation: { cpu: 1, ram: 1024 },
    nodePool: "default",
    regions: ["europe"],
    ports: [{ requested: 7777, protocol: "udp", tls: false }],
  };

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["gameye_enable_tag", { name: "my-game", tag: "1.2.3" }, "POST https://api.sandbox-gameye.gameye.net/application/my-game/tags"],
    ["gameye_create_application", app, "POST https://api.sandbox-gameye.gameye.net/application"],
    ["gameye_edit_application", { name: "my-game", tagKeep: 3 }, "PUT https://api.sandbox-gameye.gameye.net/application/my-game"],
  ];

  for (const [tool, args, line] of cases) {
    it(tool, async () => {
      const { fetchMock, call } = setup(makeContext(), {}, 204);
      const res = await call(tool, { ...args, dryRun: true });
      expect(res.isError).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getText(res)).toContain(line);
      expect(getText(res)).not.toContain(TEST_TOKEN);
    });
  }
});

// ─── git working tree detection ───────────────────────────────────────────────

describe("findGitWorkTree", () => {
  it("finds a .git directory in an ancestor and nothing outside", async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "gameye-guards-")));
    try {
      await mkdir(join(root, "repo", ".git"), { recursive: true });
      await mkdir(join(root, "repo", "a", "b"), { recursive: true });
      expect(findGitWorkTree(join(root, "repo", "a", "b"))).toBe(join(root, "repo"));
      expect(findGitWorkTree(root)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
