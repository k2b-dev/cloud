import { type DateContext, dates } from "@k2b/stdlib";
import { toPgUuidArray } from "@valentinkolb/cloud/services";
import { SQL, sql } from "bun";
import type { SqlClient } from "./audit";
import { insertWithShortIdForDb } from "./short-id";

type NumberSeriesAssignment = "creation" | "finalization";
type NumberSeriesStrategy = "sequence" | "date_sequence" | "document";

type NumberSeriesFormat = {
  strategy: NumberSeriesStrategy;
  prefix?: string;
  padding?: number;
  period?: "year" | "month" | "day";
  numberTemplate?: string;
};

type NumberSeriesAllocation = {
  id: string;
  seriesId: string;
  seriesShortId: string;
  version: number;
  scope: string;
  value: number;
  renderedValue: string;
};

export type NumberSeriesSummary = {
  id: string;
  shortId: string;
  assignment: NumberSeriesAssignment;
  state: "active" | "archived";
  currentVersion: number;
  lastValue: number;
  preview: string | null;
  migrationStatus: string;
  migrationNote: string | null;
};

type SeriesRow = {
  id: string;
  short_id: string;
  assignment: NumberSeriesAssignment;
  current_version: number;
  baseline_floor: bigint | number | string;
  archived_at: Date | null;
};

type VersionRow = {
  version: number;
  strategy: NumberSeriesStrategy;
  prefix: string;
  padding: number;
  period: "year" | "month" | "day" | null;
  number_template: string | null;
};

const sequentialStrategies = new Set<NumberSeriesStrategy>(["sequence", "date_sequence"]);

let allocationPool: SQL | undefined;
const getAllocationPool = (): SQL => {
  const url = process.env.DATABASE_URL;
  allocationPool ??= url ? new SQL({ url, max: 4 }) : new SQL({ max: 4 });
  return allocationPool;
};

export const isSequentialNumberSeriesConfig = (config: Record<string, unknown>): boolean => {
  const strategy = typeof config.strategy === "string" ? config.strategy : "sequence";
  return strategy === "sequence" || strategy === "date_sequence";
};

export const numberSeriesFormatForField = (config: Record<string, unknown>): NumberSeriesFormat | null => {
  const strategy = typeof config.strategy === "string" ? config.strategy : "sequence";
  if (strategy !== "sequence" && strategy !== "date_sequence") return null;
  return {
    strategy,
    prefix: typeof config.prefix === "string" ? config.prefix : "",
    padding: typeof config.padding === "number" ? config.padding : strategy === "date_sequence" ? 4 : 1,
    ...(strategy === "date_sequence" ? { period: config.period === "month" || config.period === "day" ? config.period : "year" } : {}),
  };
};

export const numberSeriesSequenceName = (seriesId: string, scope: string): string => {
  const id = seriesId.replaceAll("-", "");
  const safeScope = scope.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 16) || "global";
  if (!/^[a-f0-9]{32}$/i.test(id)) throw new Error("invalid number series id");
  return `number_${id}_${safeScope}`;
};

const formatEquals = (row: VersionRow, format: NumberSeriesFormat): boolean =>
  row.strategy === format.strategy &&
  row.prefix === (format.prefix ?? "") &&
  row.padding === (format.padding ?? 1) &&
  row.period === (format.period ?? null) &&
  row.number_template === (format.numberTemplate ?? null);

const insertVersion = async (client: SqlClient, seriesId: string, version: number, format: NumberSeriesFormat): Promise<void> => {
  await client`
    INSERT INTO grids.number_series_versions (series_id, version, strategy, prefix, padding, period, number_template)
    VALUES (
      ${seriesId}::uuid,
      ${version},
      ${format.strategy},
      ${format.prefix ?? ""},
      ${format.padding ?? 1},
      ${format.period ?? null},
      ${format.numberTemplate ?? null}
    )
  `;
};

