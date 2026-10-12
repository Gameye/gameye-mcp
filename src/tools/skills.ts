import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, type ServerContext } from "./common.js";
import {
  compareVersions,
  defaultSkillsEnv,
  describeInstall,
  fetchLatestPackVersion,
  findSkillsInstalls,
  isOutdated,
  updateCommands,
  type SkillsEnv,
} from "../skills.js";

const RELOAD_NOTE =
  "The running session keeps the skills it already loaded. Start a new session (in Claude Code, /reload-plugins also works for the plugin) to use the update.";

export function registerSkillsTools(server: McpServer, ctx: ServerContext, env: SkillsEnv = defaultSkillsEnv()): void {
  defineTool(
    server,
    ctx,
    "gameye_update_skills",
    {
      title: "Check and update the Gameye skills",
      description:
        "Compare the installed Gameye agent skills with the latest pack on GitHub, and update them. " +
        "Finds installs made with the skills CLI (user-wide or in this project) and the Claude Code plugin gameye@gameye. " +
        "Without apply it only checks and changes nothing. With apply=true it runs each outdated install's own updater " +
        "(npx skills update for the Gameye skills only, or claude plugin update); ask the user before applying. " +
        "Updates come only through those package managers; this tool never downloads or follows skill text itself.",
      inputSchema: {
        apply: z
          .boolean()
          .optional()
          .describe("Run the updates for outdated installs. Omit or false to only check."),
        installedVersion: z
          .string()
          .regex(/^\d+\.\d+\.\d+$/)
          .optional()
          .describe("The `Pack version:` from the gameye skill you have loaded, used when no install is found on disk"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ apply, installedVersion }) => {
      const installs = await findSkillsInstalls(env);
      let latest: string;
      try {
        latest = await fetchLatestPackVersion(env);
      } catch (err) {
        const lines = [
          `Could not read the latest Gameye skills pack version from GitHub: ${err instanceof Error ? err.message : String(err)}`,
          "Nothing was updated.",
        ];
        for (const install of installs) lines.push(`• ${describeInstall(install)}`);
        return { text: lines.join("\n"), isError: true };
      }
      const lines = [`Latest Gameye skills pack: ${latest}`];

      if (installs.length === 0) {
        lines.push("No skills CLI or Claude Code plugin install of the Gameye skills was found.");
        if (installedVersion) {
          lines.push(`The loaded gameye skill reports pack ${installedVersion}.`);
          if (compareVersions(installedVersion, latest) < 0) {
            lines.push(
              "To update, reinstall the way they were installed: `npx skills add gameye/gameye-skills --skill \"*\"` (add -g for user-wide), " +
                "`/plugin marketplace update gameye` for the Claude Code plugin, or copy the skills directories again."
            );
          }
        }
        return lines.join("\n");
      }

      const outdated = installs.filter((i) => isOutdated(i, latest));
      for (const install of installs) {
        lines.push(`• ${describeInstall(install)}${outdated.includes(install) ? " (update available)" : " (up to date)"}`);
      }
      if (outdated.length === 0) return lines.join("\n");

      const commands = outdated.flatMap(updateCommands);
      if (!apply || env.platform === "win32") {
        lines.push("", apply ? "Updating from this server isn't supported on Windows. Run:" : "Call again with apply=true to run:");
        for (const cmd of commands) lines.push(`  ${cmd.join(" ")}`);
        return lines.join("\n");
      }

      let failed = false;
      lines.push("");
      for (const install of outdated) {
        for (const cmd of updateCommands(install)) {
          try {
            const out = await env.run(cmd[0], cmd.slice(1), env.cwd);
            lines.push(`Ran: ${cmd.join(" ")}`, ...(out ? [indentTail(out)] : []));
          } catch (err) {
            failed = true;
            lines.push(`Failed: ${err instanceof Error ? err.message : String(err)}`);
            break;
          }
        }
      }

      const after = await findSkillsInstalls(env);
      lines.push("", "After updating:");
      for (const install of after) {
        const behind = isOutdated(install, latest);
        failed ||= behind;
        lines.push(`• ${describeInstall(install)}${behind ? " (still behind)" : ""}`);
      }
      lines.push("", RELOAD_NOTE);
      return { text: lines.join("\n"), isError: failed };
    }
  );
}

/** The last lines of a command's output, indented, so a long install log doesn't flood the result. */
function indentTail(out: string, max = 15): string {
  const all = out.split("\n");
  const tail = all.slice(-max).map((l) => `    ${l}`);
  return (all.length > max ? ["    …", ...tail] : tail).join("\n");
}
