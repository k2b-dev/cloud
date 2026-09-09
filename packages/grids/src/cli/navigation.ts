import { command } from "@k2b/cloud/cli";
import { type BaseNavigation, BaseNavigationSchema } from "../navigation-contracts";
import { baseArgs, baseFlag, resolveBaseFromCommand } from "./resources";
import { JSON_BODY_INPUT, jsonRequest, printJsonOrMessage, readApi, readJsonInput } from "./runtime";

export const navigationCommands = [
  command("bases navigation get", {
    summary: "Read shared navigation groups and their revision (base admin)",
    args: baseArgs,
    flags: baseFlag,
    async run({ ctx, args }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args ?? [], 0);
      const value = await readApi<BaseNavigation>(ctx, `/bases/${base.id}/navigation`);
      printJsonOrMessage(ctx, value, JSON.stringify(value, null, 2));
    },
  }),
  command("bases navigation set", {
    summary: "Replace ordered shared groups with revision conflict protection; removing references never deletes resources",
    args: baseArgs,
    flags: { ...baseFlag, body: JSON_BODY_INPUT },
    async run({ ctx, args, flags }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args ?? [], 0);
      const input = BaseNavigationSchema.parse(await readJsonInput(flags.body, "navigation with revision and groups"));
      const value = await readApi<BaseNavigation>(ctx, `/bases/${base.id}/navigation`, jsonRequest("PUT", input));
      printJsonOrMessage(ctx, value, `Saved navigation revision ${value.revision}.`);
    },
  }),
];
