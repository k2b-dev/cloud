import {
  arg,
  type CloudCliText,
  cloudResourceUrl,
  command,
  confirmFlag,
  flag,
  localizeCloudCliText,
  withCloudResourcePermalink,
} from "@k2b/cloud/cli";
import type { PulseSource, PulseSourceScrape, SourceKind } from "../contracts";
import { listSources, requireRestArg, resolveBaseFromCommand, resolveSource } from "./context";
import { baseFlag, bearerTokenFlags, sourceKindFlag } from "./flags";
import { scrapeRows, sourceRows } from "./rows";
import { jsonRequest, printJsonOrTable, printMessage, printStructured, readApi, readOptionalSecretInput } from "./shared";

const expectationFlags = (t: (text: CloudCliText) => string) => ({
  expectEvery: flag.int({
    name: "expect-every",
    min: 1,
    max: 2_147_483_647,
    description: t({ en: "Expected interval in seconds for HTTP ingest", de: "Erwarteter Abstand in Sekunden für HTTP-Ingest" }),
  }),
  expectDailyBy: flag.string({
    name: "expect-daily-by",
    description: t({ en: "Expected daily HH:MM in the base timezone", de: "Täglich erwartet bis HH:MM in der Base-Zeitzone" }),
  }),
  clearExpectation: flag.boolean({
    name: "clear-expectation",
    description: t({ en: "Do not mark an HTTP ingest source stale", de: "Eine HTTP-Ingest-Quelle nicht als veraltet markieren" }),
  }),
});
const expectation = (
  flags: { expectEvery?: number; expectDailyBy?: string; clearExpectation: boolean },
  t: (text: CloudCliText) => string,
) => {
  if ([flags.expectEvery !== undefined, flags.expectDailyBy !== undefined, flags.clearExpectation].filter(Boolean).length > 1)
    throw new Error(
      t({
        en: "Choose --expect-every, --expect-daily-by or --clear-expectation.",
        de: "Wähle --expect-every, --expect-daily-by oder --clear-expectation.",
      }),
    );
  if (flags.expectDailyBy !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(flags.expectDailyBy))
    throw new Error(t({ en: "--expect-daily-by must be HH:MM.", de: "--expect-daily-by muss HH:MM sein." }));
  return flags.expectEvery !== undefined || flags.expectDailyBy !== undefined || flags.clearExpectation
    ? { expectEverySeconds: flags.expectEvery ?? null, expectDailyBy: flags.expectDailyBy ?? null }
    : {};
};
type IngestResult = { metrics: number; events: number; states: number };

