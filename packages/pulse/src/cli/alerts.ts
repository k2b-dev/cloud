import { arg, type CloudCliText, command, confirmFlag, flag, localizeCloudCliText, paginationFlags } from "@k2b/cloud/cli";
import type { AlertRule } from "../alert-contracts";
import { validateSqlInput } from "../sql-params";
import { requireDefaultBaseRef } from "./context";
import { baseFlag } from "./flags";
import { jsonRequest, printJsonOrTable, printMessage, printStructured, queryString, readApi } from "./shared";
import { parseSqlParameters, readSqlInput, sqlInputFlags } from "./sql";

const finiteThreshold = (value: string | undefined, t: (text: CloudCliText) => string): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!value.trim() || !Number.isFinite(parsed))
    throw new Error(t({ en: "Thresholds must be finite numbers.", de: "Schwellen müssen endliche Zahlen sein." }));
  return parsed;
};
export const createAlertCommands = (locale?: string) => {
  const t = (text: CloudCliText) => localizeCloudCliText(locale, text);
  return [
    command("alerts list", {
      summary: t({ en: "List saved SQL alerts in a base", de: "Gespeicherte SQL-Alarmregeln einer Base auflisten" }),
      flags: { ...baseFlag, ...paginationFlags({ defaultPerPage: 25, maxPerPage: 1000 }) },
      async run({ ctx, flags }) {
        const base = flags.base ?? (await requireDefaultBaseRef(ctx));
        const page = flags.page ?? 1;
        const perPage = flags.perPage ?? 25;
        const result = await readApi<{ items: AlertRule[]; total: number; nextOffset: number | null }>(
          ctx,
          `/bases/${encodeURIComponent(base)}/alerts${queryString({ limit: perPage, offset: (page - 1) * perPage })}`,
        );
        printJsonOrTable(ctx, result, result.items, [{ key: "id" }, { key: "name" }, { key: "revision" }, { key: "updatedAt" }]);
      },
    }),
    command("alerts get", {
      summary: t({ en: "Read an alert rule", de: "Eine Alarmregel lesen" }),
      args: { rule: arg.required({ valueLabel: "rule-id" }) },
      flags: baseFlag,
      async run({ ctx, args, flags }) {
        const base = flags.base ?? (await requireDefaultBaseRef(ctx));
        const result = await readApi<AlertRule>(ctx, `/bases/${encodeURIComponent(base)}/alerts/${encodeURIComponent(args.rule)}`);
        if (!printStructured(ctx, result)) {
          ctx.print(
            t({
              en: `${result.name} (${result.id}, revision ${result.revision})`,
              de: `${result.name} (${result.id}, Revision ${result.revision})`,
            }),
          );
          ctx.print(result.sql);
        }
      },
    }),
    command("alerts save", {
      summary: t({ en: "Create or update an alert rule", de: "Eine Alarmregel anlegen oder ändern" }),
      description: t({
        en: "Updating requires --rule and --expected-revision. Reuse --idempotency-key after a failed request.",
        de: "Änderungen brauchen --rule und --expected-revision. Nach einem fehlgeschlagenen Aufruf denselben --idempotency-key wiederverwenden.",
      }),
      args: { sql: arg.optional({ valueLabel: "sql-or--" }) },
      flags: {
        ...baseFlag,
        ...sqlInputFlags,
        sqlFile: flag.string({
          name: "sql-file",
          description: t({ en: "Read SQL from this UTF-8 file", de: "SQL aus dieser UTF-8-Datei lesen" }),
        }),
        comparison: flag.enum(["above", "below"], {
          required: true,
          description: t({ en: "Threshold direction", de: "Richtung der Schwellen" }),
        }),
        warn: flag.string({ description: t({ en: "Warning threshold (finite number)", de: "Warnschwelle (endliche Zahl)" }) }),
        critical: flag.string({ description: t({ en: "Critical threshold (finite number)", de: "Kritische Schwelle (endliche Zahl)" }) }),
        for: flag.int({
          min: 0,
          default: 0,
          description: t({ en: "Continuous breach duration in seconds", de: "Mindestdauer der Überschreitung in Sekunden" }),
        }),
        every: flag.int({
          min: 300,
          default: 300,
          description: t({ en: "Evaluation interval in seconds", de: "Prüfintervall in Sekunden" }),
        }),
        name: flag.string({ required: true, description: t({ en: "Alert rule name", de: "Name der Alarmregel" }) }),
        rule: flag.string({ description: t({ en: "Alert rule ID to update", de: "ID der zu ändernden Alarmregel" }) }),
        expectedRevision: flag.int({
          name: "expected-revision",
          min: 1,
          description: t({ en: "Revision returned by alerts get", de: "Revision aus alerts get" }),
        }),
        idempotencyKey: flag.string({
          name: "idempotency-key",
          description: t({ en: "Stable retry key for this save", de: "Stabiler Schlüssel für die Wiederholung dieses Speicherns" }),
        }),
      },
      async run({ ctx, args, flags }) {
        if (Boolean(flags.rule) !== (flags.expectedRevision !== undefined))
          throw new Error(
            t({ en: "Use --rule and --expected-revision together.", de: "--rule und --expected-revision gemeinsam angeben." }),
          );
        const base = flags.base ?? (await requireDefaultBaseRef(ctx));
        if (flags.sqlFile && flags.file)
          throw new Error(t({ en: "Use either --sql-file or --file.", de: "Entweder --sql-file oder --file verwenden." }));
        const sql = await readSqlInput(args.sql, flags.sqlFile ?? flags.file);
        const params = parseSqlParameters(flags.param);
        validateSqlInput(sql, params);
        const path = `/bases/${encodeURIComponent(base)}/alerts${flags.rule ? `/${encodeURIComponent(flags.rule)}` : ""}`;
        const request = jsonRequest(flags.rule ? "PATCH" : "POST", {
          name: flags.name,
          comparison: flags.comparison,
          warn: finiteThreshold(flags.warn, t),
          critical: finiteThreshold(flags.critical, t),
          minDurationSeconds: flags.for,
          intervalSeconds: flags.every,
          sql,
          params,
          expectedRevision: flags.expectedRevision,
        });
        if (flags.idempotencyKey) request.headers = { ...request.headers, "Idempotency-Key": flags.idempotencyKey };
        const result = await readApi<AlertRule>(ctx, path, request);
        if (!printStructured(ctx, result))
          ctx.print(
            t({
              en: `Saved ${result.name} (${result.id}, revision ${result.revision}).`,
              de: `${result.name} gespeichert (${result.id}, Revision ${result.revision}).`,
            }),
          );
      },
    }),
    command("alerts delete", {
      summary: t({ en: "Delete an alert rule", de: "Eine Alarmregel löschen" }),
      args: { rule: arg.required({ valueLabel: "rule-id" }) },
      flags: {
        ...baseFlag,
        expectedRevision: flag.int({
          name: "expected-revision",
          required: true,
          min: 1,
          description: t({ en: "Revision returned by alerts get", de: "Revision aus alerts get" }),
        }),
        yes: confirmFlag(t({ en: "Delete this alert rule", de: "Diese Alarmregel löschen" })),
      },
      async run({ ctx, args, flags }) {
        if (!flags.yes) throw new Error(t({ en: "Refusing to delete without --yes.", de: "Löschen erfordert --yes." }));
        const base = flags.base ?? (await requireDefaultBaseRef(ctx));
        const result = await readApi<{ deleted: boolean }>(
          ctx,
          `/bases/${encodeURIComponent(base)}/alerts/${encodeURIComponent(args.rule)}`,
          jsonRequest("DELETE", { expectedRevision: flags.expectedRevision }),
        );
        printMessage(ctx, result, t({ en: "Alert rule deleted.", de: "Alarmregel gelöscht." }));
      },
    }),
  ];
};
