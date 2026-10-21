import { arg, type CloudCliContext, command, defineCliCommands, flag, localizeCloudCliText } from "@k2b/cloud/cli";
import { pulseAccessCommands } from "./cli/access";
import { adminCommands } from "./cli/admin";
import { createAlertCommands } from "./cli/alerts";
import { baseCommands } from "./cli/bases";
import { resolveBaseFromCommand, resolveSource } from "./cli/context";
import { baseFlag, JSON_INPUT } from "./cli/flags";
import { createQueryCommands } from "./cli/queries";
import { jsonRequest, printJsonOrTable, readApi, readJsonInput } from "./cli/shared";
import { sourceTokenCommands } from "./cli/source-tokens";
import { createSourceCommands } from "./cli/sources";
import { sqlCommand } from "./cli/sql";
import type { PulseIngestBatch } from "./contracts";

type IngestResult = { metrics: number; events: number; states: number };

const pulseCommands = (locale?: string) =>
  defineCliCommands({
    name: "pulse",
    summary: "Manage Pulse bases, SQL, saved queries, sources, alerts, and ingest.",
    groupSummaries: {
      admin: "Administer Pulse as a Cloud admin: data store, base policy, limits and internal targets",
      "admin store": "Manage the Pulse ClickHouse connection",
      "admin policy": "Read and set who may create bases and the starting values for new bases",
      "admin bases": "List bases with state and usage, set their limits, and recover failed or blocked bases",
      "admin orphans": "List and delete ClickHouse databases that belong to no base",
      "admin targets": "Release and revoke internal scrape targets per base",
      access: "Manage direct access to Pulse bases",
      "source-tokens": "Manage HTTP ingest tokens for Pulse sources",
      sources: "Create, inspect, and manage Pulse sources",
      alerts: localizeCloudCliText(locale, {
        en: "List, read, save, and delete SQL alert rules",
        de: "SQL-Alarmregeln auflisten, lesen, speichern und löschen",
      }),
      queries: "List, read, save, and delete SQL queries",
    },
    commands: [
      sqlCommand,
      ...createQueryCommands(locale),
      ...createAlertCommands(locale),
      ...adminCommands,
      ...baseCommands,
      ...pulseAccessCommands,
      ...createSourceCommands(locale),
      ...sourceTokenCommands,
      command("ingest", {
        summary: "Ingest a Pulse JSON batch through the authenticated API",
        flags: { ...baseFlag, source: flag.string({ required: true, description: "Ingest source ID or exact name" }), batch: JSON_INPUT },
        args: { args: arg.rest({ valueLabel: "base" }) },
        async run({ ctx, args, flags }) {
          const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
          if (!flags.source) throw new Error("--source is required");
          const source = await resolveSource(ctx, base.id, flags.source);
          const batch = await readJsonInput<PulseIngestBatch>(flags.batch, "ingest JSON");
          const result = await readApi<IngestResult>(
            ctx,
            `/bases/${encodeURIComponent(base.id)}/sources/${encodeURIComponent(source.id)}/ingest`,
            jsonRequest("POST", batch),
          );
          printJsonOrTable(ctx, result, [result], [{ key: "metrics" }, { key: "events" }, { key: "states" }]);
        },
      }),
    ],
  });

const module = pulseCommands();
export default {
  ...module,
  help: (locale?: string) => pulseCommands(locale).help!(),
  run: (ctx: CloudCliContext) => pulseCommands(ctx.options.locale).run(ctx),
};
