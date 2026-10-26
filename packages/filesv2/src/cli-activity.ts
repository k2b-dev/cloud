import {
  arg,
  type CloudCliContext,
  type CloudCliText,
  cliAmbiguityText,
  cliText,
  command,
  flag,
  localizeCloudCliText,
  printRows,
  printStructured,
} from "@k2b/cloud/cli";
import { principalLabel } from "@k2b/cloud/shared";
import type { ActivityChain, ActivityEntry, ActivityInput, ActivityPage, ShareAccessCounts } from "./activity-contracts";
import { ACTIVITY_PAGE_LIMIT, HistoryAction } from "./activity-contracts";
import type { ApiType } from "./api";
import { CliAddressError, parseFileAddress } from "./cli-address";
import { cloudRequest } from "./cli-request";

/** History must also work for a missing path: never stat it or invoke the provisioning bases endpoint. */
async function historyTarget(ctx: CloudCliContext, raw: string): Promise<Pick<ActivityInput, "baseId" | "path"> | { entryId: string }> {
  const api = ctx.createApiClient<ApiType>("/api/filesv2");
  try {
    const address = parseFileAddress(raw);
    if (address.kind === "file-id") return { entryId: address.id };
    if (address.area.kind === "id") return { baseId: address.area.id, path: address.path };
    const bases = await cloudRequest<{ id: string; name: string; kind: "users" | "groups" }[]>(ctx, (signal) =>
      api.activity.bases.$get({}, { init: { signal } }),
    );
    const ref = address.area;
    const matches = bases.filter((base) =>
      ref.kind === "me"
        ? base.kind === "users"
        : base.id === ref.value || base.id.endsWith(`:${ref.value}`) || (base.kind === "groups" && base.name === ref.value),
    );
    if (!matches.length)
      throw new Error(
        cliText(ctx, { en: `404 No area matches "${address.container}".`, de: `404 Kein Bereich passt zu „${address.container}“.` }),
      );
    if (matches.length > 1)
      throw new Error(
        cliText(
          ctx,
          cliAmbiguityText({
            value: address.container,
            resources: { en: "areas", de: "Bereichen" },
            candidates: matches.map((base) => ({ path: base.name, id: base.id })),
          }),
        ),
      );
    return { baseId: matches[0]!.id, path: address.path };
  } catch (error) {
    if (error instanceof CliAddressError) throw new Error(cliText(ctx, error.text));
    throw error;
  }
}

