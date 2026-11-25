import { LocaleProvider } from "@k2b/ui";
import { opsCharts } from "../../_components/ops-chart";
import { fixtureArea, LONG } from "../../_components/services-fixture-area";
import { postgresQuery } from "../query";
import PostgresScreen, { type PostgresTableRow } from "./PostgresScreen";

const schemas = ["mail", "spaces", "accounts"];

const table = (schema: string, name: string, extra: Partial<PostgresTableRow> = {}): PostgresTableRow => ({
  key: `${schema}.${name}`,
  name,
  schema,
  rows: "1.204.311",
  total: "812 MB",
  heap: "604 MB",
  indexes: "208 MB",
  seqScans: "12",
  indexScans: "9.204.113",
  dead: "4.120",
  analyzed: "25.11.2026, 03:12",
  warnings: [],
  ...extra,
});

/** Postgres from invented diagnostics; `worst` adds the longest names, failed sessions and every warning. */
export const PostgresScreenFixture = (props: { search?: string; worst?: boolean; locale?: string }) => {
  const locale = props.locale ?? "de";
  const state = postgresQuery(locale, schemas).parse(new URLSearchParams(props.search ?? "")).state;
  const tables = [
    table("mail", "messages", { warnings: props.worst ? ["seq scans high", "dead tuples high"] : [] }),
    table("spaces", props.worst ? LONG : "events", { total: "1,2 GB" }),
    table("accounts", "users", { rows: "312", total: "1,1 MB", dead: "0" }),
  ];
  const charts = opsCharts(
    [
      {
        kind: "bar",
        title: "Größe nach Schema",
        data: [
          { label: "spaces", value: 1.2e9 },
          { label: "mail", value: 8.1e8 },
        ],
        unit: "bytes",
      },
      { kind: "bar", title: "Größte Tabellen", data: [{ label: "spaces.events", value: 1.2e9 }], unit: "bytes" },
      { kind: "bar", title: "Zeilen nach Schema", data: [{ label: "mail", value: 1_204_311 }], unit: "number" },
    ],
    locale,
  );
  return (
    <LocaleProvider locale={locale}>
      <PostgresScreen
        area={fixtureArea}
        schemas={schemas}
        state={state}
        ignored={null}
        cells={[
          { icon: "database", label: "Speicher", value: "2,1 GB", meta: "214 Tabellen" },
          { icon: "plug-connected", label: "Verbindungen", value: "82/100", meta: "12 aktiv", tone: "warn" },
          { icon: "lock", label: "Wartende Sperren", value: "0", meta: "Keine" },
          {
            icon: "alert-triangle",
            label: "Warnungen",
            value: props.worst ? "12" : "0",
            meta: "Keine",
            tone: props.worst ? "bad" : undefined,
          },
        ]}
        runtime={[
          { icon: "lock-x", label: "Deadlocks", value: "0", meta: "seit dem Zurücksetzen" },
          { icon: "clock", label: "Älteste Transaktion", value: "4m" },
          { icon: "clock-play", label: "Älteste aktive Abfrage", value: "2s" },
          { icon: "plug", label: "Erweiterungen", value: "4/61", meta: "installiert/verfügbar" },
        ]}
        warnings={
          props.worst
            ? [
                {
                  tone: "bad",
                  title: "Transaktion seit 4 Stunden offen",
                  text: "Eine offene Transaktion hält VACUUM auf. Tote Zeilen wachsen.",
                },
              ]
            : []
        }
        tables={tables}
        tablesTotal="214"
        charts={{ schemaSize: charts[0]!, largest: charts[1]!, schemaRows: charts[2]! }}
        sessions={{
          error: null,
          summary: "3 Sitzungen, 1 blockiert, 1 ohne Namen",
          rows: [
            {
              pid: "41203",
              state: { label: "active", status: "ok" },
              application: "mail",
              wait: "—",
              transactionAge: "2s",
              queryAge: "2s",
              query: "SELECT * FROM mail.messages WHERE …",
            },
            {
              pid: "41207",
              state: { label: "Blockiert von 41203", status: "bad" },
              application: null,
              wait: "Lock: relation",
              transactionAge: "4m",
              queryAge: "4m",
              query: props.worst ? LONG : "UPDATE mail.messages SET …",
            },
          ],
        }}
        indexes={{
          error: props.worst ? "Indizes konnten nicht gelesen werden." : null,
          summary: "2 Indizes, 12 MB ungenutzt",
          rows: [
            { key: "a", name: "messages_pkey", table: "mail.messages", kind: "Primär", size: "84 MB", scans: "9.204.113", unused: false },
            { key: "b", name: "messages_subject_idx", table: "mail.messages", kind: "Index", size: "12 MB", scans: "0", unused: true },
          ],
        }}
        extensions={{
          summary: "4 von 61 installiert",
          rows: [
            { name: "pg_trgm", installed: true, installedVersion: "1.6", defaultVersion: "1.6", comment: "text similarity measurement" },
            {
              name: "postgis",
              installed: false,
              installedVersion: "—",
              defaultVersion: "3.5.0",
              comment: props.worst ? LONG : "PostGIS geometry",
            },
          ],
        }}
      />
    </LocaleProvider>
  );
};

export default () => <PostgresScreenFixture search="schema=mail&sort=rows.desc" />;
