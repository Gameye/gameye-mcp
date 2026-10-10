// Parity: every operation in the vendored client spec (spec/client.yaml) is
// exposed as a registered MCP tool, or is listed in EXCLUSIONS with a reason.
// Tool names come from the `tools:` map in spec/overrides.yaml, shared with
// gameye-skills so both projects use the same names. Refresh both with `npm run sync-spec`.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GameyeClient } from "../src/client.js";
import { registerAllTools } from "../src/tools/register.js";
import { makeContext, makeMockServer } from "./unit/helpers.js";

const specDir = fileURLToPath(new URL("../spec/", import.meta.url));

/** operationId -> reason it has no tool. Expected to stay empty. */
const EXCLUSIONS: Record<string, string> = {};

/** Tools that intentionally map to no API operation. */
const NON_API_TOOLS = new Set(["gameye_context"]);

function specOperationIds(): string[] {
  const text = readFileSync(`${specDir}client.yaml`, "utf8");
  return [...text.matchAll(/^\s+operationId:\s*['"]?([\w-]+)['"]?\s*$/gm)].map((m) => m[1]);
}

interface ToolMapping {
  tool: string;
  adminGated: boolean;
}

function overridesToolMap(): Record<string, ToolMapping> {
  const lines = readFileSync(`${specDir}overrides.yaml`, "utf8").split("\n");
  const start = lines.findIndex((l) => /^tools:\s*$/.test(l));
  if (start < 0) throw new Error("spec/overrides.yaml has no top-level tools: map");
  const out: Record<string, ToolMapping> = {};
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // next top-level key
    const m = /^\s+([\w-]+):\s*\{\s*tool:\s*([\w]+)\s*(?:,\s*admin_gated:\s*(true|false)\s*)?\}\s*$/.exec(line);
    if (m) out[m[1]] = { tool: m[2], adminGated: m[3] === "true" };
    else if (line.trim() && !line.trim().startsWith("#")) throw new Error(`Unparsed tools: line: ${line}`);
  }
  return out;
}

function registeredTools(admin: boolean): string[] {
  const mock = makeMockServer();
  const ctx = makeContext();
  registerAllTools(mock.server, new GameyeClient({ token: "t", baseUrl: ctx.baseUrl }), ctx, { admin });
  return Object.keys(mock.handlers);
}

/** Return one problem line per operation that has neither a registered tool nor an exclusion. */
function parityProblems(operations: string[], map: Record<string, ToolMapping>, registered: string[]): string[] {
  const have = new Set(registered);
  const problems: string[] = [];
  for (const op of operations) {
    if (EXCLUSIONS[op]) continue;
    const mapping = map[op];
    if (!mapping) {
      problems.push(`operation ${op}: no entry in spec/overrides.yaml tools: and no exclusion`);
    } else if (!have.has(mapping.tool)) {
      problems.push(`operation ${op}: tool ${mapping.tool} is not registered and has no exclusion`);
    }
  }
  return problems;
}

describe("MCP tool parity with the vendored client spec", () => {
  const operations = specOperationIds();
  const map = overridesToolMap();

  it("reads all 17 client operations", () => {
    expect(operations).toHaveLength(17);
    expect(new Set(operations).size).toBe(17);
  });

  it("every operation maps to a registered tool (admin tools enabled)", () => {
    expect(parityProblems(operations, map, registeredTools(true))).toEqual([]);
  });

  it("every exclusion has a reason and names a real operation", () => {
    for (const [op, reason] of Object.entries(EXCLUSIONS)) {
      expect(operations, op).toContain(op);
      expect(reason.trim(), op).not.toBe("");
    }
  });

  it("every registered tool is either mapped to an operation or a known non-API tool", () => {
    const mapped = new Set(Object.values(map).map((m) => m.tool));
    const extra = registeredTools(true).filter((t) => !mapped.has(t) && !NON_API_TOOLS.has(t));
    expect(extra).toEqual([]);
  });

  it("admin-gated tools are registered only with admin tools enabled", () => {
    const off = new Set(registeredTools(false));
    const on = new Set(registeredTools(true));
    for (const [op, m] of Object.entries(map)) {
      expect(on.has(m.tool), `${op} -> ${m.tool} with admin`).toBe(true);
      expect(off.has(m.tool), `${op} -> ${m.tool} without admin`).toBe(!m.adminGated);
    }
  });

  it("fails, naming the operation, when a tool registration is removed", () => {
    const registered = registeredTools(true).filter((t) => t !== "gameye_list_regions");
    expect(parityProblems(operations, map, registered)).toEqual([
      "operation list-regions: tool gameye_list_regions is not registered and has no exclusion",
    ]);
  });
});
