import { z } from "zod";
import { cliText, command, confirmFlag, flag, printStructured, readCliInput } from "../index";
import { apiGet } from "./shared";

const path = "/api/admin/core/settings";
const Configuration = z.object({ requestsEnabled: z.boolean(), actionNotice: z.string() }).strict();

export const accountAdministrationCommands = [
  command("accounts administration get", {
    summary: "Export account-request policy and the optional account/group follow-up template",
    async run({ ctx }) {
      const config = Configuration.parse(await apiGet(ctx, `${path}/account-administration`));
      if (!printStructured(ctx, config)) ctx.print(JSON.stringify(config, null, 2));
    },
  }),
  command("accounts administration set", {
    summary: "Configure account requests and the optional Liquid-Markdown follow-up template",
    flags: {
      config: flag.input({ required: true, description: "JSON with requestsEnabled and actionNotice: --config, --config-file or --stdin" }),
      yes: confirmFlag("Confirm changes to account requests and administrative follow-up notices"),
    },
    async run({ ctx, flags }) {
      if (!flags.yes)
        throw new Error(
          cliText(ctx, {
            en: "Account administration changes require --yes.",
            de: "Änderungen an der Account-Verwaltung erfordern --yes.",
          }),
        );
      const input = await readCliInput(flags.config, { required: true, label: "Account administration configuration" });
      const config = Configuration.parse(JSON.parse(input ?? ""));
      await ctx.readJson(
        await ctx.fetch(path, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            updates: { "user.account_requests.enabled": config.requestsEnabled, "user.action_notice": config.actionNotice },
          }),
        }),
      );
      if (!printStructured(ctx, { saved: true }))
        ctx.print(cliText(ctx, { en: "Account administration saved.", de: "Account-Verwaltung gespeichert." }));
    },
  }),
];