const provision = async (
  client: SqlClient,
  owner: { kind: "field"; id: string } | { kind: "document_template"; id: string },
  format: NumberSeriesFormat,
  assignment: NumberSeriesAssignment = "creation",
): Promise<SeriesRow> => {
  const ownerColumn = owner.kind === "field" ? "field_id" : "document_template_id";
  const [existing] = await client<SeriesRow[]>`
    SELECT id::text, short_id, assignment, current_version, baseline_floor, archived_at
    FROM grids.number_series
    WHERE ${owner.kind === "field" ? sql`field_id = ${owner.id}::uuid` : sql`document_template_id = ${owner.id}::uuid`}
    FOR UPDATE
  `;
  if (existing) return existing;

  const seriesId = Bun.randomUUIDv7();
  const created = await insertWithShortIdForDb(client, "idx_grids_number_series_short_id", async (attempt, shortId) => {
    const [row] = await attempt<SeriesRow[]>`
      INSERT INTO grids.number_series (id, short_id, owner_kind, field_id, document_template_id, assignment)
      VALUES (
        ${seriesId}::uuid,
        ${shortId},
        ${owner.kind},
        ${owner.kind === "field" ? owner.id : null}::uuid,
        ${owner.kind === "document_template" ? owner.id : null}::uuid,
        ${assignment}
      )
      RETURNING id::text, short_id, assignment, current_version, baseline_floor, archived_at
    `;
    if (!row) throw new Error(`number series insert for ${ownerColumn} returned no row`);
    return row;
  });
  await insertVersion(client, created.id, created.current_version, format);
  return created;
};

export const provisionFieldNumberSeries = (
  client: SqlClient,
  fieldId: string,
  config: Record<string, unknown>,
): Promise<SeriesRow | null> => {
  const format = numberSeriesFormatForField(config);
  const assignment = config.assignment === "finalization" ? "finalization" : "creation";
  return format ? provision(client, { kind: "field", id: fieldId }, format, assignment) : Promise.resolve(null);
};

export const provisionDocumentNumberSeries = (client: SqlClient, templateId: string, numberTemplate: string): Promise<SeriesRow> =>
  provision(client, { kind: "document_template", id: templateId }, { strategy: "document", numberTemplate });

const ownerPredicate = (owner: { kind: "field" | "document_template"; id: string }) =>
  owner.kind === "field" ? sql`field_id = ${owner.id}::uuid` : sql`document_template_id = ${owner.id}::uuid`;

export const syncNumberSeriesFormat = async (
  client: SqlClient,
  owner: { kind: "field" | "document_template"; id: string },
  format: NumberSeriesFormat | null,
  assignment: NumberSeriesAssignment = "creation",
): Promise<void> => {
  const [series] = await client<SeriesRow[]>`
    SELECT id::text, short_id, assignment, current_version, baseline_floor, archived_at
    FROM grids.number_series
    WHERE ${ownerPredicate(owner)}
    FOR UPDATE
  `;
  if (!format) {
    if (series && series.archived_at === null) {
      await client`UPDATE grids.number_series SET archived_at = now(), updated_at = now() WHERE id = ${series.id}::uuid`;
    }
    return;
  }
  const current = series ?? (await provision(client, owner, format, assignment));
  if (current.assignment !== assignment) {
    await client`
      UPDATE grids.number_series SET assignment = ${assignment}, updated_at = now()
      WHERE id = ${current.id}::uuid
    `;
  }
  const [version] = await client<VersionRow[]>`
    SELECT version, strategy, prefix, padding, period, number_template
    FROM grids.number_series_versions
    WHERE series_id = ${current.id}::uuid AND version = ${current.current_version}
  `;
  if (!version) throw new Error("number series current format is missing");
  if (!formatEquals(version, format)) {
    const nextVersion = current.current_version + 1;
    await insertVersion(client, current.id, nextVersion, format);
    await client`
      UPDATE grids.number_series
      SET current_version = ${nextVersion}, archived_at = NULL, updated_at = now()
      WHERE id = ${current.id}::uuid
    `;
  } else if (current.archived_at !== null) {
    await client`UPDATE grids.number_series SET archived_at = NULL, updated_at = now() WHERE id = ${current.id}::uuid`;
  }
};

