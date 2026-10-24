import { arg, type CloudCliText, command, confirmFlag, flag, localizeCloudCliText, paginationFlags } from "@k2b/cloud/cli";
import { type Dashboard, DashboardSaveSchema } from "../dashboard-contracts";
import type { DashboardPanelResult } from "../service/dashboard-panels";
import { requireDefaultBaseRef } from "./context";
import { baseFlag } from "./flags";
import { jsonRequest, printJsonOrTable, printMessage, printStructured, queryString, readApi, readJsonInput } from "./shared";

export const createDashboardCommands = (locale?: string) => {
  const t = (text: CloudCliText) => localizeCloudCliText(locale, text);
  const revision = flag.int({
    name: "expected-revision",
    required: true,
    min: 1,
    description: t({ en: "Current revision from dashboards get", de: "Aktuelle Revision aus dashboards get" }),
  });
  return [
    command("dashboards list", {
      summary: t({ en: "List dashboards in a base", de: "Dashboards einer Base auflisten" }),
      flags: { ...baseFlag, ...paginationFlags({ defaultPerPage: 25, maxPerPage: 1000 }) },
      async run({ ctx, flags }) {
        const base = flags.base ?? (await requireDefaultBaseRef(ctx));
        const page = await readApi<{ items: Dashboard[]; total: number; nextOffset: number | null }>(
          ctx,
          `/bases/${encodeURIComponent(base)}/dashboards${queryString({ limit: flags.perPage ?? 25, offset: ((flags.page ?? 1) - 1) * (flags.perPage ?? 25) })}`,
        );
        printJsonOrTable(ctx, page, page.items, [{ key: "id" }, { key: "name" }, { key: "revision" }, { key: "published" }]);
      },
    }),
    command("dashboards get", {
      summary: t({ en: "Read dashboard JSON and SQL", de: "Dashboard-JSON und SQL lesen" }),
      args: { dashboard: arg.required({ valueLabel: "dashboard-id" }) },
      flags: baseFlag,
      async run({ ctx, args, flags }) {
        const base = flags.base ?? (await requireDefaultBaseRef(ctx));
        const result = await readApi<Dashboard>(ctx, `/bases/${encodeURIComponent(base)}/dashboards/${encodeURIComponent(args.dashboard)}`);
        if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result, null, 2));
      },
    }),
    command("dashboards save", {
      summary: t({ en: "Save a dashboard from JSON", de: "Ein Dashboard aus JSON speichern" }),
      description: t({
        en: "JSON contains name, definition.panels and expectedRevision for updates. SQL/output changes end an existing publication. Reuse --idempotency-key after an interrupted request.",
        de: "JSON enthält name, definition.panels und bei Änderungen expectedRevision. Änderungen an SQL/Ausgabe beenden eine bestehende Freigabe. Nach Abbruch denselben --idempotency-key verwenden.",
      }),
      flags: {
        ...baseFlag,
        dashboard: flag.string({ description: "Dashboard ID to update" }),
        input: flag.input({ name: "input", fileName: "file", stdinName: "stdin", valueLabel: "json" }),
        idempotencyKey: flag.string({ name: "idempotency-key", description: "Stable retry key" }),
      },
      async run({ ctx, flags }) {
        const body = DashboardSaveSchema.parse(await readJsonInput<unknown>(flags.input, "dashboard JSON"));
        if (Boolean(flags.dashboard) !== (body.expectedRevision !== undefined))
          throw new Error(
            t({ en: "Use --dashboard and expectedRevision together.", de: "--dashboard und expectedRevision gemeinsam angeben." }),
          );
        const base = flags.base ?? (await requireDefaultBaseRef(ctx));
        const request = jsonRequest(flags.dashboard ? "PATCH" : "POST", body);
        if (flags.idempotencyKey) request.headers = { ...request.headers, "Idempotency-Key": flags.idempotencyKey };
        const result = await readApi<Dashboard>(
          ctx,
          `/bases/${encodeURIComponent(base)}/dashboards${flags.dashboard ? `/${encodeURIComponent(flags.dashboard)}` : ""}`,
          request,
        );
        printMessage(
          ctx,
          result,
          t({ en: `Saved ${result.name} (revision ${result.revision}).`, de: `${result.name} gespeichert (Revision ${result.revision}).` }),
        );
      },
    }),
    command("dashboards panel", {
      summary: t({ en: "Read or refresh one dashboard panel", de: "Ein Dashboard-Panel lesen oder aktualisieren" }),
      args: { dashboard: arg.required({ valueLabel: "dashboard-id" }), panel: arg.required({ valueLabel: "panel-id" }) },
      flags: {
        ...baseFlag,
        range: flag.enum(["24h", "7d", "30d", "90d"], { default: "24h", description: "Time range" }),
        from: flag.string({ description: "Custom start (RFC 3339)" }),
        to: flag.string({ description: "Custom end (RFC 3339)" }),
      },
      async run({ ctx, args, flags }) {
        const base = flags.base ?? (await requireDefaultBaseRef(ctx));
        const result = await readApi<DashboardPanelResult>(
          ctx,
          `/bases/${encodeURIComponent(base)}/dashboards/${encodeURIComponent(args.dashboard)}/panels/${encodeURIComponent(args.panel)}${queryString({ range: flags.range, from: flags.from, to: flags.to })}`,
        );
        if (!printStructured(ctx, result)) ctx.print(JSON.stringify(result, null, 2));
      },
    }),
    command("dashboards publish", {
      summary: t({ en: "Publish reviewed dashboard columns", de: "Geprüfte Dashboard-Spalten öffentlich freigeben" }),
      args: { dashboard: arg.required({ valueLabel: "dashboard-id" }) },
      flags: {
        ...baseFlag,
        expectedRevision: revision,
        columns: flag.input({ name: "columns", fileName: "file", stdinName: "stdin", valueLabel: "json" }),
        yes: confirmFlag("Make these output columns public"),
        idempotencyKey: flag.string({ name: "idempotency-key", description: "Stable retry key" }),
      },
      async run({ ctx, args, flags }) {
        if (!flags.yes)
          throw new Error(
            t({
              en: "Publishing requires --yes and explicit --columns JSON mapping each panel ID to reviewed column names.",
              de: "Freigeben erfordert --yes und --columns mit den geprüften Spalten je Panel-ID als JSON.",
            }),
          );
        const base = flags.base ?? (await requireDefaultBaseRef(ctx));
        const request = jsonRequest("POST", {
          expectedRevision: flags.expectedRevision,
          columns: await readJsonInput<unknown>(flags.columns, "public columns JSON"),
        });
        if (flags.idempotencyKey) request.headers = { ...request.headers, "Idempotency-Key": flags.idempotencyKey };
        const result = await readApi<{ href: string; revision: number }>(
          ctx,
          `/bases/${encodeURIComponent(base)}/dashboards/${encodeURIComponent(args.dashboard)}/publish`,
          request,
        );
        if (!printStructured(ctx, result)) ctx.print(result.href);
      },
    }),
    ...(["unpublish", "delete"] as const).map((action) =>
      command(`dashboards ${action}`, {
        summary:
          action === "delete"
            ? t({ en: "Delete a dashboard", de: "Ein Dashboard löschen" })
            : t({ en: "Revoke a dashboard link", de: "Dashboard-Freigabe beenden" }),
        args: { dashboard: arg.required({ valueLabel: "dashboard-id" }) },
        flags: {
          ...baseFlag,
          expectedRevision: revision,
          yes: confirmFlag(action === "delete" ? "Delete this dashboard" : "Revoke this public link"),
          idempotencyKey: flag.string({ name: "idempotency-key", description: "Stable retry key" }),
        },
        async run({ ctx, args, flags }) {
          if (!flags.yes) throw new Error(t({ en: "This operation requires --yes.", de: "Dieser Vorgang erfordert --yes." }));
          const base = flags.base ?? (await requireDefaultBaseRef(ctx));
          const request = jsonRequest(action === "delete" ? "DELETE" : "POST", { expectedRevision: flags.expectedRevision });
          if (flags.idempotencyKey) request.headers = { ...request.headers, "Idempotency-Key": flags.idempotencyKey };
          const result = await readApi<{ deleted: boolean; revision: number }>(
            ctx,
            `/bases/${encodeURIComponent(base)}/dashboards/${encodeURIComponent(args.dashboard)}${action === "unpublish" ? "/unpublish" : ""}`,
            request,
          );
          printMessage(
            ctx,
            result,
            action === "delete"
              ? t({ en: "Dashboard deleted.", de: "Dashboard gelöscht." })
              : t({ en: "Public link revoked.", de: "Freigabe beendet." }),
          );
        },
      }),
    ),
  ];
};
