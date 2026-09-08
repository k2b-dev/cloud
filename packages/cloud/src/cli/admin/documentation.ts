import { z } from "zod";
import { cliText, command, confirmFlag, flag, printStructured } from "../index";
import { apiGet } from "./shared";

const path = "/api/admin/core/settings";

export const documentationCommands = [
  command("documentation get", {
    summary: "Read the website used by administration documentation links",
    async run({ ctx }) {
      const config = z.object({ url: z.string() }).parse(await apiGet(ctx, `${path}/documentation`));
      if (!printStructured(ctx, config)) ctx.print(config.url);
    },
  }),
  command("documentation set", {
    summary: "Set the documentation base URL without changing authentication or other settings",
    flags: {
      url: flag.string({ required: true, description: "Documentation base URL, such as https://cloud.k2b.dev" }),
      yes: confirmFlag("Confirm documentation website change"),
    },
    async run({ ctx, flags }) {
      if (!flags.yes) throw new Error(cliText(ctx, { en: "Documentation changes require --yes.", de: "Doku-Änderungen erfordern --yes." }));
      await ctx.readJson(
        await ctx.fetch(path, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ updates: { "app.documentation_url": flags.url } }),
        }),
      );
      if (!printStructured(ctx, { saved: true }))
        ctx.print(cliText(ctx, { en: "Documentation website saved.", de: "Dokumentationsadresse gespeichert." }));
    },
  }),
];
