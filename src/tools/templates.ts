import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, type ServerContext } from "./common.js";
import { BUNDLED_PACK_LINE, INSTALLED_WINS_LINE } from "./bundled-skills.js";
import { BUNDLED_TEMPLATES, TEMPLATE_ENGINES, TEMPLATE_KINDS, type BundledTemplate } from "../generated/skills.js";

/** A fence of backticks longer than any backtick run in the code, so the block cannot close early. */
function fenceFor(code: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function formatTemplate(t: BundledTemplate): string {
  const fence = fenceFor(t.code);
  return [
    BUNDLED_PACK_LINE,
    INSTALLED_WINS_LINE,
    `Template: ${t.engine}/${t.kind}, from the ${t.skill} skill, section "${t.section}".`,
    ...(t.note ? ["", `Note: ${t.note}`] : []),
    "",
    `${fence}${t.language}\n${t.code}${fence}`,
    "",
    `Read the rest of the skill with gameye_get_skill (name: "${t.skill}") before adapting this template.`,
  ].join("\n");
}

export function registerTemplateTools(server: McpServer, ctx: ServerContext): void {
  defineTool(
    server,
    ctx,
    "gameye_get_template",
    {
      title: "Get an engine's Dockerfile or shutdown-hook template",
      description:
        "Get the Dockerfile or the shutdown-hook template for an Unreal, Unity, Godot or web game server, word for word as published in the bundled Gameye engine skill, with the skill and section it came from. " +
        "Works offline. Read the rest of the skill with gameye_get_skill. If an installed copy of the Gameye skills is newer, it wins.",
      inputSchema: {
        engine: z.enum(TEMPLATE_ENGINES).describe("Game server engine: unreal, unity, godot or web"),
        kind: z.enum(TEMPLATE_KINDS).describe("Template: dockerfile or shutdown-hook"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      requiresToken: false,
    },
    async ({ engine, kind }) => {
      const template = BUNDLED_TEMPLATES.find((t) => t.engine === engine && t.kind === kind);
      // The bundler fails the build unless every engine and kind is present.
      if (!template) throw new Error(`No bundled ${engine}/${kind} template`);
      return formatTemplate(template);
    }
  );
}
