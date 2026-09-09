import type { AiProject, AiProjectAccess, AiProjectFile, AiProjectKnowledge, AiProjectReference } from "@k2b/cloud/ai";
import { arg, type CloudCliContext, command, confirmFlag, flag, readCliInput } from "@k2b/cloud/cli";
import { jsonRequest, printRows, printValue, readProjectsApi, requireConfirmation } from "./shared";

const path = (projectId: string, suffix = ""): string => `/${encodeURIComponent(projectId)}${suffix}`;

const listProjects = (ctx: CloudCliContext): Promise<{ projects: AiProject[] }> => readProjectsApi(ctx, "/");

const resolveProject = async (ctx: CloudCliContext, reference: string): Promise<AiProject> => {
  const projects = (await listProjects(ctx)).projects;
  const byId = projects.find((project) => project.shortId === reference);
  if (byId) return byId;
  const matches = projects.filter((project) => project.name === reference);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Multiple Projects are named "${reference}". Use the Project ID.`);
  throw new Error(`Unknown Project "${reference}". Use its exact name or ID.`);
};

const readText = (value: Parameters<typeof readCliInput>[0], label: string, required = false): Promise<string | undefined> =>
  readCliInput(value, { label, required, trimFinalNewline: true });

export const assistantProjectCommands = [
  command("projects list", {
    summary: "List accessible Projects",
    async run({ ctx }) {
      const result = await listProjects(ctx);
      printRows(
        ctx,
        result,
        result.projects.map((project) => ({
          id: project.shortId,
          name: project.name,
          permission: project.permission,
          revision: project.revision,
          model: project.defaultModelProfileId ?? "-",
          description: project.description,
        })),
        [{ key: "id" }, { key: "name" }, { key: "permission" }, { key: "revision" }, { key: "model" }, { key: "description" }],
      );
    },
  }),
  command("projects get", {
    summary: "Show one Project",
    args: { project: arg.required({ valueLabel: "project-id-or-name" }) },
    async run({ ctx, args }) {
      const project = await resolveProject(ctx, args.project);
      printValue(ctx, await readProjectsApi(ctx, path(project.shortId)));
    },
  }),
  command("projects create", {
    summary: "Create a Project",
    args: { name: arg.required() },
    flags: {
      description: flag.string(),
      icon: flag.string(),
      instructions: flag.input({ description: "Instructions text or --instructions-file" }),
      model: flag.string({ description: "Default model profile ID" }),
    },
    async run({ ctx, args, flags }) {
      const instructions = await readText(flags.instructions, "Project instructions");
      const result = await readProjectsApi<{ project: AiProject }>(
        ctx,
        "/",
        jsonRequest("POST", {
          name: args.name,
          description: flags.description ?? "",
          icon: flags.icon ?? "ti ti-folders",
          instructions: instructions ?? "",
          ...(flags.model ? { defaultModelProfileId: flags.model } : {}),
        }),
      );
      printValue(ctx, result, `${result.project.shortId}\t${result.project.name}`);
    },
  }),
  command("projects update", {
    summary: "Update a Project",
    args: { project: arg.required({ valueLabel: "project-id-or-name" }) },
    flags: {
      name: flag.string(),
      description: flag.string(),
      icon: flag.string(),
      instructions: flag.input({ description: "Instructions text or --instructions-file" }),
      model: flag.string({ description: "Default model profile ID; pass an empty value to clear" }),
    },
    async run({ ctx, args, flags }) {
      const project = await resolveProject(ctx, args.project);
      const instructions = await readText(flags.instructions, "Project instructions");
      const changes = {
        ...(flags.name !== undefined ? { name: flags.name } : {}),
        ...(flags.description !== undefined ? { description: flags.description } : {}),
        ...(flags.icon !== undefined ? { icon: flags.icon } : {}),
        ...(instructions !== undefined ? { instructions } : {}),
        ...(flags.model !== undefined ? { defaultModelProfileId: flags.model || null } : {}),
      };
      if (!Object.keys(changes).length) throw new Error("Supply a changed Project field.");
      printValue(ctx, await readProjectsApi(ctx, path(project.shortId), jsonRequest("PATCH", changes)), `Updated ${project.name}.`);
    },
  }),
  command("projects delete", {
    summary: "Delete a Project",
    args: { project: arg.required({ valueLabel: "project-id-or-name" }) },
    flags: { yes: confirmFlag("Confirm deleting the Project") },
    async run({ ctx, args, flags }) {
      requireConfirmation(flags.yes, "Deleting a Project");
      const project = await resolveProject(ctx, args.project);
      printValue(ctx, await readProjectsApi(ctx, path(project.shortId), { method: "DELETE" }), `Deleted ${project.name}.`);
    },
  }),
  command("projects knowledge list", {
    summary: "List or search Project knowledge",
    args: { project: arg.required({ valueLabel: "project-id-or-name" }) },
    flags: { search: flag.string({ aliases: ["q"] }) },
    async run({ ctx, args, flags }) {
      const project = await resolveProject(ctx, args.project);
      const suffix = `/knowledge${flags.search ? `?q=${encodeURIComponent(flags.search)}` : ""}`;
      const result = await readProjectsApi<{ knowledge: AiProjectKnowledge[] }>(ctx, path(project.shortId, suffix));
      printRows(
        ctx,
        result,
        result.knowledge.map((item) => ({ id: item.shortId, title: item.title, updated: item.updatedAt })),
        [{ key: "id" }, { key: "title" }, { key: "updated" }],
      );
    },
  }),
  command("projects knowledge add", {
    summary: "Add Project knowledge",
    args: { project: arg.required({ valueLabel: "project-id-or-name" }), title: arg.required() },
    flags: { content: flag.input({ required: true, description: "Knowledge text or --content-file" }) },
    async run({ ctx, args, flags }) {
      const project = await resolveProject(ctx, args.project);
      const content = await readText(flags.content, "Project knowledge", true);
      printValue(ctx, await readProjectsApi(ctx, path(project.shortId, "/knowledge"), jsonRequest("POST", { title: args.title, content })));
    },
  }),
  command("projects knowledge update", {
    summary: "Update Project knowledge",
    args: {
      project: arg.required({ valueLabel: "project-id-or-name" }),
      knowledge: arg.required({ valueLabel: "knowledge-id" }),
    },
    flags: { title: flag.string(), content: flag.input({ description: "Knowledge text or --content-file" }) },
    async run({ ctx, args, flags }) {
      const project = await resolveProject(ctx, args.project);
      const content = await readText(flags.content, "Project knowledge");
      const changes = { ...(flags.title !== undefined ? { title: flags.title } : {}), ...(content !== undefined ? { content } : {}) };
      if (!Object.keys(changes).length) throw new Error("Supply --title or --content.");
      printValue(
        ctx,
        await readProjectsApi(
          ctx,
          path(project.shortId, `/knowledge/${encodeURIComponent(args.knowledge)}`),
          jsonRequest("PATCH", changes),
        ),
      );
    },
  }),
  command("projects knowledge delete", {
    summary: "Delete Project knowledge",
    args: { project: arg.required({ valueLabel: "project-id-or-name" }), knowledge: arg.required({ valueLabel: "knowledge-id" }) },
    flags: { yes: confirmFlag("Confirm deleting Project knowledge") },
    async run({ ctx, args, flags }) {
      requireConfirmation(flags.yes, "Deleting Project knowledge");
      const project = await resolveProject(ctx, args.project);
      printValue(
        ctx,
        await readProjectsApi(ctx, path(project.shortId, `/knowledge/${encodeURIComponent(args.knowledge)}`), { method: "DELETE" }),
      );
    },
  }),
  command("projects files list", {
    summary: "List Project files",
    args: { project: arg.required({ valueLabel: "project-id-or-name" }) },
    async run({ ctx, args }) {
      const project = await resolveProject(ctx, args.project);
      const result = await readProjectsApi<{ files: AiProjectFile[] }>(ctx, path(project.shortId, "/files"));
      printRows(
        ctx,
        result,
        result.files.map((file) => ({ id: file.shortId, path: file.path, type: file.mediaType, size: file.size })),
        [{ key: "id" }, { key: "path" }, { key: "type" }, { key: "size" }],
      );
    },
  }),
  command("projects files put", {
    summary: "Upload or replace a Project file",
    args: { project: arg.required({ valueLabel: "project-id-or-name" }), file: arg.required({ valueLabel: "local-path" }) },
    flags: { path: flag.string({ description: "Project path; defaults to the local file name" }), mediaType: flag.string() },
    async run({ ctx, args, flags }) {
      const project = await resolveProject(ctx, args.project);
      const file = Bun.file(args.file);
      if (!(await file.exists())) throw new Error(`File not found: ${args.file}`);
      const projectPath = flags.path ?? args.file.replaceAll("\\", "/").split("/").at(-1)!;
      printValue(
        ctx,
        await readProjectsApi(
          ctx,
          path(project.shortId, "/files"),
          jsonRequest("POST", {
            path: projectPath,
            mediaType: flags.mediaType ?? (file.type || "application/octet-stream"),
            content: Buffer.from(await file.arrayBuffer()).toString("base64"),
            encoding: "base64",
          }),
        ),
      );
    },
  }),
  command("projects files get", {
    summary: "Download a Project file",
    args: { project: arg.required({ valueLabel: "project-id-or-name" }), file: arg.required({ valueLabel: "file-id" }) },
    flags: { output: flag.string({ required: true, valueLabel: "local-path" }) },
    async run({ ctx, args, flags }) {
      const project = await resolveProject(ctx, args.project);
      const result = await readProjectsApi<{ content: string }>(ctx, path(project.shortId, `/files/${encodeURIComponent(args.file)}`));
      if (!flags.output) throw new Error("Pass --output.");
      await Bun.write(flags.output, Buffer.from(result.content, "base64"));
      printValue(ctx, result, `Wrote ${flags.output}.`);
    },
  }),
  command("projects files delete", {
    summary: "Delete a Project file",
    args: { project: arg.required({ valueLabel: "project-id-or-name" }), file: arg.required({ valueLabel: "file-id" }) },
    flags: { yes: confirmFlag("Confirm deleting the Project file") },
    async run({ ctx, args, flags }) {
      requireConfirmation(flags.yes, "Deleting a Project file");
      const project = await resolveProject(ctx, args.project);
      printValue(ctx, await readProjectsApi(ctx, path(project.shortId, `/files/${encodeURIComponent(args.file)}`), { method: "DELETE" }));
    },
  }),
  command("projects references list", {
    summary: "List Project Cloud references",
    args: { project: arg.required({ valueLabel: "project-id-or-name" }) },
    async run({ ctx, args }) {
      const project = await resolveProject(ctx, args.project);
      const result = await readProjectsApi<{ references: AiProjectReference[] }>(ctx, path(project.shortId, "/references"));
      printRows(
        ctx,
        result,
        result.references.map((reference) => ({
          id: reference.shortId,
          label: reference.label,
          type: reference.ref.type,
          resource: reference.ref.id,
        })),
        [{ key: "id" }, { key: "label" }, { key: "type" }, { key: "resource" }],
      );
    },
  }),
  command("projects references add", {
    summary: "Add a Project Cloud reference",
    args: {
      project: arg.required({ valueLabel: "project-id-or-name" }),
      type: arg.required({ valueLabel: "qualified-type" }),
      resource: arg.required({ valueLabel: "resource-id" }),
    },
    flags: { label: flag.string() },
    async run({ ctx, args, flags }) {
      const project = await resolveProject(ctx, args.project);
      printValue(
        ctx,
        await readProjectsApi(
          ctx,
          path(project.shortId, "/references"),
          jsonRequest("POST", {
            ref: { type: args.type, id: args.resource },
            label: flags.label ?? "",
          }),
        ),
      );
    },
  }),
  command("projects references delete", {
    summary: "Delete a Project Cloud reference",
    args: { project: arg.required({ valueLabel: "project-id-or-name" }), reference: arg.required({ valueLabel: "reference-id" }) },
    flags: { yes: confirmFlag("Confirm deleting the Project reference") },
    async run({ ctx, args, flags }) {
      requireConfirmation(flags.yes, "Deleting a Project reference");
      const project = await resolveProject(ctx, args.project);
      printValue(
        ctx,
        await readProjectsApi(ctx, path(project.shortId, `/references/${encodeURIComponent(args.reference)}`), { method: "DELETE" }),
      );
    },
  }),
  command("projects access list", {
    summary: "List Project access grants",
    args: { project: arg.required({ valueLabel: "project-id-or-name" }) },
    async run({ ctx, args }) {
      const project = await resolveProject(ctx, args.project);
      const result = await readProjectsApi<{ access: AiProjectAccess[] }>(ctx, path(project.shortId, "/access"));
      printRows(
        ctx,
        result,
        result.access.map((entry) => ({
          id: entry.shortId,
          principal: entry.displayName ?? entry.principal.type,
          permission: entry.permission,
        })),
        [{ key: "id" }, { key: "principal" }, { key: "permission" }],
      );
    },
  }),
  command("projects access grant", {
    summary: "Grant Project access to a user or group",
    args: { project: arg.required({ valueLabel: "project-id-or-name" }), principal: arg.required({ valueLabel: "principal-id" }) },
    flags: {
      type: flag.enum(["user", "group", "service_account"] as const, { default: "user" }),
      permission: flag.enum(["read", "write", "admin"] as const, { default: "read" }),
    },
    async run({ ctx, args, flags }) {
      const project = await resolveProject(ctx, args.project);
      const principal =
        flags.type === "user"
          ? { type: "user" as const, userId: args.principal }
          : flags.type === "group"
            ? { type: "group" as const, groupId: args.principal }
            : { type: "service_account" as const, serviceAccountId: args.principal };
      printValue(
        ctx,
        await readProjectsApi(ctx, path(project.shortId, "/access"), jsonRequest("POST", { principal, permission: flags.permission })),
      );
    },
  }),
  command("projects access update", {
    summary: "Update a Project access grant",
    args: { project: arg.required({ valueLabel: "project-id-or-name" }), access: arg.required({ valueLabel: "access-id" }) },
    flags: { permission: flag.enum(["read", "write", "admin"] as const, { required: true }) },
    async run({ ctx, args, flags }) {
      const project = await resolveProject(ctx, args.project);
      printValue(
        ctx,
        await readProjectsApi(
          ctx,
          path(project.shortId, `/access/${encodeURIComponent(args.access)}`),
          jsonRequest("PATCH", { permission: flags.permission }),
        ),
      );
    },
  }),
  command("projects access revoke", {
    summary: "Revoke a Project access grant",
    args: { project: arg.required({ valueLabel: "project-id-or-name" }), access: arg.required({ valueLabel: "access-id" }) },
    flags: { yes: confirmFlag("Confirm revoking Project access") },
    async run({ ctx, args, flags }) {
      requireConfirmation(flags.yes, "Revoking Project access");
      const project = await resolveProject(ctx, args.project);
      printValue(
        ctx,
        await readProjectsApi(ctx, path(project.shortId, `/access/${encodeURIComponent(args.access)}`), { method: "DELETE" }),
      );
    },
  }),
] as const;
