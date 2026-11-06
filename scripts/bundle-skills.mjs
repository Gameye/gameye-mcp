// Build src/generated/skills.ts from a pinned gameye-skills checkout. Pure:
// the same input always gives the same bytes, so `npm run check-skills` can
// compare the regenerated module with the committed one.
//
// Input (JSON): { tag, commit, files: { "skills/<name>/SKILL.md": text,
//   "skills/<name>/references/<file>.md": text, ... } }
// Output: a TypeScript module with the pack constants, the skill index with
// every file's text, the numbered container-contract items from
// gameye-containerize, and the templates marked in each engine skill with
// <!-- gameye-template: <engine>/<kind> --> ... <!-- /gameye-template -->.
// Every engine and kind must be marked once, or the build fails.
//
// Usage: node scripts/bundle-skills.mjs < input.json > skills.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const PACK_VERSION_RE = /^Pack version: (\d+\.\d+\.\d+)[ \t]*$/m;
export const TAG_RE = /^v\d+\.\d+\.\d+$/;
const FILE_RE = /^skills\/([a-z0-9][a-z0-9-]*)\/(SKILL\.md|references\/[A-Za-z0-9._-]+\.md)$/;
const CONTRACT_SKILL = "gameye-containerize";
const CONTRACT_HEADING = "## The container contract";

const TEMPLATE_ENGINES = ["unreal", "unity", "godot", "web"];
const TEMPLATE_KINDS = ["dockerfile", "shutdown-hook"];
const TEMPLATE_OPEN_RE = /^<!-- gameye-template: (\S+?)\/(\S+) -->$/;
const TEMPLATE_CLOSE = "<!-- /gameye-template -->";
const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^#{1,6} +(.*?)[ \t#]*$/;

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** name, description and metadata.version from a SKILL.md frontmatter block. */
function parseFrontmatter(path, text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error(`${path} has no frontmatter`);
  const field = (re) => {
    const v = re.exec(m[1])?.[1]?.trim();
    return v?.replace(/^(["'])(.*)\1$/, "$2");
  };
  const name = field(/^name:[ \t]*(.+)$/m);
  const description = field(/^description:[ \t]*(.+)$/m);
  const version = field(/^metadata:[ \t]*\n(?:[ \t]+.*\n)*?[ \t]+version:[ \t]*(.+)$/m);
  if (!name || !description || !version) throw new Error(`${path} frontmatter needs name, description and metadata.version`);
  return { name, description, version };
}

/** The numbered items under "## The container contract", each as one line of text. */
function extractContract(path, text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === CONTRACT_HEADING);
  if (start < 0) throw new Error(`${path} has no "${CONTRACT_HEADING}" section`);
  const items = [];
  let current;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6} /.test(line)) break;
    const item = /^(\d+)\.\s+(.*)$/.exec(line);
    if (item) {
      current = { number: Number(item[1]), parts: [item[2].trim()] };
      items.push(current);
    } else if (current && /^\s+\S/.test(line)) {
      current.parts.push(line.trim());
    } else {
      current = undefined;
    }
  }
  if (items.length === 0) throw new Error(`${path} has no numbered items under "${CONTRACT_HEADING}"`);
  items.forEach((it, i) => {
    if (it.number !== i + 1) throw new Error(`${path} container contract items are not numbered 1..n`);
  });
  return items.map(({ number, parts }) => ({ number, text: parts.join(" ") }));
}

const engineSkill = (engine) => `gameye-${engine}-server`;

/** Whether `line` closes a fence opened with `open`: the same character, at least as many, nothing else. */
function closes(line, open) {
  const run = line.trim();
  return run.length >= open.length && run === open[0].repeat(run.length);
}

/**
 * Every marked template in one SKILL.md. A pair wraps exactly one fenced block
 * and may hold prose beside it (the note), but no heading. Marker-like lines
 * inside other fenced blocks are text, not markers.
 */
