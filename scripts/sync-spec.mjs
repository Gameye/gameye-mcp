// Refresh the vendored API spec snapshots.
//
//   spec/client.yaml     <- https://api.sandbox-gameye.gameye.net/openapi.yaml (public live spec)
//   spec/overrides.yaml  <- the tools: map of gameye-skills spec/overrides.yaml
//                           (a local path or a URL), reduced by
//                           scripts/reduce-overrides.mjs so the core source
//                           evidence in the full file is never vendored
//
// Usage:
//   node scripts/sync-spec.mjs [overrides-path-or-url] [--check]
//
// The overrides source defaults to ../gameye-skills/spec/overrides.yaml.
// With --check nothing is written; the script exits 1 if either snapshot
// differs from its source.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { reduceOverrides } from "./reduce-overrides.mjs";

const CLIENT_SPEC_URL = "https://api.sandbox-gameye.gameye.net/openapi.yaml";
const DEFAULT_OVERRIDES = "../gameye-skills/spec/overrides.yaml";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const check = args.includes("--check");
const positional = args.filter((a) => !a.startsWith("--"));
const unknown = args.filter((a) => a.startsWith("--") && a !== "--check");
if (unknown.length || positional.length > 1) {
  console.error("Usage: node scripts/sync-spec.mjs [overrides-path-or-url] [--check]");
  process.exit(2);
}
const overridesSource = positional[0] ?? DEFAULT_OVERRIDES;

async function fetchText(url) {
  const res = await fetch(url, { headers: { Accept: "application/yaml, text/yaml, */*" } });
  if (!res.ok) throw new Error(`GET ${url} returned HTTP ${res.status}`);
  return res.text();
}

async function load(source) {
  if (/^https?:\/\//.test(source)) return fetchText(source);
  return readFile(resolve(repoRoot, source), "utf8");
}

async function readOrEmpty(path) {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

const targets = [
  { file: "spec/client.yaml", source: CLIENT_SPEC_URL, transform: (text) => text },
  { file: "spec/overrides.yaml", source: overridesSource, transform: reduceOverrides },
];

let drift = false;
for (const { file, source, transform } of targets) {
  const path = resolve(repoRoot, file);
  let fresh;
  try {
    fresh = transform(await load(source));
  } catch (err) {
    console.error(`ERROR: could not read ${source}: ${err.message}`);
    process.exit(2);
  }
  if (!fresh.trim()) {
    console.error(`ERROR: ${source} is empty`);
    process.exit(2);
  }
  const current = await readOrEmpty(path);
  if (current === fresh) {
    console.log(`${file}: up to date (${source})`);
    continue;
  }
  if (check) {
    drift = true;
    console.error(`${file}: DRIFT from ${source}. Run: npm run sync-spec`);
  } else {
    await writeFile(path, fresh);
    console.log(`${file}: updated from ${source}`);
  }
}

if (drift) process.exit(1);