export const setNumberSeriesArchived = async (
  client: SqlClient,
  owner: { kind: "field" | "document_template"; id: string },
  archived: boolean,
): Promise<void> => {
  await client`
    UPDATE grids.number_series
    SET archived_at = ${archived ? sql`COALESCE(archived_at, now())` : sql`NULL`}, updated_at = now()
    WHERE ${ownerPredicate(owner)}
  `;
};

const dateScope = (now: Date, period: "year" | "month" | "day", dateConfig?: DateContext): string => {
  const key = dates.formatDateKey(now, dateConfig);
  if (period === "day") return key.replaceAll("-", "");
  if (period === "month") return key.slice(0, 7).replace("-", "");
  return key.slice(0, 4);
};

const renderedFieldValue = (format: VersionRow, scope: string, value: number): string => {
  const counter = String(value).padStart(Math.max(1, format.padding), "0");
  return format.strategy === "date_sequence" ? `${format.prefix}${scope}-${counter}` : `${format.prefix}${counter}`;
};

type SummaryRow = SeriesRow &
  VersionRow & {
    field_id: string | null;
    document_template_id: string | null;
    migration_status: string;
    migration_note: string | null;
    last_value: bigint | number | string | null;
  };

const mapSummary = (row: SummaryRow): NumberSeriesSummary => {
  const lastValue = Number(row.last_value ?? 0);
  const preview =
    row.strategy === "document"
      ? null
      : renderedFieldValue(row, row.strategy === "date_sequence" ? dateScope(new Date(), row.period ?? "year") : "global", lastValue + 1);
  return {
    id: row.id,
    shortId: row.short_id,
    assignment: row.assignment,
    state: row.archived_at === null ? "active" : "archived",
    currentVersion: row.current_version,
    lastValue,
    preview,
    migrationStatus: row.migration_status,
    migrationNote: row.migration_note,
  };
};

const loadSummaries = async (
  ownerColumn: "field_id" | "document_template_id",
  ownerIds: readonly string[],
): Promise<Map<string, NumberSeriesSummary>> => {
  if (ownerIds.length === 0) return new Map();
  const rows = (await sql.unsafe(
    `SELECT ns.id::text, ns.short_id, ns.assignment, ns.current_version, ns.archived_at,
            ns.field_id::text, ns.document_template_id::text, ns.migration_status, ns.migration_note,
            version.version, version.strategy, version.prefix, version.padding, version.period, version.number_template,
            COALESCE(max(pg_sequence.last_value), 0) AS last_value
       FROM grids.number_series ns
       JOIN grids.number_series_versions version
         ON version.series_id = ns.id AND version.version = ns.current_version
       LEFT JOIN grids.number_series_scopes scope ON scope.series_id = ns.id
       LEFT JOIN pg_sequences pg_sequence
         ON pg_sequence.schemaname = 'grids' AND pg_sequence.sequencename = scope.sequence_name
      WHERE ns.${ownerColumn} = ANY($1::uuid[])
      GROUP BY ns.id, version.series_id, version.version`,
    [toPgUuidArray([...ownerIds])],
  )) as SummaryRow[];
  return new Map(rows.map((row) => [ownerColumn === "field_id" ? row.field_id! : row.document_template_id!, mapSummary(row)]));
};

export const loadFieldNumberSeries = (fieldIds: readonly string[]): Promise<Map<string, NumberSeriesSummary>> =>
  loadSummaries("field_id", fieldIds);

export const loadDocumentNumberSeries = (templateIds: readonly string[]): Promise<Map<string, NumberSeriesSummary>> =>
  loadSummaries("document_template_id", templateIds);

