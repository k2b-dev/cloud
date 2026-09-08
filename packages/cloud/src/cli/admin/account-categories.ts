import { AccountCategoryPolicySchema } from "../../contracts/account-categories";
import { cliText, command, confirmFlag, flag, printStructured, readCliInput } from "../index";
import { apiGet } from "./shared";

const path = "/api/admin/core/settings";
export const accountCategoryCommands = [
  command("accounts config get", {
    summary: "Export account types, login visibility and the local Login label",
    async run({ ctx }) {
      const policy = AccountCategoryPolicySchema.parse(await apiGet(ctx, `${path}/account-categories`));
      if (!printStructured(ctx, policy)) ctx.print(JSON.stringify(policy, null, 2));
    },
  }),
  command("accounts config set", {
    summary: "Replace account category policy; disabled categories lose user-bound access",
    flags: {
      config: flag.input({ required: true, description: "Complete configuration JSON: --config, --config-file or --stdin" }),
      yes: confirmFlag("Confirm access changes, including your own account category"),
    },
    async run({ ctx, flags }) {
      if (!flags.yes)
        throw new Error(
          cliText(ctx, {
            en: "Account access changes require --yes. Keep an allowed admin or emergency token available.",
            de: "Zugriffsänderungen erfordern --yes. Halte einen erlaubten Admin-Zugang oder Notfall-Token bereit.",
          }),
        );
      const input = await readCliInput(flags.config, { required: true, label: "Account category configuration" });
      const policy = AccountCategoryPolicySchema.parse(JSON.parse(input ?? ""));
      const updates = Object.fromEntries(
        Object.entries(policy).flatMap(([category, fields]) =>
          Object.entries(fields).map(([field, value]) => [`user.category.${category}.${field}`, value]),
        ),
      );
      const response = await ctx.fetch(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates }),
      });
      if (!response.ok) {
        await ctx.readJson(response);
        throw new Error(`Account configuration failed (${response.status})`);
      }
      // Do not re-fetch after disabling the caller's own category: its next request is denied.
      if (!printStructured(ctx, { saved: true }))
        ctx.print(cliText(ctx, { en: "Account configuration saved.", de: "Account-Konfiguration gespeichert." }));
    },
  }),
];
