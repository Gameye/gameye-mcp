// scripts/reduce-overrides.mjs keeps only the tools: map of gameye-skills'
// spec/overrides.yaml, so the core source evidence never lands in this repo.
// Driven through node because the scripts are plain .mjs without types.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/reduce-overrides.mjs", import.meta.url));

function reduce(text: string): string {
  return execFileSync(process.execPath, [script], { input: text, encoding: "utf8" });
}

const FULL = `# Server-vs-spec divergences for the Gameye client API.
# Evidence paths are in the Gameye core repository on its \`dev\` branch.

tools:
  session-run: {tool: gameye_launch_session}
  # comment inside the map
  create-token: {tool: gameye_create_token, admin_gated: true}

overrides:
  - operation: session-run
    kind: scope
    evidence:
      - {file: internal/example/fixture/run.go, function: Run}

webhooks:
  v1-github-webhook:
    evidence:
      - {file: internal/example/fixture/hook.go, function: Hook}
`;

describe("reduce-overrides", () => {
  it("keeps the tools: map entries", () => {
    const out = reduce(FULL);
    expect(out).toContain("tools:\n  session-run: {tool: gameye_launch_session}\n");
    expect(out).toContain("  create-token: {tool: gameye_create_token, admin_gated: true}\n");
  });

  it("drops the overrides and webhooks sections and every core source path", () => {
    const out = reduce(FULL);
    expect(out).not.toMatch(/^overrides:/m);
    expect(out).not.toMatch(/^webhooks:/m);
    expect(out).not.toContain("internal/");
    expect(out).not.toContain("evidence");
  });

  it("is idempotent, so --check compares the reduced form", () => {
    const once = reduce(FULL);
    expect(reduce(once)).toBe(once);
  });

  it("matches the vendored spec/overrides.yaml exactly", () => {
    const vendored = readFileSync(new URL("../../spec/overrides.yaml", import.meta.url), "utf8");
    expect(reduce(vendored)).toBe(vendored);
  });

  it("refuses input with no top-level tools: map", () => {
    expect(() => reduce("overrides:\n  - operation: x\n")).toThrow();
  });
});
