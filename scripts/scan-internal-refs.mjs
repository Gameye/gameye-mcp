#!/usr/bin/env node
// Fail if the repository contains references that must not be public.
//
// Node port of gameye-skills' scripts/scan_internal_refs.py; keep the two in step,
// except core-source-path (gameye-mcp only).
//
// Rules: personal-path (/Users/<name>, /home/<name> except generic container
// users, /Volumes/<name>, C:\Users\<name>), test-host (the local development
// API host outside test files), private-host (planz-development, any
// *.gameye.net host other than the two public API hosts, the internal GitLab
// group), personal-email (gmail.com, @gameye.com other than generic support
// mailboxes), placeholder (your-org), internal-doc (LAUNCH_PLAN),
// core-source-path (a Go file under internal/ in the private core repo, such as
// the evidence entries spec/overrides.yaml carries in gameye-skills).
//
// Allowed on purpose: test files may use the gameye.test host and made-up core
// source paths as fixtures; this scanner itself; ALLOWED_HITS below.
//
// Usage:
//   node scripts/scan-internal-refs.mjs [ROOT]
//   node scripts/scan-internal-refs.mjs --self-test

import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", "dist", ".venv", "venv", "__pycache__",
  ".pytest_cache", "coverage",
]);
const EXCLUDED_FILES = new Set([".DS_Store"]);
const SELF_FILES = new Set([
  "scripts/scan-internal-refs.mjs",
  "scripts/scan_internal_refs.py",
  "scripts/tests/test_scan_internal_refs.py",
]);
// "path|rule" pairs that are deliberate. Each needs a reason.
const ALLOWED_HITS = new Set([
  // The package-content guard names the internal doc to forbid it.
  "scripts/check-pack.mjs|internal-doc",
]);

const PUBLIC_GAMEYE_NET_HOSTS = new Set([
  "api.sandbox-gameye.gameye.net",
  "api.production-gameye.gameye.net",
]);
const GENERIC_GAMEYE_MAILBOXES = new Set(["support", "noreply", "no-reply"]);
const GENERIC_HOME_USERS = new Set([
  "app", "appuser", "container", "game", "gameserver", "node", "nonroot",
  "runner", "server", "steam", "ubuntu", "user", "username", "you",
]);

// [rule, regex (global), predicate | null, applies in test files]
const RULES = [
  ["personal-path", /\/Users\/[A-Za-z0-9._-]+/g, null, true],
  ["personal-path", /(?<![\w.-])\/home\/([A-Za-z0-9._-]+)/g,
    (m) => !GENERIC_HOME_USERS.has(m[1].toLowerCase()), true],
  ["personal-path", /\/Volumes\/[A-Za-z0-9._-]+/g, null, true],
  ["personal-path", /[A-Za-z]:\\+Users\\+[A-Za-z0-9._-]+/g, null, true],
  ["personal-path", /(?<![\w.])~\/[A-Za-z]/g, null, true],
  ["test-host", /\bgameye\.test\b/gi, null, false],
  ["private-host", /\bplanz(?:-dev(?:elopment)?)?\b/gi, null, true],
  ["private-host", /\b(?:[a-z0-9-]+\.)+gameye\.net\b/gi,
    (m) => !PUBLIC_GAMEYE_NET_HOSTS.has(m[0].toLowerCase()), true],
  ["private-host", /gitlab\.com[:/]gameye/gi, null, true],
  ["personal-email", /[A-Za-z0-9._%+-]+@gmail\.com/gi, null, true],
  ["personal-email", /\b([A-Za-z0-9._%+-]+)@gameye\.com\b/gi,
    (m) => !GENERIC_GAMEYE_MAILBOXES.has(m[1].toLowerCase()), true],
  ["placeholder", /your-org\b/gi, null, true],
  ["internal-doc", /LAUNCH_PLAN/g, null, true],
  ["core-source-path", /(?<![\w-])internal\/[a-z0-9_]+\/[\w./-]*\.go\b/g, null, false],
];

export function isTestFile(rel) {
  const parts = rel.split("/");
  const name = parts.pop();
  if (parts.some((p) => ["tests", "test", "__tests__", "fixtures"].includes(p))) return true;
  return name.startsWith("test_") || name.includes(".test.") || name.includes(".spec.")
    || name.endsWith("_test.py");
}