export const createSourceCommands = (locale?: string) => {
  const t = (text: CloudCliText) => localizeCloudCliText(locale, text);
  return [
    command("sources list", {
      summary: "List Pulse sources",
      flags: baseFlag,
      args: { args: arg.rest({ valueLabel: "base" }) },
      async run({ ctx, args }) {
        const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
        const sources = await listSources(ctx, base.id);
        printJsonOrTable(
          ctx,
          sources.map((resource) => withCloudResourcePermalink(ctx, "pulse.source", resource)),
          sourceRows(sources),
          [
            { key: "id" },
            { key: "name" },
            { key: "kind" },
            { key: "enabled" },
            { key: "interval" },
            { key: "token" },
            { key: "newestDataAt", label: "Newest data" },
            { key: "throttled", label: "Throttled" },
          ],
        );
      },
    }),
    command("sources create", {
      summary: "Create a Pulse source",
      flags: {
        ...baseFlag,
        name: flag.string({ required: true, description: "Source name" }),
        kind: sourceKindFlag,
        endpointUrl: flag.string({ name: "endpoint-url", description: "Metrics endpoint URL" }),
        ...bearerTokenFlags,
        ...expectationFlags(t),
        metricFilter: flag.stringList({
          name: "metric-filter",
          description: "Include this metric family or prefix (repeatable; trailing * supported)",
        }),
        scrapeIntervalSeconds: flag.int({
          name: "scrape-interval-seconds",
          min: 60,
          max: 86400,
          description: "Scrape interval in seconds (multiples of 60)",
        }),
      },
      args: { args: arg.rest({ valueLabel: "base" }) },
      async run({ ctx, args, flags }) {
        const bearerToken = await readOptionalSecretInput(
          { file: flags.bearerTokenFile, stdin: flags.bearerTokenStdin },
          "Metrics endpoint bearer token",
        );
        const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
        const source = await readApi<PulseSource>(
          ctx,
          `/bases/${encodeURIComponent(base.id)}/sources`,
          jsonRequest("POST", {
            ...expectation(flags, t),
            kind: flags.kind as SourceKind,
            name: flags.name,
            endpointUrl: flags.endpointUrl ?? null,
            bearerToken: bearerToken ?? null,
            scrapeIntervalSeconds: flags.scrapeIntervalSeconds ?? null,
            metricFilters: flags.metricFilter?.length ? flags.metricFilter : undefined,
          }),
        );
        if (!printStructured(ctx, withCloudResourcePermalink(ctx, "pulse.source", source)))
          ctx.print(`Created source ${source.name} (${source.id}). ${cloudResourceUrl(ctx, { type: "pulse.source", id: source.id })}`);
      },
    }),
    command("sources update", {
      summary: "Update a Pulse source",
      flags: {
        ...baseFlag,
        name: flag.string({ description: "New source name" }),
        enabled: flag.enum(["true", "false"], { description: "Enable or disable the source" }),
        endpointUrl: flag.string({ name: "endpoint-url", description: "Metrics endpoint URL" }),
        ...bearerTokenFlags,
        ...expectationFlags(t),
        metricFilter: flag.stringList({
          name: "metric-filter",
          description: "Include this metric family or prefix (repeatable; trailing * supported)",
        }),
        clearMetricFilters: flag.boolean({ name: "clear-metric-filters", description: "Include all metric families" }),
        clearBearerToken: flag.boolean({ name: "clear-bearer-token", description: "Remove the configured metrics bearer token" }),
        scrapeIntervalSeconds: flag.int({
          name: "scrape-interval-seconds",
          min: 60,
          max: 86400,
          description: "Scrape interval in seconds (multiples of 60)",
        }),
      },
      args: { args: arg.rest({ valueLabel: "base source", required: true }) },
      async run({ ctx, args, flags }) {
        if (flags.clearMetricFilters && flags.metricFilter?.length)
          throw new Error("Pass either --metric-filter or --clear-metric-filters.");
        if ((flags.bearerTokenFile || flags.bearerTokenStdin) && flags.clearBearerToken) {
          throw new Error("Pass either a bearer token input or --clear-bearer-token, not both.");
        }
        const bearerToken = flags.clearBearerToken
          ? null
          : await readOptionalSecretInput({ file: flags.bearerTokenFile, stdin: flags.bearerTokenStdin }, "Metrics endpoint bearer token");
        const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 1);
        const source = await resolveSource(ctx, base.id, requireRestArg(rest, 0, "source"));
        const updated = await readApi<PulseSource>(
          ctx,
          `/bases/${encodeURIComponent(base.id)}/sources/${encodeURIComponent(source.id)}`,
          jsonRequest("PATCH", {
            ...expectation(flags, t),
            expectedRevision: source.revision,
            name: flags.name,
            enabled: flags.enabled === undefined ? undefined : flags.enabled === "true",
            endpointUrl: flags.endpointUrl,
            bearerToken,
            scrapeIntervalSeconds: flags.scrapeIntervalSeconds,
            metricFilters: flags.clearMetricFilters ? [] : flags.metricFilter?.length ? flags.metricFilter : undefined,
          }),
        );
        if (!printStructured(ctx, withCloudResourcePermalink(ctx, "pulse.source", updated)))
          ctx.print(`Updated source ${updated.name} (${updated.id}).`);
      },
    }),
    command("sources delete", {
      summary: "Delete a Pulse source",
      flags: { ...baseFlag, yes: confirmFlag("Delete this source") },
      args: { args: arg.rest({ valueLabel: "base source", required: true }) },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error("Refusing to delete without --yes.");
        const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 1);
        const source = await resolveSource(ctx, base.id, requireRestArg(rest, 0, "source"));
        await readApi<unknown>(
          ctx,
          `/bases/${encodeURIComponent(base.id)}/sources/${encodeURIComponent(source.id)}`,
          jsonRequest("DELETE"),
        );
        printMessage(ctx, { deleted: source.id }, `Deleted source ${source.name}.`);
      },
    }),
    command("sources scrape", {
      summary: "Scrape a metrics source now",
      flags: baseFlag,
      args: { args: arg.rest({ valueLabel: "base source", required: true }) },
      async run({ ctx, args }) {
        const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 1);
        const source = await resolveSource(ctx, base.id, requireRestArg(rest, 0, "source"));
        const result = await readApi<IngestResult>(
          ctx,
          `/bases/${encodeURIComponent(base.id)}/sources/${encodeURIComponent(source.id)}/scrape`,
          jsonRequest("POST"),
        );
        printJsonOrTable(ctx, result, [result], [{ key: "metrics" }, { key: "events" }, { key: "states" }]);
      },
    }),
    command("sources scrapes", {
      summary: "List recent scrape attempts for a source",
      flags: baseFlag,
      args: { args: arg.rest({ valueLabel: "base source", required: true }) },
      async run({ ctx, args }) {
        const { base, rest } = await resolveBaseFromCommand(ctx, args.args, 1);
        const source = await resolveSource(ctx, base.id, requireRestArg(rest, 0, "source"));
        const scrapes = await readApi<PulseSourceScrape[]>(
          ctx,
          `/bases/${encodeURIComponent(base.id)}/sources/${encodeURIComponent(source.id)}/scrapes`,
        );
        printJsonOrTable(ctx, scrapes, scrapeRows(scrapes), [
          { key: "success" },
          { key: "finishedAt" },
          { key: "data" },
          { key: "durationMs" },
          { key: "error" },
        ]);
      },
    }),
  ];
};
