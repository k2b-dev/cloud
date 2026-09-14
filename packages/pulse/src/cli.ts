import { arg, command, defineCliCommands, flag } from "@k2b/cloud/cli";
import { pulseAccessCommands } from "./cli/access";
import { baseCommands } from "./cli/bases";
import { resolveBaseFromCommand, resolveSource } from "./cli/context";
import { dashboardCommands } from "./cli/dashboards";
import { baseFlag, JSON_INPUT } from "./cli/flags";
import { inventoryCommands } from "./cli/inventory-commands";
import { queryCommands } from "./cli/queries";
import { jsonRequest, printJsonOrTable, readApi, readJsonInput, yesNo } from "./cli/shared";
import { signalCommands } from "./cli/signals";
import { sourceTokenCommands } from "./cli/source-tokens";
import { sourceCommands } from "./cli/sources";
import type { PulseCapabilitySnapshot, PulseIngestBatch } from "./contracts";

type IngestResult = { metrics: number; events: number; states: number };

const module = defineCliCommands({
  name: "pulse",
  summary: "Inspect Pulse data and manage Pulse bases, sources, queries, and dashboards.",
  groupSummaries: {
    access: "Manage direct access to Pulse bases",
    dashboards: "Create, inspect, and publish Pulse dashboards",
    fields: "Inspect observed telemetry fields",
    query: "Compile, run, and manage Pulse queries",
    resources: "Inspect Pulse resources, metrics, states, and events",
    "source-tokens": "Manage HTTP ingest tokens for Pulse sources",
    sources: "Create, inspect, and manage Pulse sources",
  },
  commands: [
    command("capabilities", {
      summary: "Show Pulse deployment capabilities",
      async run({ ctx }) {
        const capabilities = await readApi<PulseCapabilitySnapshot>(ctx, "/capabilities");
        printJsonOrTable(
          ctx,
          capabilities,
          [
            {
              timescaleEnabled: yesNo(capabilities.timescaleEnabled),
              timeBucketAvailable: yesNo(capabilities.timeBucketAvailable),
              continuousAggregatesAvailable: yesNo(capabilities.continuousAggregatesAvailable),
            },
          ],
          [
            { key: "timescaleEnabled", label: "Timescale" },
            { key: "timeBucketAvailable", label: "time_bucket" },
            { key: "continuousAggregatesAvailable", label: "continuous aggregates" },
          ],
        );
      },
    }),
    ...baseCommands,
    ...pulseAccessCommands,
    ...sourceCommands,
    ...sourceTokenCommands,
    ...inventoryCommands,
    ...signalCommands,
    ...queryCommands,
    ...dashboardCommands,
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