function extractTemplates(skill, text) {
  const path = `skills/${skill}/SKILL.md`;
  const lines = text.split("\n");
  const found = [];
  let section = "";
  let fence; // the open fence outside a pair, e.g. "```"
  let pair; // the pair being read

  for (const [i, line] of lines.entries()) {
    const at = `${path} line ${i + 1}`;
    if (pair) {
      if (pair.fence) {
        if (closes(line, pair.fence)) {
          pair.fence = undefined;
          pair.fences += 1;
        } else {
          pair.code.push(line);
        }
        continue;
      }
      if (line === TEMPLATE_CLOSE) {
        const id = `${pair.engine}/${pair.kind}`;
        if (pair.fences !== 1) throw new Error(`${path}: template ${id} must wrap exactly one fenced block, found ${pair.fences}`);
        if (pair.kind === "dockerfile" && pair.language !== "dockerfile") {
          throw new Error(`${path}: template ${id} must be a dockerfile fence, found "${pair.language}"`);
        }
        const note = pair.note.join("\n").trim();
        found.push({
          engine: pair.engine,
          kind: pair.kind,
          skill,
          section: pair.section,
          language: pair.language,
          code: pair.code.map((l) => `${l}\n`).join(""),
          ...(note ? { note } : {}),
        });
        pair = undefined;
        continue;
      }
      if (TEMPLATE_OPEN_RE.test(line)) throw new Error(`${at}: template ${pair.engine}/${pair.kind} is not closed before the next marker`);
      if (HEADING_RE.test(line)) throw new Error(`${at}: template ${pair.engine}/${pair.kind} holds a heading; only a fenced block and a short note may sit inside a pair`);
      const f = FENCE_RE.exec(line);
      if (f) {
        if (pair.fences > 0) throw new Error(`${path}: template ${pair.engine}/${pair.kind} must wrap exactly one fenced block, found more`);
        pair.fence = f[1];
        pair.language = f[2].trim();
        continue;
      }
      pair.note.push(line);
      continue;
    }
    if (fence) {
      if (closes(line, fence)) fence = undefined;
      continue;
    }
    const f = FENCE_RE.exec(line);
    if (f) {
      fence = f[1];
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h) {
      section = h[1];
      continue;
    }
    if (line === TEMPLATE_CLOSE) throw new Error(`${at}: closing template marker with no open marker`);
    const m = TEMPLATE_OPEN_RE.exec(line);
    if (m) {
      const [, engine, kind] = m;
      const id = `${engine}/${kind}`;
      if (!TEMPLATE_ENGINES.includes(engine)) throw new Error(`${at}: template ${id} names unknown engine "${engine}" (expected ${TEMPLATE_ENGINES.join(", ")})`);
      if (!TEMPLATE_KINDS.includes(kind)) throw new Error(`${at}: template ${id} names unknown kind "${kind}" (expected ${TEMPLATE_KINDS.join(", ")})`);
      if (skill !== engineSkill(engine)) throw new Error(`${at}: template ${id} belongs in ${engineSkill(engine)}, not ${skill}`);
      pair = { engine, kind, section, note: [], code: [], fences: 0, language: "" };
    } else if (line.includes("gameye-template")) {
      throw new Error(`${at}: malformed template marker; markers sit alone on their line as <!-- gameye-template: <engine>/<kind> --> and ${TEMPLATE_CLOSE}`);
    }
  }
  if (pair) throw new Error(`${path}: template ${pair.engine}/${pair.kind} is not closed (unclosed marker; add ${TEMPLATE_CLOSE})`);
  return found;
}

/** One template per engine and kind, in TEMPLATE_ENGINES x TEMPLATE_KINDS order. */
function collectTemplates(index) {
  const all = index.flatMap((s) => extractTemplates(s.name, s.files["SKILL.md"]));
  const result = [];
  for (const engine of TEMPLATE_ENGINES) {
    for (const kind of TEMPLATE_KINDS) {
      const matches = all.filter((t) => t.engine === engine && t.kind === kind);
      const skill = engineSkill(engine);
      if (matches.length === 0) {
        throw new Error(`skills/${skill}/SKILL.md has no ${kind} template: mark it with <!-- gameye-template: ${engine}/${kind} --> ... ${TEMPLATE_CLOSE}`);
      }
      if (matches.length > 1) throw new Error(`skills/${skill}/SKILL.md marks template ${engine}/${kind} more than once`);
      result.push(matches[0]);
    }
  }
  return result;
}

