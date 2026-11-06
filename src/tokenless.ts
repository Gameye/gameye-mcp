// No-token mode: which tools work without GAMEYE_API_TOKEN, the scope recipe
// each account tool needs, and the refusal an account tool returns when no
// token is configured. The refusal never asks for the token: credentials stay
// in the server's environment, read once at start.

/** The first line of every no-token refusal. Stable: agents and tests match on it. */
export const TOKEN_REQUIRED_MARKER = "Token required: no GAMEYE_API_TOKEN is configured for this server.";

/**
 * Tools that work without a token. Every other tool needs one: `defineTool`
 * gates any tool that does not set `requiresToken: false`.
 */
export const TOKEN_FREE_TOOLS: readonly string[] = [
  "gameye_context",
  "gameye_update_skills",
  "gameye_list_skills",
  "gameye_get_skill",
  "gameye_check_dockerfile",
];

export type ScopeRecipeName = "Observer" | "Operator" | "Deployer" | "Token admin";

export interface ScopeRecipe {
  name: ScopeRecipeName;
  /** Every scope the recipe grants, including the recipes it builds on. */
  scopes: readonly string[];
  /** What a token with this recipe lets the agent do. */
  summary: string;
}

const OBSERVER = ["session:read", "logs:read", "artifact:read", "regions:read", "region:read", "application:read"];
const OPERATOR = [...OBSERVER, "session:start", "session:stop", "session:write"];
const DEPLOYER = [...OPERATOR, "application:write"];
const TOKEN_ADMIN = [...DEPLOYER, "token:write"];

/** The README "Token scopes" recipes, narrowest first. */
export const SCOPE_RECIPES: readonly ScopeRecipe[] = [
  { name: "Observer", scopes: OBSERVER, summary: "Inspect sessions, logs, artifacts, regions and applications. No changes." },
  { name: "Operator", scopes: OPERATOR, summary: "Also launch and stop sessions and update session state." },
  { name: "Deployer", scopes: DEPLOYER, summary: "Also create and edit applications, so the agent can set up a deployment end to end." },
  { name: "Token admin", scopes: TOKEN_ADMIN, summary: "Also create API tokens." },
];

/** The narrowest recipe for each account tool, from the scope each API operation requires. */
export const TOOL_SCOPE_RECIPE: Readonly<Record<string, ScopeRecipeName>> = {
  gameye_list_sessions: "Observer",
  gameye_describe_session: "Observer",
  gameye_get_logs: "Observer",
  gameye_get_artifacts: "Observer",
  gameye_list_regions: "Observer",
  gameye_get_locations: "Observer",
  gameye_check_tag: "Observer",
  gameye_list_applications: "Observer",
  gameye_list_registry_tags: "Observer",
  gameye_launch_session: "Operator",
  gameye_stop_session: "Operator",
  gameye_player_join: "Operator",
  gameye_player_leave: "Operator",
  gameye_enable_tag: "Deployer",
  gameye_create_application: "Deployer",
  gameye_edit_application: "Deployer",
  gameye_create_token: "Token admin",
};

/** Where a self-serve developer gets a token (sandbox host, this server's default). */
export const TOKEN_SIGNUP_STEPS =
  "Get a token: sign up at https://trial.gameye.com, then in the Gameye Admin Panel open Users → API tokens and create one. " +
  "Self-serve accounts use the sandbox host, which is this server's default (GAMEYE_ENV=sandbox).";

export const RESTART_RULE =
  "The server reads GAMEYE_API_TOKEN once when it starts: after setting or changing it, restart or reconnect the MCP server.";

export const NO_PASTE_RULE =
  "Do not paste the token into this chat. The user sets it in the server configuration themselves.";

export const TOKEN_FREE_LINE = `Works now without a token: ${TOKEN_FREE_TOOLS.join(", ")}.`;

function scopeLine(tool: string): string {
  const name = TOOL_SCOPE_RECIPE[tool];
  const recipe = SCOPE_RECIPES.find((r) => r.name === name);
  if (!recipe) {
    return `Narrowest token scopes for ${tool}: see the Token scopes section of the gameye-mcp README.`;
  }
  return `Narrowest token scopes for ${tool}: ${recipe.name} (${recipe.scopes.join(" ")}). ${recipe.summary}`;
}

/**
 * The refusal an account tool returns when no token is configured. Order per
 * R6: marker; nothing sent; where to get a token; scopes; how to set it per
 * install path; restart; do not paste; what works now.
 */
export function tokenRequiredMessage(tool: string): string {
  return [
    TOKEN_REQUIRED_MARKER,
    "Nothing was sent to the Gameye API, and retrying this call will not help until a token is configured.",
    "",
    TOKEN_SIGNUP_STEPS,
    "",
    scopeLine(tool),
    "",
    "Set the token where this server is configured:",
    "• Claude Code plugin: enter it in the gameye plugin's API token setting.",
    "• Claude Code CLI: re-add the server in your own terminal, passing the token with the -e GAMEYE_API_TOKEN option of `claude mcp add`.",
    "• Other MCP clients: add GAMEYE_API_TOKEN to the env block of the server's mcpServers entry.",
    "• Docker: keep `-e GAMEYE_API_TOKEN` (no value) in the docker run arguments and set the value in the client's env block, so it never appears on the command line.",
    "",
    RESTART_RULE,
    NO_PASTE_RULE,
    "",
    TOKEN_FREE_LINE,
  ].join("\n");
}