export function scanText(rel, text) {
  rel = rel.split(sep).join("/");
  if (SELF_FILES.has(rel)) return [];
  const inTest = isTestFile(rel);
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [rule, re, predicate, inTests] of RULES) {
      if (inTest && !inTests) continue;
      for (const m of line.matchAll(re)) {
        if (predicate && !predicate(m)) continue;
        if (ALLOWED_HITS.has(`${rel}|${rule}`)) continue;
        hits.push({ path: rel, line: i + 1, rule, excerpt: m[0] });
      }
    }
  });
  return hits;
}

function* walk(root, dir = root) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) yield* walk(root, full);
    } else if (entry.isFile() && !EXCLUDED_FILES.has(entry.name)) {
      yield full;
    }
  }
}

export function scan(root) {
  const hits = [];
  for (const file of walk(root)) {
    let data;
    try {
      if (!lstatSync(file).isFile()) continue;
      data = readFileSync(file);
    } catch {
      continue;
    }
    if (data.subarray(0, 8192).includes(0)) continue; // binary
    hits.push(...scanText(relative(root, file), data.toString("utf8")));
  }
  return hits;
}

function selfTest() {
  const cases = [
    ["README.md", "Point at https://api.gameye.test/session", ["test-host"]],
    ["tests/unit/client.test.ts", "const host = 'https://api.gameye.test';", []],
    ["README.md", "see /Users/x/projects", ["personal-path"]],
    ["tests/unit/a.test.ts", "'/Users/x/'", ["personal-path"]],
    ["README.md", "WORKDIR /home/gameserver/app", []],
    ["README.md", "cat /home/alice/.bashrc", ["personal-path"]],
    ["spec/overrides.yaml", "- {file: internal/agent/session/stop.go, function: Stop}", ["core-source-path"]],
    ["README.md", "the internal/ folder", []],
    ["README.md", "see ./internal/agent/session/stop.go", ["core-source-path"]],
    ["docs/notes.md", "core/internal/agent/session/stop.go", ["core-source-path"]],
    ["tests/unit/a.test.ts", "{file: internal/example/fixture/run.go}", []],
    ["README.md", "https://api.sandbox-gameye.gameye.net https://api.production-gameye.gameye.net https://helpdesk.gameye.com/", []],
    ["README.md", "https://grafana.ops.gameye.net/", ["private-host"]],
    ["README.md", "https://gitlab.com/gameye/core", ["private-host"]],
    ["README.md", "git@gitlab.com:gameye/core.git", ["private-host"]],
    ["README.md", "deploy to planz-dev first", ["private-host"]],
    ["README.md", "see ~/Projects/gameye/core", ["personal-path"]],
    ["README.md", "the planzone module", []],
    ["README.md", "support@gameye.com", []],
    ["README.md", "jane@gameye.com", ["personal-email"]],
    ["README.md", "github.com/your-org/repo", ["placeholder"]],
    ["README.md", "LAUNCH_PLAN.md", ["internal-doc"]],
    ["scripts/check-pack.mjs", "[/LAUNCH_PLAN/, \"LAUNCH_PLAN\"]", []],
  ];
  let failed = 0;
  for (const [rel, text, expected] of cases) {
    const got = scanText(rel, text).map((h) => h.rule);
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      failed++;
      console.error(`FAIL ${rel}: ${JSON.stringify(text)} -> ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    }
  }
  console.log(failed ? `${failed} self-test case(s) failed` : `self-test OK (${cases.length} cases)`);
  return failed ? 1 : 0;
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest();
  const root = argv[0] ?? DEFAULT_ROOT;
  const hits = scan(root);
  for (const h of hits) console.log(`${h.path}:${h.line}: ${h.rule}: ${h.excerpt}`);
  if (hits.length) {
    console.error(`\n${hits.length} internal reference(s) found. Remove them, or, if one is a deliberate `
      + "public reference, extend ALLOWED_HITS in scripts/scan-internal-refs.mjs with a reason.");
    return 1;
  }
  console.log("OK - no internal references found");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
