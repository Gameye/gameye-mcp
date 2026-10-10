// Reads `npm pack --dry-run --json` from stdin and asserts the published file list.
// Usage: npm pack --dry-run --json | node scripts/check-pack.mjs
let input = "";
for await (const chunk of process.stdin) input += chunk;

const [pack] = JSON.parse(input);
const files = pack.files.map((f) => f.path);

const required = ["dist/index.js", "package.json", "README.md", "LICENSE"];
const forbidden = [
  [/^src\//, "src/"],
  [/^tests?\//, "tests/"],
  [/\.map$/, ".map"],
  [/demos/, "demos"],
  [/LAUNCH_PLAN/, "LAUNCH_PLAN"],
  [/^skill\//, "skill/"],
  [/^scripts\//, "scripts/"],
  [/(^|\/)\.env/, ".env"],
];

const errors = [];
for (const r of required) if (!files.includes(r)) errors.push(`missing required file: ${r}`);
for (const f of files)
  for (const [re, label] of forbidden) if (re.test(f)) errors.push(`forbidden file (${label}): ${f}`);

console.log(`${pack.name}@${pack.version}: ${files.length} files`);
for (const f of files) console.log(`  ${f}`);
if (errors.length) {
  for (const e of errors) console.error(`ERROR: ${e}`);
  process.exit(1);
}
console.log("Package file list OK");
