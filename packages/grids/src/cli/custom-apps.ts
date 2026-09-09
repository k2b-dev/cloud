import { writeFile } from "node:fs/promises";
import { command, confirmFlag, flag } from "@k2b/cloud/cli";
import type { CustomAppCapabilities, CustomAppDefinition, CustomAppDiagnostic } from "../custom-apps/contracts";
import type { CustomAppPlan } from "../service/custom-apps";
import { baseArgs, baseFlag, resolveBaseFromCommand, resolveNamedResource } from "./resources";
import { jsonRequest, printCliStructured, printJsonOrMessage, printJsonOrTable, readApi, readTextInput, requireRestArg } from "./runtime";

const sourceFlag = flag.input({
  name: "source",
  fileName: "source-file",
  fileAliases: ["f"],
  stdinName: "stdin",
  valueLabel: "yaml",
  required: true,
  description: "Grids App YAML or JSON definition",
});

const appFlag = { app: flag.string({ description: "App public id or exact name" }) };

export type CliCustomApp = {
  id: string;
  baseId: string;
  name: string;
  icon: string | null;
  draftDefinition: CustomAppDefinition | null;
  draftDiagnostics: CustomAppDiagnostic[];
  draftCapabilities: CustomAppCapabilities | null;
  publishedDefinition: CustomAppDefinition | null;
  publishedDiagnostics: CustomAppDiagnostic[];
  publishedCapabilities: CustomAppCapabilities | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  draftValid: boolean;
  publishedValid: boolean;
  hasUnpublishedChanges: boolean;
};

const appState = (app: CliCustomApp): string => {
  if (!app.draftValid) return "needs-attention";
  if (!app.publishedAt) return "draft";
  if (!app.publishedValid) return "live-needs-attention";
  return app.hasUnpublishedChanges ? "unpublished-changes" : "live";
};

const listCustomApps = (ctx: Parameters<typeof readApi>[0], baseId: string): Promise<CliCustomApp[]> =>
  readApi<CliCustomApp[]>(ctx, `/apps/by-base/${encodeURIComponent(baseId)}`);

export const resolveCustomApp = async (ctx: Parameters<typeof readApi>[0], baseId: string, reference: string): Promise<CliCustomApp> =>
  resolveNamedResource(await listCustomApps(ctx, baseId), reference, "App");

const resolveAppFromCommand = async (
  ctx: Parameters<typeof readApi>[0],
  args: string[],
  appReference: string | undefined,
): Promise<{ app: CliCustomApp }> => {
  const { base, rest } = await resolveBaseFromCommand(ctx, args, appReference ? 0 : 1);
  return { app: await resolveCustomApp(ctx, base.id, appReference ?? requireRestArg(rest, 0, "App")) };
};

