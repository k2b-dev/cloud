import { z } from "zod";
import { cliText, command, confirmFlag, flag, printStructured, readCliInput } from "../index";
import { apiGet } from "./shared";

const path = "/api/admin/core/settings";
const Configuration = z.object({ enabled: z.boolean(), origin: z.string(), adminPairing: z.boolean() }).strict();

export const appSignInCommands = [
  command("app-sign-in config get", {
    summary: "Export app sign-in activation, trusted origin, and administrator-assisted pairing policy",
    async run({ ctx }) {
      const config = Configuration.parse(await apiGet(ctx, `${path}/app-sign-in`));
      if (!printStructured(ctx, config)) ctx.print(JSON.stringify(config, null, 2));
    },
  }),
  command("app-sign-in config set", {
    summary: "Save app sign-in settings; incomplete setup keeps pairing and sign-in unavailable",
    flags: {
      config: flag.input({ required: true, description: "JSON with enabled, origin and adminPairing: --config, --config-file or --stdin" }),
      yes: confirmFlag("Confirm app sign-in configuration and trusted website changes"),
    },
    async run({ ctx, flags }) {
      if (!flags.yes)
        throw new Error(cliText(ctx, { en: "App sign-in changes require --yes.", de: "Änderungen an der App-Anmeldung erfordern --yes." }));
      const input = await readCliInput(flags.config, { required: true, label: "App sign-in configuration" });
      const config = Configuration.parse(JSON.parse(input ?? ""));
      await ctx.readJson(
        await ctx.fetch(path, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            updates: {
              "user.app_approval.enabled": config.enabled,
              "user.app_approval.origin": config.origin,
              "user.app_approval.admin_pairing": config.adminPairing,
            },
          }),
        }),
      );
      if (!printStructured(ctx, { saved: true }))
        ctx.print(
          cliText(ctx, {
            en: "App sign-in settings saved. Check the saved configuration status in Administration → Sign-in. This does not verify the PWA.",
            de: "App-Anmeldung gespeichert. Prüfe den Konfigurationsstatus unter Administration → Anmeldung. Die PWA wird damit nicht geprüft.",
          }),
        );
    },
  }),
];
