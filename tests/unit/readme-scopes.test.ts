// The README "Token scopes" table and the token column of "Available tools"
// must match the one scope-recipe table in src/tokenless.ts (KTD8), which the
// no-token refusal also uses.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GameyeClient } from "../../src/client.js";
import { registerAllTools } from "../../src/tools/register.js";
import { SCOPE_RECIPES, TOKEN_FREE_TOOLS, TOOL_SCOPE_RECIPE } from "../../src/tokenless.js";
import { makeContext, makeMockServer } from "./helpers.js";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

/** The body rows of the first table after a `## heading`, as trimmed cells. */
function tableRows(heading: string): string[][] {
  const start = readme.indexOf(`\n## ${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const lines = readme.slice(start).split("\n");
  const first = lines.findIndex((l) => l.startsWith("|"));
  const rows: string[][] = [];
  for (const line of lines.slice(first + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(line.slice(1, -1).split("|").map((c) => c.trim()));
  }
  return rows;
}

function backticked(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

describe("README Token scopes table", () => {
  it("matches SCOPE_RECIPES row by row: name, full scope set and summary", () => {
    const rows = tableRows("Token scopes");
    const parsed = new Map<string, string[]>();
    const seen = rows.map(([name, scopesCell, summary]) => {
      const base = /^(\w[\w ]*?) \+ /.exec(scopesCell)?.[1];
      const scopes = [...(base ? (parsed.get(base) ?? [`<unknown recipe ${base}>`]) : []), ...backticked(scopesCell)];
      parsed.set(name, scopes);
      return { name, scopes, summary };
    });
    expect(seen).toEqual(SCOPE_RECIPES.map((r) => ({ name: r.name, scopes: [...r.scopes], summary: r.summary })));
  });
});

describe("README Available tools table", () => {
  const rows = tableRows("Available tools");
  const byName = new Map(rows.map((r) => [backticked(r[0])[0], r]));

  it("lists every registered tool exactly once", () => {
    const mock = makeMockServer();
    const ctx = makeContext();
    registerAllTools(mock.server, new GameyeClient({ token: "t", baseUrl: ctx.baseUrl }), ctx);
    expect(rows.map((r) => backticked(r[0])[0]).sort()).toEqual(Object.keys(mock.handlers).sort());
  });

  it("gives each tool the token column from the source table", () => {
    for (const [name, row] of byName) {
      const token = row[2];
      if (TOKEN_FREE_TOOLS.includes(name)) expect(token, name).toBe("none");
      else expect(token, name).toBe(TOOL_SCOPE_RECIPE[name]);
    }
  });
});
