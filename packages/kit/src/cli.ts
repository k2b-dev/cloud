import {
  arg,
  readCliInput,
  command,
  confirmFlag,
  defineCliCommands,
  flag,
  printStructured,
  type CloudCliContext,
} from "@valentinkolb/cloud/cli";
import { createAccessCommands } from "@valentinkolb/cloud/cli/access";
import { PublicId, type Bundle } from "./contracts";
import { SourceChanges, SourceReadInput, MetadataInput } from "./source";
import { blankStarter, starter } from "./starter";
import { sdkReference } from "./sdk";
import { readProject, writeProject, writeManifest } from "./cli/project-files";

const request = async <T>(ctx: CloudCliContext, path: string, method = "GET", body?: unknown): Promise<T> =>
  ctx.readJson<T>(
    await ctx.fetch(`/api/kit${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
const output = (ctx: CloudCliContext, value: unknown) => {
  if (!printStructured(ctx, value)) ctx.print(JSON.stringify(value, null, 2));
};
const idArgs = {
  id: arg.required({ description: "Six-character Kit app id" }),
};
const directoryArgs = {
  directory: arg.required({
    description: "Local project directory containing kit.json",
  }),
};
const projectPath = (id: string) => `/projects/${PublicId.parse(id)}`;
export default defineCliCommands({
  name: "kit",
  summary: "Build and share local browser tools.",
  commands: [
    command("list", {
      summary: "List accessible apps",
      flags: {
        page: flag.int({ description: "Page number", default: 1 }),
        search: flag.string({
          description: "Find apps by name or description",
        }),
      },
      async run({ ctx, flags }) {
        output(ctx, await request(ctx, `/projects?page=${flags.page}&q=${encodeURIComponent(flags.search ?? "")}`));
      },
    }),
    command("get", {
      summary: "Read app source and entrypoints (use permission required)",
      args: idArgs,
      async run({ ctx, args }) {
        output(ctx, await request(ctx, projectPath(args.id)));
      },
    }),
    command("sdk", {
      summary: "Show the supported Kit SDK and runtime limits",
      run({ ctx }) {
        output(ctx, sdkReference);
      },
    }),
    command("init", {
      summary: "Create a local CSV converter and history project",
      args: directoryArgs,
      flags: { blank: flag.boolean({ description: "Start with one empty tool instead of the CSV workshop" }) },
      async run({ ctx, args, flags }) {
        await writeProject(args.directory, flags.blank ? blankStarter : starter);
        output(ctx, { directory: args.directory });
      },
    }),
    command("validate", {
      summary: "Validate local source and discover entrypoints without execution",
      args: directoryArgs,
      async run({ ctx, args }) {
        const p = await readProject(args.directory);
        output(ctx, { valid: true, entries: p.entries });
      },
    }),
    command("pull", {
      summary: "Download an app into a new local directory",
      args: { ...idArgs, ...directoryArgs },
      async run({ ctx, args }) {
        const p = await request<Bundle>(ctx, projectPath(args.id));
        await writeProject(
          args.directory,
          {
            name: p.name,
            description: p.description,
            persistenceEnabled: p.persistenceEnabled,
            files: p.files,
          },
          p,
        );
        output(ctx, {
          id: p.id,
          revision: p.revision,
          directory: args.directory,
        });
      },
    }),
    command("push", {
      summary: "Create an app or update the revision recorded in kit.json",
      args: directoryArgs,
      async run({ ctx, args }) {
        const p = await readProject(args.directory);
        const result = await request<Bundle>(
          ctx,
          p.id ? projectPath(p.id) : "/projects",
          p.id ? "PUT" : "POST",
          p.id ? { ...p.project, expectedRevision: p.revision } : p.project,
        );
        await writeManifest(args.directory, p.project, result);
        output(ctx, {
          id: result.id,
          revision: result.revision,
          path: `/app/kit/${result.id}`,
        });
      },
    }),
    command("manifest", {
      summary: "Read metadata, revision and file paths without source",
      args: idArgs,
      async run({ ctx, args }) {
        output(ctx, await request(ctx, `${projectPath(args.id)}/manifest`));
      },
    }),
    command("update", {
      summary: "Update app metadata with an expected revision (admin)",
      args: idArgs,
      flags: {
        input: flag.input({
          valueLabel: "json",
          description: "JSON with expectedRevision and optional name, description, persistenceEnabled",
          required: true,
        }),
      },
      async run({ ctx, args, flags }) {
        const text = await readCliInput(flags.input, { label: "Kit metadata JSON", required: true });
        output(ctx, await request(ctx, projectPath(args.id), "PATCH", MetadataInput.parse(JSON.parse(text ?? ""))));
      },
    }),
    command("source read", {
      summary: "Read a source window at an exact revision; continue with nextOffset",
      args: idArgs,
      flags: {
        input: flag.input({ valueLabel: "json", description: "JSON with path, expectedRevision and optional offset", required: true }),
      },
      async run({ ctx, args, flags }) {
        const text = await readCliInput(flags.input, { label: "Kit source read JSON", required: true });
        output(
          ctx,
          await request(
            ctx,
            `${projectPath(args.id)}/source/read`,
            "POST",
            SourceReadInput.omit({ id: true }).parse(JSON.parse(text ?? "")),
          ),
        );
      },
    }),
    ...(["validate", "apply"] as const).map((operation) =>
      command(`source ${operation}`, {
        summary:
          operation === "apply"
            ? "Atomically apply source changes at an expected revision (admin)"
            : "Validate proposed source changes without saving or executing (admin)",
        args: idArgs,
        flags: {
          input: flag.input({ valueLabel: "json", description: "JSON with expectedRevision, upsert, delete and/or edits", required: true }),
        },
        async run({ ctx, args, flags }) {
          const text = await readCliInput(flags.input, { label: "Kit source changes JSON", required: true });
          output(
            ctx,
            await request(ctx, `${projectPath(args.id)}/source/${operation}`, "POST", SourceChanges.parse(JSON.parse(text ?? ""))),
          );
        },
      }),
    ),
    command("delete", {
      summary: "Delete an app and its sharing grants",
      args: idArgs,
      flags: { yes: confirmFlag("Delete the app") },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to delete without --yes");
        output(ctx, await request(ctx, projectPath(args.id), "DELETE"));
      },
    }),
    ...createAccessCommands({
      resourceLabel: "Kit app",
      resourceArgDescription: "Six-character app id",
      allowPublic: false,
      allowAuthenticated: true,
      allowServiceAccounts: false,
      async resolveResource(ctx, args) {
        if (args.length !== 1) throw new Error("Pass one Kit app id");
        const p = await request<Bundle>(ctx, projectPath(args[0]!));
        return { id: p.id, label: p.name };
      },
      list: (ctx, r) => request(ctx, `${projectPath(r.id)}/access`),
      grant: (ctx, r, principal, permission) =>
        request(ctx, `${projectPath(r.id)}/access`, "POST", {
          principal,
          permission,
        }),
      async update(ctx, r, accessId, permission) {
        await request(ctx, `${projectPath(r.id)}/access/${encodeURIComponent(accessId)}`, "PATCH", { permission });
      },
      async revoke(ctx, r, accessId) {
        await request(ctx, `${projectPath(r.id)}/access/${encodeURIComponent(accessId)}`, "DELETE");
      },
    }),
  ],
});