const readDefinition = async (input: Parameters<typeof readTextInput>[0], expectedBaseId: string): Promise<CustomAppDefinition> => {
  const source = await readTextInput(input, "Grids App definition", true);
  let definition: CustomAppDefinition;
  try {
    definition = Bun.YAML.parse(source!) as CustomAppDefinition;
  } catch (error) {
    throw new Error(`Invalid Grids App YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!definition || typeof definition !== "object") throw new Error("Grids App definition must be a YAML mapping.");
  if (definition.baseId !== expectedBaseId) throw new Error("Grids App baseId does not match the selected base.");
  return definition;
};

const printValidation = (
  ctx: Parameters<typeof readApi>[0],
  result: { valid: boolean; diagnostics: Array<{ path: Array<string | number>; message: string }>; capabilities?: unknown },
) => {
  if (printCliStructured(ctx, result)) return;
  if (result.valid) {
    ctx.print("Grids App definition is valid.");
    return;
  }
  for (const diagnostic of result.diagnostics) ctx.print(`${diagnostic.path.join(".") || "definition"}: ${diagnostic.message}`);
};

const printPlan = (ctx: Parameters<typeof readApi>[0], result: CustomAppPlan) => {
  if (!printCliStructured(ctx, result)) {
    ctx.print(`action: ${result.action}`);
    for (const change of result.changes) ctx.print(`- ${change}`);
    for (const diagnostic of result.diagnostics) ctx.print(`${diagnostic.path.join(".") || "definition"}: ${diagnostic.message}`);
  }
  if (!result.valid) throw new Error("Grids App definition is invalid.");
};

export const customAppCommands = [
  command("apps reference", {
    summary: "Show the strict Grids App definition reference",
    async run({ ctx }) {
      const reference = await readApi<unknown>(ctx, "/apps/reference");
      if (!printCliStructured(ctx, reference)) ctx.print(Bun.YAML.stringify(reference));
    },
  }),
  command("apps list", {
    summary: "List Apps in a base",
    args: baseArgs,
    flags: baseFlag,
    async run({ ctx, args }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const apps = await listCustomApps(ctx, base.id);
      printJsonOrTable(
        ctx,
        apps,
        apps.map((app) => ({
          id: app.id,
          name: app.name,
          state: appState(app),
          updatedAt: app.updatedAt,
        })),
        [
          { key: "id", label: "ID" },
          { key: "name", label: "NAME" },
          { key: "state", label: "STATE" },
          { key: "updatedAt", label: "UPDATED" },
        ],
      );
    },
  }),
  command("apps create", {
    summary: "Create a blank App draft",
    args: baseArgs,
    flags: { ...baseFlag, name: flag.string({ required: true, description: "App name" }) },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const app = await readApi<CliCustomApp>(
        ctx,
        `/apps/by-base/${encodeURIComponent(base.id)}`,
        jsonRequest("POST", { name: flags.name }),
      );
      printJsonOrMessage(ctx, app, `Created ${app.name} (${app.id}) as a draft.`);
    },
  }),
  command("apps get", {
    summary: "Show an App",
    args: baseArgs,
    flags: { ...baseFlag, ...appFlag },
    async run({ ctx, args, flags }) {
      const { app } = await resolveAppFromCommand(ctx, args.args, flags.app);
      if (!printCliStructured(ctx, app)) {
        ctx.print(`${app.name} (${app.id})`);
        ctx.print(`state: ${appState(app)}`);
        ctx.print(`draft: ${app.draftValid ? "valid" : "needs attention"}`);
        ctx.print(`live: ${app.publishedAt ? (app.publishedValid ? app.publishedAt : "needs attention") : "not published"}`);
        ctx.print(`unpublished changes: ${app.hasUnpublishedChanges ? "yes" : "no"}`);
        if (app.publishedAt) ctx.print(`url: /apps/${app.id}`);
        for (const diagnostic of app.draftDiagnostics) {
          ctx.print(`draft ${diagnostic.path.join(".") || "definition"}: ${diagnostic.message}`);
        }
        for (const diagnostic of app.publishedDiagnostics) {
          ctx.print(`live ${diagnostic.path.join(".") || "definition"}: ${diagnostic.message}`);
        }
        ctx.print(`id: ${app.id}`);
      }
    },
  }),
  command("apps validate", {
    summary: "Validate and compile a Grids App definition without saving it",
    args: baseArgs,
    flags: { ...baseFlag, source: sourceFlag },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const definition = await readDefinition(flags.source, base.id);
      const result = await readApi<{
        valid: boolean;
        diagnostics: Array<{ path: Array<string | number>; message: string }>;
        capabilities?: unknown;
      }>(ctx, "/apps/validate", jsonRequest("POST", { definition }));
      printValidation(ctx, result);
      if (!result.valid) throw new Error("Grids App definition is invalid.");
    },
  }),
  command("apps plan", {
    summary: "Show the deterministic changes for a Grids App definition",
    args: baseArgs,
    flags: { ...baseFlag, source: sourceFlag },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const definition = await readDefinition(flags.source, base.id);
      const result = await readApi<CustomAppPlan>(ctx, "/apps/plan", jsonRequest("POST", { definition }));
      printPlan(ctx, result);
    },
  }),
  command("apps apply", {
    summary: "Create or update an App draft from its definition",
    args: baseArgs,
    flags: {
      ...baseFlag,
      source: sourceFlag,
      dryRun: flag.boolean({ name: "dry-run", description: "Show the plan without changing the draft" }),
    },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const definition = await readDefinition(flags.source, base.id);
      if (flags.dryRun) {
        const result = await readApi<CustomAppPlan>(ctx, "/apps/plan", jsonRequest("POST", { definition }));
        printPlan(ctx, result);
        return;
      }
      const app = await readApi<CliCustomApp>(ctx, "/apps/apply", jsonRequest("POST", { definition }));
      printJsonOrMessage(ctx, app, `Applied ${app.name} (${app.id}) as a draft.`);
    },
  }),
  command("apps export", {
    summary: "Export an App definition as deterministic YAML",
    args: baseArgs,
    flags: {
      ...baseFlag,
      ...appFlag,
      published: flag.boolean({ description: "Export the current live definition instead of the draft" }),
      out: flag.string({ description: "Write YAML to this file" }),
    },
    async run({ ctx, args, flags }) {
      const { app } = await resolveAppFromCommand(ctx, args.args, flags.app);
      const definition = flags.published
        ? app.publishedDefinition
        : await readApi<CustomAppDefinition | null>(ctx, `/apps/${encodeURIComponent(app.id)}/export`);
      if (!definition) throw new Error(flags.published ? "App has no valid live version." : "App has no valid draft definition.");
      if (ctx.options.output === "json") return ctx.json(definition);
      if (ctx.options.output === "jsonl") return ctx.jsonLine(definition);
      const yaml = Bun.YAML.stringify(definition);
      if (!flags.out) return ctx.print(yaml);
      await writeFile(flags.out, yaml);
      ctx.print(`Wrote ${flags.out}.`);
    },
  }),
  command("apps publish", {
    summary: "Publish the current validated App draft",
    args: baseArgs,
    flags: { ...baseFlag, ...appFlag, yes: confirmFlag("Publish this App") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to publish.");
      const { app } = await resolveAppFromCommand(ctx, args.args, flags.app);
      const published = await readApi<CliCustomApp>(ctx, `/apps/${encodeURIComponent(app.id)}/publish`, jsonRequest("POST"));
      printJsonOrMessage(ctx, published, `Published ${published.name} at /apps/${published.id}.`);
    },
  }),
  command("apps unpublish", {
    summary: "Remove the live App snapshot while keeping its draft",
    args: baseArgs,
    flags: { ...baseFlag, ...appFlag, yes: confirmFlag("Unpublish this App") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to unpublish.");
      const { app } = await resolveAppFromCommand(ctx, args.args, flags.app);
      const unpublished = await readApi<CliCustomApp>(ctx, `/apps/${encodeURIComponent(app.id)}/unpublish`, jsonRequest("POST"));
      printJsonOrMessage(ctx, unpublished, `Unpublished ${unpublished.name}; its draft is unchanged.`);
    },
  }),
  command("apps restore", {
    summary: "Restore the live App definition as the current draft",
    args: baseArgs,
    flags: { ...baseFlag, ...appFlag, yes: confirmFlag("Replace this App draft with its live version") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to restore the live version.");
      const { app } = await resolveAppFromCommand(ctx, args.args, flags.app);
      const restored = await readApi<CliCustomApp>(ctx, `/apps/${encodeURIComponent(app.id)}/restore`, jsonRequest("POST"));
      printJsonOrMessage(ctx, restored, `Restored the live version of ${restored.name} as its draft.`);
    },
  }),
  command("apps delete", {
    summary: "Delete an App and remove its live route",
    args: baseArgs,
    flags: { ...baseFlag, ...appFlag, yes: confirmFlag("Delete this App") },
    async run({ ctx, args, flags }) {
      if (!flags.yes) throw new Error("Pass --yes to delete.");
      const { app } = await resolveAppFromCommand(ctx, args.args, flags.app);
      await readApi<unknown>(ctx, `/apps/${encodeURIComponent(app.id)}`, jsonRequest("DELETE"));
      printJsonOrMessage(ctx, { id: app.id }, `Deleted ${app.name} (${app.id}).`);
    },
  }),
];
