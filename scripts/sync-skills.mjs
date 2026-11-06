// Refresh the bundled Gameye skills.
//
//   src/generated/skills.ts  <- gameye-skills at the tag in skills.pin (a git
//                               URL or a local repository path), built by
//                               scripts/bundle-skills.mjs
//
// Usage:
//   node scripts/sync-skills.mjs [source] [--check] [--out=<file>]
//
// The source defaults to https://github.com/Gameye/gameye-skills.git. The tag
// is cloned into a temporary directory; sync refuses (exit 2, nothing written)
// if the `Pack version:` in skills/gameye/SKILL.md is not the tag without its v.
// With --check nothing is written; the script exits 1 if the generated module
// differs from a fresh build, or names a different source commit than the tag.
// --out writes to (or checks) another file, for tests.

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACK_VERSION_RE, TAG_RE, bundleSkills } from "./bundle-skills.mjs";

const DEFAULT_SOURCE = "https://github.com/Gameye/gameye-skills.git";
const OUTPUT = "src/generated/skills.ts";
const PIN = "skills.pin";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const check = args.includes("--check");
const outArg = args.find((a) => a.startsWith("--out="));
const positional = args.filter((a) => !a.startsWith("--"));
const unknown = args.filter((a) => a.startsWith("--") && a !== "--check" && a !== outArg);
if (unknown.length || positional.length > 1 || outArg === "--out=") {
  console.error("Usage: node scripts/sync-skills.mjs [source] [--check] [--out=<file>]");
  process.exit(2);
}
const isRemote = (s) => /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(s);
const source = positional[0] ?? DEFAULT_SOURCE;
const cloneFrom = isRemote(source) ? source : resolve(repoRoot, source);
const outPath = resolve(repoRoot, outArg ? outArg.slice("--out=".length) : OUTPUT);

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}

function git(argv, cwd) {
  return execFileSync("git", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function readOrEmpty(path) {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

/** Every skills/<name>/SKILL.md and skills/<name>/references/*.md in the checkout. */
async function collectFiles(checkout) {
  const files = {};
  const skillsDir = join(checkout, "skills");
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsDir, entry.name);
    files[`skills/${entry.name}/SKILL.md`] = await readFile(join(dir, "SKILL.md"), "utf8");
    let refs = [];
    try {
      refs = await readdir(join(dir, "references"), { withFileTypes: true });
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    for (const ref of refs) {
      if (ref.isFile() && ref.name.endsWith(".md")) {
        files[`skills/${entry.name}/references/${ref.name}`] = await readFile(join(dir, "references", ref.name), "utf8");
      }
    }
  }
  return files;
}

const tag = (await readOrEmpty(resolve(repoRoot, PIN))).trim();
if (!TAG_RE.test(tag)) fail(`${PIN} must hold one release tag like v1.6.1, got "${tag}"`);

const tmp = await mkdtemp(join(tmpdir(), "gameye-skills-"));
let fresh;
let commit;
try {
  const checkout = join(tmp, "gameye-skills");
  try {
    git(["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", tag, cloneFrom, checkout]);
    commit = git(["rev-parse", "HEAD^{commit}"], checkout);
  } catch (err) {
    fail(`could not check out ${tag} from ${source}: ${(err.stderr || err.message).toString().trim()}`);
  }
  const gameyeSkill = await readOrEmpty(join(checkout, "skills", "gameye", "SKILL.md"));
  const packVersion = PACK_VERSION_RE.exec(gameyeSkill)?.[1];
  if (packVersion !== tag.slice(1)) {
    fail(`${tag} at ${source} has Pack version ${packVersion ?? "(none)"} in skills/gameye/SKILL.md, expected ${tag.slice(1)}. Nothing written.`);
  }
  try {
    fresh = bundleSkills({ tag, commit, files: await collectFiles(checkout) });
  } catch (err) {
    fail(`could not bundle ${tag} from ${source}: ${err.message}`);
  }
} finally {
  await rm(tmp, { recursive: true, force: true });
}

const rel = outArg ? outPath : OUTPUT;
const current = await readOrEmpty(outPath);
if (current === fresh) {
  console.log(`${rel}: up to date (${source} ${tag} ${commit})`);
  process.exit(0);
}
if (check) {
  const headerCommit = /^\/\/ Source commit: ([0-9a-f]{40})$/m.exec(current)?.[1];
  if (headerCommit && headerCommit !== commit) {
    console.error(`${rel}: source commit ${headerCommit} is not ${tag}'s commit ${commit}. Run: npm run sync-skills`);
  } else {
    console.error(`${rel}: DRIFT from ${source} ${tag}. Run: npm run sync-skills`);
  }
  process.exit(1);
}
await writeFile(outPath, fresh);
console.log(`${rel}: updated from ${source} ${tag} (${commit})`);
