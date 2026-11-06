import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BETA_NOTICE } from "./beta.js";
import { NO_PASTE_RULE, RESTART_RULE, TOKEN_FREE_TOOLS, TOKEN_SIGNUP_STEPS } from "./tokenless.js";

/** What the server knows about its configuration when it builds the instructions. */
export interface ServerMode {
  hasToken: boolean;
}

/** The engine skills an agent reads after the `gameye` skill, one per supported engine. */
export const ENGINE_SKILLS: readonly string[] = [
  "gameye-unity-server",
  "gameye-unreal-server",
  "gameye-godot-server",
  "gameye-web-server",
];

function orList(items: readonly string[], word: "and" | "or"): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${word} ${items[items.length - 1]}`;
}

/** The line, in both modes, naming the tools that read the bundled skills. */
export const BUNDLED_SKILLS_LINE =
  "This server bundles the Gameye agent skills: list them with gameye_list_skills and read one with gameye_get_skill, starting with the `gameye` skill.";

/**
 * The instructions sent at initialize. With no token they lead with what works
 * now: the first sentence says no token is configured and names the token-free
 * tools and the first skill to read (R8).
 */
export function serverInstructions(mode: ServerMode): string {
  if (mode.hasToken) return `${BETA_NOTICE}\n${BUNDLED_SKILLS_LINE}`;
  return [
    `No Gameye API token is configured, so only the token-free tools work: ${orList(TOKEN_FREE_TOOLS, "and")}; ` +
      `read the \`gameye\` skill first with gameye_get_skill, then the skill for the game's engine (${orList(ENGINE_SKILLS, "or")}).`,
    "Every other tool needs a token: without one it returns setup steps and sends nothing to the Gameye API, dry runs included.",
    TOKEN_SIGNUP_STEPS,
    RESTART_RULE,
    NO_PASTE_RULE,
    BETA_NOTICE,
  ].join("\n");
}

/** The MCP server, with instructions for its token mode and the beta notice. */
export function createServer(version: string, mode: ServerMode): McpServer {
  return new McpServer({ name: "gameye", version }, { instructions: serverInstructions(mode) });
}
