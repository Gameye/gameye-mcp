import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GameyeClient } from "../client.js";
import { formatDryRun } from "../guards.js";
import type { Application, PortBinding, Resources } from "../types.js";
import { defineTool, dryRunInput, type ServerContext } from "./common.js";

// Nested shapes follow client.yaml: Limits, Reservation and PortBinding.

const resources = (what: string) =>
  z
    .object({
      cpu: z.number().positive().describe(`CPU cores ${what}`),
      ram: z.number().int().positive().describe(`RAM in MB ${what}`),
      gpu: z.number().int().min(0).optional().describe(`GPUs ${what}`),
    })
    .strict();

const portBinding = z
  .object({
    requested: z.number().int().min(1).max(65535).describe("Container port"),
    protocol: z.enum(["tcp", "udp"]).describe("Port protocol"),
    tls: z
      .boolean()
      .describe(
        "Gameye terminates TLS for this port on the host; the game server still speaks plain TCP in the container. " +
          "Only gameye_create_application applies it; ports sent through gameye_edit_application end up tls=false"
      ),
  })
  .strict();

const applicationFields = {
  registry: z
    .string()
    .min(1)
    .describe(
      "Name of a Gameye image registry, e.g. 'dockerhub' or 'ghcr'. The server looks the name up and returns 404 if it is unknown; gameye_list_applications shows the names your applications use"
    ),
  repository: z.string().min(1).describe("Image repository in that registry, without a tag"),
  tagKeep: z.number().int().min(0).describe("How many image tags Gameye keeps for this application"),
  networkMode: z.enum(["host", "bridge"]).describe("Container network mode"),
  limits: resources("the container may use (hard limit)"),
  reservation: resources("reserved on the node when scheduling"),
  nodePool: z.string().min(1).describe("Node pool name"),
  regions: z.array(z.string().min(1)).describe("Region names (see gameye_list_regions)"),
  ports: z.array(portBinding).describe("Container ports to expose"),
};

function formatResources(r: Resources): string {
  return `cpu=${r.cpu} ram=${r.ram}MB${r.gpu ? ` gpu=${r.gpu}` : ""}`;
}

function formatPortBindings(ports: PortBinding[]): string {
  return ports.map((p) => `${p.requested}/${p.protocol}${p.tls ? " (tls)" : ""}`).join(", ");
}

function formatApplication(a: Application): string {
  return [
    `• ${a.name}`,
    `    repository=${a.repository}  registry=${a.registry ?? "(none)"}  tagKeep=${a.tagKeep}  networkMode=${a.networkMode}  nodePool=${a.nodePool ?? "(none)"}`,
    `    limits: ${formatResources(a.limits)}  reservation: ${formatResources(a.reservation)}`,
    `    regions: ${a.regions.join(", ") || "(none)"}`,
    `    ports: ${formatPortBindings(a.ports) || "(none)"}`,
  ].join("\n");
}

