import { LinuxIdentityConfigurationSchema, type LinuxIdentityConfiguration } from "../../contracts/posix";
import { cliText, command, confirmFlag, flag, printStructured, readCliInput } from "../index";
import { apiGet, apiJson, queryString } from "./shared";

const path = "/api/admin/core/linux-identities";

export const linuxCommands = [
  command("linux preview", {
    summary: "Inspect one page of Linux identities without changing accounts",
    flags: { after: flag.string({ description: "Continue after the previous page's nextCursor" }) },
    async run({ ctx, flags }) {
      const result = await apiGet<unknown>(ctx, `${path}${queryString({ after: flags.after })}`);
      if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result, null, 2));
    },
  }),
  command("linux config get", {
    summary: "Export the complete Linux identity configuration",
    async run({ ctx }) {
      const { config } = await apiGet<{ config: LinuxIdentityConfiguration }>(ctx, path);
      if (!printStructured(ctx, config)) ctx.print(JSON.stringify(config, null, 2));
    },
  }),
  command("linux config set", {
    summary: "Replace the complete Linux identity configuration",
    flags: {
      config: flag.input({ required: true, description: "Configuration JSON: --config, --config-file, or --stdin" }),
      rangeReserved: flag.boolean({ name: "range-reserved", description: "Confirm the range is reserved across all connected systems" }),
      yes: confirmFlag("Confirm replacing Linux identity configuration"),
    },
    async run({ ctx, flags }) {
      if (!flags.yes)
        throw new Error(
          cliText(ctx, { en: "Refusing to change configuration without --yes.", de: "Konfiguration wird ohne --yes nicht geändert." }),
        );
      const input = await readCliInput(flags.config, { label: "Linux configuration", required: true });
      if (input === undefined) throw new Error("Missing Linux configuration.");
      const config = LinuxIdentityConfigurationSchema.parse(JSON.parse(input));
      if (config.enabled && !flags.rangeReserved)
        throw new Error(
          cliText(ctx, {
            en: "Enabling Linux identities requires --range-reserved.",
            de: "Zum Aktivieren ist --range-reserved erforderlich.",
          }),
        );
      const result = await apiJson<unknown>(ctx, "PUT", `${path}/configuration`, { config, rangeReserved: flags.rangeReserved });
      if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result, null, 2));
    },
  }),
];
