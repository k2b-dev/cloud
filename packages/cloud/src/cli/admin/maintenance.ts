import { MAINTENANCE_ADMIN_API_PATH, MaintenanceBypassSchema, MaintenanceStatusSchema } from "../../contracts/maintenance";
import { arg, command, flag } from "../commands";
import type { CloudCliContext } from "../index";
import {
  cliColorEnabled,
  maintenanceBypassLines,
  maintenanceBypassOffSentence,
  maintenanceOffSentence,
  maintenanceOnSentence,
  maintenanceStatusLines,
  maintenanceUntilSentence,
  markMaintenanceWord,
  parseMaintenanceTime,
} from "../maintenance";
import { printStructured } from "../output";
import { apiJson } from "./shared";

const call = async (ctx: CloudCliContext, method: "GET" | "POST", path: string, body?: unknown) =>
  MaintenanceStatusSchema.parse(await apiJson(ctx, method, `${MAINTENANCE_ADMIN_API_PATH}${path}`, body));

const say = (ctx: CloudCliContext, lines: string[]) => {
  const color = cliColorEnabled();
  for (const line of lines) ctx.print(markMaintenanceWord(line, color));
};

export const maintenanceCommands = [
  command("maintenance on", {
    summary: "Switch maintenance mode on: everyone sees the maintenance page instead of the Cloud",
    description:
      "Run it again while maintenance is on to change the note or the planned end; the running maintenance stays. Maintenance never ends by itself.",
    flags: {
      message: flag.string({ description: "Note on the maintenance page (plain text, at most 500 characters)" }),
      until: flag.string({ description: "Planned end: HH:MM today in local time, or an ISO date-time" }),
    },
    examples: ['cld admin maintenance on --message "Wir spielen Version 2.4 ein." --until 14:30'],
    async run({ ctx, flags }) {
      const status = await call(ctx, "POST", "/on", {
        ...(flags.message !== undefined ? { message: flags.message } : {}),
        ...(flags.until !== undefined ? { until: parseMaintenanceTime(flags.until) } : {}),
      });
      if (!printStructured(ctx, status)) say(ctx, [maintenanceOnSentence(status, { locale: ctx.options.locale })]);
    },
  }),
  command("maintenance until", {
    summary: "Change the planned end of the running maintenance",
    args: { time: arg.required({ valueLabel: "time" }) },
    examples: ["cld admin maintenance until 15:00"],
    async run({ ctx, args }) {
      const status = await call(ctx, "POST", "/until", { until: parseMaintenanceTime(args.time) });
      if (!printStructured(ctx, status)) say(ctx, [maintenanceUntilSentence(status, { locale: ctx.options.locale })]);
    },
  }),
  command("maintenance off", {
    summary: "Switch maintenance mode off; open maintenance pages reload by themselves",
    async run({ ctx }) {
      const status = await call(ctx, "POST", "/off", {});
      if (!printStructured(ctx, status)) say(ctx, [maintenanceOffSentence({ locale: ctx.options.locale })]);
    },
  }),
  command("maintenance bypass", {
    summary: "Print a personal link that shows you the Cloud during the running maintenance; you still sign in as usual",
    description:
      "The browser that opens the link passes the maintenance page on the Cloud address, not on app domains. The link ends with this maintenance and after 12 hours at the latest; run the command again for a longer maintenance. Keep it to yourself like a password.",
    async run({ ctx }) {
      const response = await ctx.fetch(`${MAINTENANCE_ADMIN_API_PATH}/bypass`, { method: "POST" });
      if (response.status === 409) {
        await response.body?.cancel();
        throw new Error(maintenanceBypassOffSentence({ locale: ctx.options.locale }));
      }
      const link = MaintenanceBypassSchema.parse(await ctx.readJson(response));
      if (!printStructured(ctx, link)) say(ctx, maintenanceBypassLines(link, { locale: ctx.options.locale }));
    },
  }),
  command("maintenance status", {
    summary: "Show whether maintenance mode is on, its note and end, and how many apps are ready",
    async run({ ctx }) {
      const status = await call(ctx, "GET", "");
      if (!printStructured(ctx, status)) say(ctx, maintenanceStatusLines(status, { locale: ctx.options.locale }));
    },
  }),
];