export function registerApplicationTools(
  server: McpServer,
  client: GameyeClient,
  ctx: ServerContext
): void {
  // ─── List applications ───────────────────────────────────────────────────────

  defineTool(
    server,
    ctx,
    "gameye_list_applications",
    {
      title: "List applications",
      description:
        "List your organization's applications (images Gameye can run) with registry, repository, resources, regions and ports. Needs the application:read scope.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const { items } = await client.listApplications();
      if (items.length === 0) return "No applications found for this token's organization.";
      return `Found ${items.length} application(s):\n\n${items.map(formatApplication).join("\n")}`;
    }
  );

  // ─── List registry tags ──────────────────────────────────────────────────────

  defineTool(
    server,
    ctx,
    "gameye_list_registry_tags",
    {
      title: "List registry tags",
      description:
        "List the image tags available for an application in its upstream registry (Docker Hub, ECR or GHCR), one page at a time. " +
        "A tag listed here is not necessarily enabled in Gameye; use gameye_enable_tag to enable one and gameye_check_tag to confirm it reached a region. Needs the application:read scope.",
      inputSchema: {
        name: z.string().min(1).describe("Application name"),
        page: z.number().int().min(1).max(1000).optional().describe("Page number, 1-1000 (server default 1)"),
        pageSize: z.number().int().min(1).max(1000).optional().describe("Tags per page, 1-1000 (server default 20)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name, page, pageSize }) => {
      const { versions } = await client.listRegistryTags(name, page, pageSize);
      const where = `page ${page ?? 1}, page size ${pageSize ?? 20}`;
      if (versions.length === 0) return `No registry tags found for ${name} (${where}).`;
      return `Registry tags for ${name} (${where}): ${versions.length}\n${versions.map((v) => `• ${v}`).join("\n")}`;
    }
  );

  // ─── Enable tag ──────────────────────────────────────────────────────────────

  defineTool(
    server,
    ctx,
    "gameye_enable_tag",
    {
      title: "Enable image tag",
      description:
        "Enable an image tag for an application so Gameye preloads it across its infrastructure; re-enabling an existing tag pulls it forward. " +
        "Use this when a registry webhook did not register the tag. The server checks the regions:read scope. Pass dryRun=true to preview the request.",
      inputSchema: {
        name: z.string().min(1).describe("Application name"),
        tag: z.string().min(1).describe("Image tag to enable"),
        dryRun: dryRunInput,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, tag, dryRun }) => {
      if (dryRun) return formatDryRun(ctx, GameyeClient.enableTagRequest(name, tag), client);
      await client.enableTag(name, tag);
      return `Tag ${tag} enabled for ${name}. Preloading can take a while; use gameye_check_tag to confirm it is available in a region.`;
    },
  );

  // ─── Create application ──────────────────────────────────────────────────────

  defineTool(
    server,
    ctx,
    "gameye_create_application",
    {
      title: "Create application",
      description:
        "Admin tool. Create a new application (an image Gameye can run). " +
        "Set tls on a port here if you need it: it can only be set at creation, because gameye_edit_application drops it. " +
        "Needs the application:write scope. Pass dryRun=true to preview the request.",
      inputSchema: {
        name: z.string().min(1).describe("Application name; also the image name used when launching sessions"),
        ...applicationFields,
        dryRun: dryRunInput,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ dryRun, ...body }) => {
      if (dryRun) return formatDryRun(ctx, GameyeClient.createApplicationRequest(body), client);
      await client.createApplication(body);
      return `Application ${body.name} created.`;
    }
  );

  // ─── Edit application ────────────────────────────────────────────────────────

  defineTool(
    server,
    ctx,
    "gameye_edit_application",
    {
      title: "Edit application",
      description:
        "Admin tool. Change an existing application with PUT /application/{name}. Fields you omit stay unchanged; regions and ports, when given, replace the whole list. " +
        "Warning: the server ignores tls on ports sent through edit and stores tls=false, so sending ports here turns off TLS on every port. " +
        "Omit ports to keep existing TLS ports; set TLS ports with gameye_create_application. " +
        "Needs the application:write scope. Pass dryRun=true to preview the request.",
      inputSchema: {
        name: z.string().min(1).describe("Name of the application to edit"),
        registry: applicationFields.registry.optional(),
        repository: applicationFields.repository.optional(),
        tagKeep: applicationFields.tagKeep.optional(),
        networkMode: applicationFields.networkMode.optional(),
        limits: applicationFields.limits.optional(),
        reservation: applicationFields.reservation.optional(),
        nodePool: applicationFields.nodePool.optional(),
        regions: applicationFields.regions.optional().describe("Region names; replaces the whole list"),
        ports: applicationFields.ports
          .optional()
          .describe("Container ports; replaces the whole list and stores tls=false on every port, whatever you send"),
        dryRun: dryRunInput,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ name, dryRun, ...fields }) => {
      const body = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (Object.keys(body).length === 0) {
        return { text: "Nothing to change: give at least one field to edit. No request was sent.", isError: true };
      }
      if (dryRun) return formatDryRun(ctx, GameyeClient.editApplicationRequest(name, body), client);
      await client.editApplication(name, body);
      return `Application ${name} updated: ${Object.keys(body).join(", ")}.`;
    }
  );
}