export const allocateNumberInTransaction = async (params: {
  client: SqlClient;
  owner: { kind: "field" | "document_template"; id: string };
  now?: Date;
  dateConfig?: DateContext;
  renderDocument?: (value: number, seriesShortId: string) => string;
  expectedAssignment?: NumberSeriesAssignment;
}): Promise<NumberSeriesAllocation> => {
  const [series] = await params.client<SeriesRow[]>`
    SELECT id::text, short_id, assignment, current_version, baseline_floor, archived_at
    FROM grids.number_series
    WHERE ${ownerPredicate(params.owner)}
  `;
  if (!series || series.archived_at !== null) throw new Error("active number series is missing");
  const expectedAssignment = params.expectedAssignment ?? "creation";
  if (series.assignment !== expectedAssignment) {
    throw new Error(
      expectedAssignment === "creation"
        ? "number series is reserved for record finalization"
        : "number series is assigned on record creation",
    );
  }
  const [format] = await params.client<VersionRow[]>`
    SELECT version, strategy, prefix, padding, period, number_template
    FROM grids.number_series_versions
    WHERE series_id = ${series.id}::uuid AND version = ${series.current_version}
  `;
  if (!format) throw new Error("number series current format is missing");
  if (!sequentialStrategies.has(format.strategy) && !params.renderDocument) throw new Error("document number renderer is missing");

  const scope =
    format.strategy === "date_sequence" ? dateScope(params.now ?? new Date(), format.period ?? "year", params.dateConfig) : "global";
  const sequenceName = numberSeriesSequenceName(series.id, scope);
  await params.client`
    INSERT INTO grids.number_series_scopes (series_id, scope, sequence_name)
    VALUES (${series.id}::uuid, ${scope}, ${sequenceName})
    ON CONFLICT DO NOTHING
  `;
  await params.client`
    SELECT sequence_name
    FROM grids.number_series_scopes
    WHERE series_id = ${series.id}::uuid AND scope = ${scope}
    FOR UPDATE
  `;
  const [existingSequence] = await params.client<Array<{ name: string | null }>>`
    SELECT to_regclass(${`grids.${sequenceName}`})::text AS name
  `;
  if (!existingSequence?.name) {
    await params.client.unsafe(`CREATE SEQUENCE grids.${sequenceName} AS BIGINT INCREMENT 1 MINVALUE 1`);
    const baselineFloor = Number(series.baseline_floor);
    if (baselineFloor > 0) await params.client.unsafe(`SELECT setval('grids.${sequenceName}', $1, true)`, [baselineFloor]);
  }
  const rows = await params.client.unsafe(`SELECT nextval('grids.${sequenceName}') AS next`);
  const value = Number((rows as Array<{ next: bigint | number | string }>)[0]?.next);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("number series exhausted JavaScript safe integers");
  const renderedValue = params.renderDocument ? params.renderDocument(value, series.short_id) : renderedFieldValue(format, scope, value);
  const allocationId = Bun.randomUUIDv7();
  await params.client`
    INSERT INTO grids.number_allocations (id, series_id, version, scope, value, rendered_value)
    VALUES (${allocationId}::uuid, ${series.id}::uuid, ${format.version}, ${scope}, ${value}, ${renderedValue})
  `;
  return {
    id: allocationId,
    seriesId: series.id,
    seriesShortId: series.short_id,
    version: format.version,
    scope,
    value,
    renderedValue,
  };
};

export const allocateNumber = (params: {
  owner: { kind: "field" | "document_template"; id: string };
  now?: Date;
  dateConfig?: DateContext;
  renderDocument?: (value: number, seriesShortId: string) => string;
}): Promise<NumberSeriesAllocation> => getAllocationPool().begin((client) => allocateNumberInTransaction({ ...params, client }));

export const bindNumberAllocation = async (
  client: SqlClient,
  allocationId: string,
  consumer: { kind: "record" | "document"; id: string },
): Promise<void> => {
  await client`
    UPDATE grids.number_allocations
    SET consumer_kind = ${consumer.kind}, consumer_id = ${consumer.id}::uuid
    WHERE id = ${allocationId}::uuid AND consumer_id IS NULL
  `;
};

export const bindFieldNumberAllocations = async (
  client: SqlClient,
  recordId: string,
  values: ReadonlyArray<{ fieldId: string; renderedValue: string }>,
): Promise<void> => {
  for (const value of values) {
    await client`
      UPDATE grids.number_allocations allocation
      SET consumer_kind = 'record', consumer_id = ${recordId}::uuid
      FROM grids.number_series series
      WHERE allocation.series_id = series.id
        AND series.field_id = ${value.fieldId}::uuid
        AND allocation.rendered_value = ${value.renderedValue}
        AND allocation.consumer_id IS NULL
    `;
  }
};
