import { arg, command, confirmFlag, flag } from "@k2b/cloud/cli";
import type { PulseSource, PulseSourceScrape, SourceKind } from "../contracts";
import { listSources, requireRestArg, resolveBaseFromCommand, resolveSource } from "./context";
import { baseFlag, bearerTokenFlags, sourceKindFlag } from "./flags";
import { scrapeRows, sourceRows } from "./rows";
import { jsonRequest, printJsonOrTable, printMessage, printStructured, readApi, readOptionalSecretInput } from "./shared";

type IngestResult = { metrics: number; events: number; states: number };

export const sourceCommands = [
  command("sources list", {
    summary: "List Pulse sources",
    flags: baseFlag,
    args: { args: arg.rest({ valueLabel: "base" }) },
    async run({ ctx, args }) {
      const { base } = await resolveBaseFromCommand(ctx, args.args, 0);
      const sources = await listSources(ctx, base.id);
      printJsonOrTable(ctx, sources, sourceRows(sources), [
        { key: "id" },
        { key: "name" },
        { key: "kind" },
        { key: "enabled" },
        { key: "interval" },
        { key: "token" },
        { key: "lastSeenAt" },
      ]);
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
      scrapeIntervalSeconds: flag.int({ name: "scrape-interval-seconds", min: 10, max: 86400, description: "Scrape interval" }),
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
          kind: flags.kind as SourceKind,
          name: flags.name,
          endpointUrl: flags.endpointUrl ?? null,
          bearerToken: bearerToken ?? null,
          scrapeIntervalSeconds: flags.scrapeIntervalSeconds ?? null,
        }),
      );
      if (!printStructured(ctx, source)) ctx.print(`Created source ${source.name} (${source.id}).`);
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
      clearBearerToken: flag.boolean({ name: "clear-bearer-token", description: "Remove the configured metrics bearer token" }),
      scrapeIntervalSeconds: flag.int({ name: "scrape-interval-seconds", min: 10, max: 86400, description: "Scrape interval" }),
    },
    args: { args: arg.rest({ valueLabel: "base source", required: true }) },
    async run({ ctx, args, flags }) {
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
          name: flags.name,
          enabled: flags.enabled === undefined ? undefined : flags.enabled === "true",
          endpointUrl: flags.endpointUrl,
          bearerToken,
          scrapeIntervalSeconds: flags.scrapeIntervalSeconds,
        }),
      );
      if (!printStructured(ctx, updated)) ctx.print(`Updated source ${updated.name} (${updated.id}).`);
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
      await readApi<unknown>(ctx, `/bases/${encodeURIComponent(base.id)}/sources/${encodeURIComponent(source.id)}`, jsonRequest("DELETE"));
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