export function activityCommands(locale?: string) {
  const t = (text: CloudCliText) => localizeCloudCliText(locale, text);
  const api = (ctx: CloudCliContext) => ctx.createApiClient<ApiType>("/api/filesv2");
  const filters = {
    search: flag.string({ description: t({ en: "Search visible names and old paths", de: "Sichtbare Namen und alte Pfade suchen" }) }),
    actor: flag.string({ description: t({ en: "Acting user UUID", de: "UUID der handelnden Person" }) }),
    action: flag.enum(HistoryAction.options, { description: t({ en: "History action code", de: "Aktionscode des Verlaufs" }) }),
    from: flag.string({ description: t({ en: "Inclusive ISO timestamp with timezone", de: "Inklusiver ISO-Zeitstempel mit Zeitzone" }) }),
    to: flag.string({ description: t({ en: "Inclusive ISO timestamp with timezone", de: "Inklusiver ISO-Zeitstempel mit Zeitzone" }) }),
    after: flag.string({
      description: t({ en: "Unchanged next cursor; keep the same filters", de: "Unveränderter next-Cursor; dieselben Filter beibehalten" }),
    }),
    limit: flag.int({
      min: 1,
      max: ACTIVITY_PAGE_LIMIT,
      description: t({ en: "Visible entries per page (default 50)", de: "Sichtbare Einträge je Seite (Standard 50)" }),
    }),
    folder: flag.boolean({
      description: t({
        en: "Include descendant history below the addressed path",
        de: "Verlauf unterhalb des angegebenen Pfads einschließen",
      }),
    }),
  };
  return [
    command("history show", {
      summary: t({ en: "Read one visible history event", de: "Einen sichtbaren Verlaufseintrag lesen" }),
      args: { id: arg.required({ description: t({ en: "Activity UUID", de: "UUID des Verlaufseintrags" }) }) },
      async run({ ctx, args }) {
        const result = await cloudRequest<ActivityEntry>(ctx, (signal) =>
          api(ctx).activity[":activityId"].$get({ param: { activityId: args.id } }, { init: { signal } }),
        );
        if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result));
      },
    }),
    command("history", {
      summary: t({
        en: "Read file or folder history, or search visible activity",
        de: "Datei- oder Ordnerverlauf lesen oder sichtbare Aktivitäten suchen",
      }),
      args: {
        file: arg.optional({
          description: t({
            en: "<area>:/path or file ID; omit for all visible history",
            de: "<bereich>:/pfad oder Datei-ID; ohne Angabe alle sichtbaren Aktivitäten",
          }),
        }),
      },
      flags: filters,
      async run({ ctx, args, flags }) {
        const target = args.file ? await historyTarget(ctx, args.file) : {};
        const query = {
          scope: flags.folder ? ("folder" as const) : ("item" as const),
          q: flags.search,
          actor: flags.actor,
          action: flags.action,
          from: flags.from,
          to: flags.to,
          cursor: flags.after,
          limit: flags.limit?.toString(),
        };
        const page = await cloudRequest<ActivityPage>(ctx, (signal) =>
          "entryId" in target
            ? api(ctx).activity.entries[":id"].$get({ param: { id: target.entryId }, query }, { init: { signal } })
            : api(ctx).activity.$get({ query: { ...query, ...target } }, { init: { signal } }),
        );
        printRows(ctx, page, page.items, [
          { key: "id", label: "ID" },
          { key: "time", label: t({ en: "Time", de: "Zeit" }) },
          { key: "action", label: t({ en: "Action", de: "Aktion" }) },
          { key: "state", label: t({ en: "State", de: "Zustand" }) },
          {
            key: "actor",
            label: t({ en: "Who", de: "Wer" }),
            value: (row) =>
              row.actor.kind === "user"
                ? principalLabel(
                    { principal: { type: "user", userId: row.actor.userId ?? "" }, displayName: row.actor.name },
                    ctx.options.locale,
                  )
                : (row.actor.name ?? row.actor.kind),
          },
          {
            key: "before",
            label: t({ en: "Before", de: "Vorher" }),
            value: (row) => (row.before.visibility === "hidden" ? "—" : row.before.path),
          },
          {
            key: "after",
            label: t({ en: "After", de: "Nachher" }),
            value: (row) => (row.after.visibility === "hidden" ? "—" : row.after.path),
          },
        ]);
        if (ctx.options.output === "text") {
          if (page.next) ctx.error(`${t({ en: "Next page: --after", de: "Nächste Seite: --after" })} ${page.next}`);
          if (page.scanLimitReached)
            ctx.error(
              t({
                en: "Scan limit reached; continue with next even if this page is empty.",
                de: "Prüfgrenze erreicht; auch bei leerer Seite mit next fortsetzen.",
              }),
            );
          if (page.searchLimitReached)
            ctx.error(
              t({
                en: "Search limit reached (200 matches). Narrow the filters.",
                de: "Suchgrenze erreicht (200 Treffer). Filter eingrenzen.",
              }),
            );
        }
      },
    }),
    command("history chain", {
      summary: t({ en: "Follow movement history and check the current location", de: "Umzüge verfolgen und den aktuellen Ort prüfen" }),
      args: { activity: arg.required({ description: t({ en: "Activity UUID from history", de: "Aktivitäts-UUID aus dem Verlauf" }) }) },
      async run({ ctx, args }) {
        const result = await cloudRequest<ActivityChain>(ctx, (signal) =>
          api(ctx).activity[":activityId"].chain.$get({ param: { activityId: args.activity } }, { init: { signal } }),
        );
        if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result));
      },
    }),
    command("shares access", {
      summary: t({
        en: "Read link access counts as creator or administrator",
        de: "Linkzugriffszahlen als Ersteller oder Administrator lesen",
      }),
      args: { share: arg.required({ description: t({ en: "Share UUID", de: "Link-UUID" }) }) },
      flags: {
        from: flag.string({ required: true, description: t({ en: "First UTC date (YYYY-MM-DD)", de: "Erster UTC-Tag (JJJJ-MM-TT)" }) }),
        to: flag.string({
          required: true,
          description: t({ en: "Last UTC date, inclusive (YYYY-MM-DD)", de: "Letzter UTC-Tag, inklusiv (JJJJ-MM-TT)" }),
        }),
        "timeline-after": flag.string({
          description: t({ en: "Unchanged timeline.next UTC bucket start", de: "Unveränderter UTC-Zeitpunkt aus timeline.next" }),
        }),
        after: flag.string({ description: t({ en: "Unchanged networks.next key", de: "Unveränderter networks.next-Schlüssel" }) }),
        limit: flag.int({ description: t({ en: "Networks per page (default 50)", de: "Netze je Seite (Standard 50)" }) }),
      },
      async run({ ctx, args, flags }) {
        if (!flags.from || !flags.to)
          throw new Error(t({ en: "Pass --from and --to UTC dates.", de: "Gib UTC-Daten mit --from und --to an." }));
        const { from, to } = flags;
        const result = await cloudRequest<ShareAccessCounts>(ctx, (signal) =>
          api(ctx).shares[":shareId"].access.$get(
            {
              param: { shareId: args.share },
              query: { from, to, networkAfter: flags.after, timelineAfter: flags["timeline-after"], networkLimit: flags.limit?.toString() },
            },
            { init: { signal } },
          ),
        );
        if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result));
      },
    }),
  ];
}
