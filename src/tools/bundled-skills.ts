import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, type ServerContext, type ToolOutput } from "./common.js";
import {
  BUNDLED_SKILLS,
  BUNDLED_SKILLS_COMMIT,
  BUNDLED_SKILLS_PACK_VERSION,
  BUNDLED_SKILLS_TAG,
  type BundledSkill,
} from "../generated/skills.js";

/** The first line of every bundled-skill result. */
export const BUNDLED_PACK_LINE = `Bundled Gameye skills pack: ${BUNDLED_SKILLS_PACK_VERSION} (gameye-skills ${BUNDLED_SKILLS_TAG}, commit ${BUNDLED_SKILLS_COMMIT.slice(0, 7)}).`;
export const INSTALLED_WINS_LINE = "If an installed copy of the Gameye skills is newer, it wins.";

export const BUNDLED_HEADER = `${BUNDLED_PACK_LINE}\n${INSTALLED_WINS_LINE}`;

const SKILL_FILE = "SKILL.md";

/** Looks like a path escape, an absolute path or a URL rather than a file inside one skill. */
function unsafeReason(value: string): string | undefined {
  if (/^[a-z]:/i.test(value) || (value.startsWith("/") && !value.startsWith("//")) || value.startsWith("\\")) return "an absolute path";
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) return "a URL";
  if (value.split(/[\\/]/).includes("..")) return "a parent-directory path";
  return undefined;
}

function skillNames(): string {
  return BUNDLED_SKILLS.map((s) => s.name).join(", ");
}

function refuse(text: string): ToolOutput {
  return { text: `${BUNDLED_HEADER}\n\n${text}`, isError: true };
}

function filesOf(skill: BundledSkill): string[] {
  return Object.keys(skill.files);
}

export function registerBundledSkillsTools(server: McpServer, ctx: ServerContext): void {
  defineTool(
    server,
    ctx,
    "gameye_list_skills",
    {
      title: "List the bundled Gameye skills",
      description:
        "List the Gameye agent skills bundled with this server: each skill's name, description, version and files, and the bundled pack version. " +
        "Works offline. Read one with gameye_get_skill. If an installed copy of the Gameye skills is newer, it wins.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      requiresToken: false,
    },
    async () => {
      const lines = [BUNDLED_HEADER, ""];
      for (const skill of BUNDLED_SKILLS) {
        lines.push(`• ${skill.name} (skill ${skill.version}): ${skill.description}`);
        lines.push(`  files: ${filesOf(skill).join(", ")}`);
      }
      return lines.join("\n");
    }
  );

  defineTool(
    server,
    ctx,
    "gameye_get_skill",
    {
      title: "Read a bundled Gameye skill",
      description:
        "Read a Gameye agent skill bundled with this server: its SKILL.md, or one of its reference files. " +
        "Works offline and serves only the bundled copy (list names and files with gameye_list_skills). " +
        "If an installed copy of the Gameye skills is newer, it wins.",
      inputSchema: {
        name: z.string().describe("Skill name, e.g. gameye or gameye-containerize"),
        file: z
          .string()
          .optional()
          .describe("File inside the skill, e.g. references/routing.md. Defaults to SKILL.md"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      requiresToken: false,
    },
    async ({ name, file }) => {
      const nameProblem = unsafeReason(name) ?? (/[\\/]/.test(name) ? "a path" : undefined);
      if (nameProblem) return refuse(`Refused: the skill name is ${nameProblem}. Use one of: ${skillNames()}.`);
      const skill = BUNDLED_SKILLS.find((s) => s.name === name);
      // Never echo the supplied name or file: it is user text and may be a pasted token.
      if (!skill) return refuse(`No bundled skill has that name. Bundled skills: ${skillNames()}.`);

      const rel = file ?? SKILL_FILE;
      const fileProblem = unsafeReason(rel);
      if (fileProblem) {
        return refuse(`Refused: the file is ${fileProblem}. Files in ${skill.name}: ${filesOf(skill).join(", ")}.`);
      }
      if (!Object.hasOwn(skill.files, rel)) {
        return refuse(`The bundled ${skill.name} skill has no such file. Files: ${filesOf(skill).join(", ")}.`);
      }
      return [BUNDLED_HEADER, `Skill: ${skill.name} ${skill.version} · ${rel}`, "", skill.files[rel]].join("\n");
    }
  );
}
