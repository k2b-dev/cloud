import { arg, command, defineCliCommands, flag } from "@k2b/cloud/cli";
import { pulseAccessCommands } from "./cli/access";
import { adminCommands } from "./cli/admin";
import { baseCommands } from "./cli/bases";
import { resolveBaseFromCommand, resolveSource } from "./cli/context";
import { baseFlag, JSON_INPUT } from "./cli/flags";
import { jsonRequest, printJsonOrTable, readApi, readJsonInput } from "./cli/shared";
import { sourceTokenCommands } from "./cli/source-tokens";
import { sourceCommands } from "./cli/sources";
import { sqlCommand } from "./cli/sql";
import { queryCommands } from "./cli/queries";
import type { PulseIngestBatch } from "./contracts";

type IngestResult = { metrics: number; events: number; states: number };

const module = defineCliCommands({
  name: "pulse",
  summary: "Manage Pulse bases, SQL, saved queries, sources, and ingest.",
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
    queries: "List, read, save, and delete SQL queries",
  },
  commands: [
    sqlCommand,
    ...queryCommands,
    ...adminCommands,
    ...baseCommands,
    ...pulseAccessCommands,
    ...sourceCommands,
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

export default module;
