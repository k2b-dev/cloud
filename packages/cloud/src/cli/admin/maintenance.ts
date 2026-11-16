import { MAINTENANCE_ADMIN_API_PATH, MaintenanceStatusSchema } from "../../contracts/maintenance";
import { arg, command, flag } from "../commands";
import type { CloudCliContext } from "../index";
import {
  maintenanceOffSentence,
  maintenanceOnSentence,
  maintenanceResumeSentence,
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
  for (const line of lines) ctx.print(markMaintenanceWord(line, ctx.color === true));
};

export const maintenanceCommands = [
  command("maintenance on", {
    summary: "Switch maintenance mode on: everyone sees the maintenance page instead of the Cloud",
    description:
      "Run it again while maintenance is on to change the note, the planned end or stage „Ruhe“; the running maintenance stays. Maintenance never ends by itself.",
    flags: {
      message: flag.string({ description: "Note on the maintenance page (plain text, at most 500 characters)" }),
      until: flag.string({ description: "Planned end: HH:MM today in local time, or an ISO date-time" }),
      quiesce: flag.boolean({ description: "Stage „Ruhe“: background work in every app stops and drains; off resumes it" }),
      noQuiesce: flag.boolean({ name: "no-quiesce", description: "Resume background work while maintenance stays on" }),
    },
    examples: [
      'cld admin maintenance on --message "Wir spielen Version 2.4 ein." --until 14:30',
      "cld admin maintenance on --quiesce",
      "cld admin maintenance on --no-quiesce",
    ],
    async run({ ctx, flags }) {
      if (flags.quiesce && flags.noQuiesce) throw new Error("Use either --quiesce or --no-quiesce.");
      const status = await call(ctx, "POST", "/on", {
        ...(flags.message !== undefined ? { message: flags.message } : {}),
        ...(flags.until !== undefined ? { until: parseMaintenanceTime(flags.until) } : {}),
        ...(flags.quiesce ? { quiesce: true } : flags.noQuiesce ? { quiesce: false } : {}),
      });
      if (printStructured(ctx, status)) return;
      const lines = [maintenanceOnSentence(status, { locale: ctx.options.locale })];
      if (flags.noQuiesce) lines.push(maintenanceResumeSentence({ locale: ctx.options.locale }));
      say(ctx, lines);
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
  command("maintenance status", {
    summary: "Show whether maintenance mode is on, its note and end, how many apps are ready and, in stage „Ruhe“, how many are quiet",
    async run({ ctx }) {
      const status = await call(ctx, "GET", "");
      if (!printStructured(ctx, status)) say(ctx, maintenanceStatusLines(status, { locale: ctx.options.locale }));
    },
  }),
];
