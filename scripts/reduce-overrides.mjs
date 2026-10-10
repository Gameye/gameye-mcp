// Reduce gameye-skills' spec/overrides.yaml to the part this repo uses: the
// top-level `tools:` map (MCP tool name per operationId), read by
// tests/parity.test.ts. The rest of that file cites private core source files
// as evidence, so it is never vendored here.
//
// Usage: node scripts/reduce-overrides.mjs < overrides.yaml > reduced.yaml

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HEADER = `# MCP tool names (gameye-mcp), keyed by operationId in spec/client.yaml.
# admin_gated marks tools that need an admin-level scope and sit behind an
# explicit opt-in. Read by tests/parity.test.ts.
#
# Reduced copy of the tools: map in gameye-skills' spec/overrides.yaml, made by
# scripts/reduce-overrides.mjs (npm run sync-spec). Do not edit by hand.
`;

export function reduceOverrides(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^tools:\s*$/.test(l));
  if (start < 0) throw new Error("overrides has no top-level tools: map");
  let end = start + 1;
  while (end < lines.length && !/^\S/.test(lines[end])) end++;
  const block = lines.slice(start, end).filter((l) => l.trim() && !l.trim().startsWith("#"));
  return `${HEADER}\n${block.join("\n")}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(reduceOverrides(readFileSync(0, "utf8")));
}
