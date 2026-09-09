import { arg, command, confirmFlag, defineCliCommands, flag, printStructured, type CloudCliContext } from "@valentinkolb/cloud/cli";
import { createAccessCommands } from "@valentinkolb/cloud/cli/access";
import { PublicId, type Bundle } from "./contracts";
import { starter } from "./starter";
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
  summary: "Build, run and share local browser tools.",
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
      async run({ ctx, args }) {
        await writeProject(args.directory, starter);
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