export function bundleSkills(input) {
  const { tag, commit, files } = input ?? {};
  if (typeof tag !== "string" || !TAG_RE.test(tag)) throw new Error(`tag must look like v1.2.3, got ${tag}`);
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) throw new Error(`commit must be a 40-character hex SHA, got ${commit}`);
  if (!files || typeof files !== "object") throw new Error("files must be an object of path -> text");

  const skills = new Map();
  for (const path of Object.keys(files).sort(byCodePoint)) {
    const m = FILE_RE.exec(path);
    if (!m) throw new Error(`unexpected file ${path}`);
    if (typeof files[path] !== "string") throw new Error(`${path} must be text`);
    const [, name, rel] = m;
    if (!skills.has(name)) skills.set(name, {});
    skills.get(name)[rel] = files[path];
  }

  const index = [];
  for (const name of [...skills.keys()].sort(byCodePoint)) {
    const skillFiles = skills.get(name);
    const path = `skills/${name}/SKILL.md`;
    if (skillFiles["SKILL.md"] === undefined) throw new Error(`${path} is missing`);
    const fm = parseFrontmatter(path, skillFiles["SKILL.md"]);
    if (fm.name !== name) throw new Error(`${path} frontmatter name is ${fm.name}, expected ${name}`);
    const sortedFiles = Object.fromEntries(Object.keys(skillFiles).sort(byCodePoint).map((k) => [k, skillFiles[k]]));
    index.push({ name, description: fm.description, version: fm.version, files: sortedFiles });
  }

  const packVersion = PACK_VERSION_RE.exec(files["skills/gameye/SKILL.md"] ?? "")?.[1];
  if (!packVersion) throw new Error('skills/gameye/SKILL.md has no "Pack version: X.Y.Z" line');
  const contractPath = `skills/${CONTRACT_SKILL}/SKILL.md`;
  if (files[contractPath] === undefined) throw new Error(`${contractPath} is missing`);
  const contract = extractContract(contractPath, files[contractPath]);
  const templates = collectTemplates(index);

  return `// Gameye skills pack, bundled for offline use.
// Pack version: ${packVersion}
// Tag: ${tag}
// Source commit: ${commit}
// Source: https://github.com/Gameye/gameye-skills
// The bundled skill text is MIT licensed: Copyright (c) 2026 Gameye B.V.
// Generated by scripts/sync-skills.mjs. Do not edit.

export interface BundledSkill {
  /** Directory and frontmatter name, e.g. "gameye-containerize". */
  name: string;
  description: string;
  /** The skill's own metadata.version. */
  version: string;
  /** "SKILL.md" and "references/<file>.md", keyed by path relative to the skill. */
  files: Readonly<Record<string, string>>;
}

export interface ContainerContractItem {
  /** The item's number in gameye-containerize "The container contract". */
  number: number;
  text: string;
}

export const TEMPLATE_ENGINES = ${JSON.stringify(TEMPLATE_ENGINES)} as const;
export const TEMPLATE_KINDS = ${JSON.stringify(TEMPLATE_KINDS)} as const;
export type TemplateEngine = (typeof TEMPLATE_ENGINES)[number];
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export interface BundledTemplate {
  engine: TemplateEngine;
  kind: TemplateKind;
  /** The engine skill that publishes it, e.g. "gameye-godot-server". */
  skill: string;
  /** The heading of the section the markers sit in. */
  section: string;
  /** The fence's info string, e.g. "dockerfile". */
  language: string;
  /** The fenced block's content exactly as published, without the fence lines. */
  code: string;
  /** Prose inside the marker pair beside the fence, e.g. the engine version it was tested on. */
  note?: string;
}

export const BUNDLED_SKILLS_PACK_VERSION = ${JSON.stringify(packVersion)};
export const BUNDLED_SKILLS_TAG = ${JSON.stringify(tag)};
export const BUNDLED_SKILLS_COMMIT = ${JSON.stringify(commit)};

export const BUNDLED_SKILLS: readonly BundledSkill[] = ${JSON.stringify(index, null, 2)};

export const CONTAINER_CONTRACT: readonly ContainerContractItem[] = ${JSON.stringify(contract, null, 2)};

/** Template blocks marked <!-- gameye-template: engine/kind --> in the pinned engine skills. */
export const BUNDLED_TEMPLATES: readonly BundledTemplate[] = ${JSON.stringify(templates, null, 2)};
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(bundleSkills(JSON.parse(readFileSync(0, "utf8"))));
}
