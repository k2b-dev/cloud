import { formatDateTime } from "@k2b/cloud/shared";
import type { DateContext } from "@k2b/stdlib";
import { ButtonLink, DataTable, useLocale } from "@k2b/ui";
import type { UnusedCodeDatabase } from "../../../code/database-retention";
import { codeAreaHref } from "./area";
import CodeDatabaseControls from "./CodeDatabaseControls";
import { codeAdminMessages } from "./messages";

/** Row details keep owner, measurements and access reachable on a phone. */
export default function CodeUnusedDatabases(props: { rows: UnusedCodeDatabase[]; dateConfig: DateContext }) {
  const locale = useLocale();
  const t = () => codeAdminMessages.resolve([locale()]).t;
  const when = (date: string) => formatDateTime(date, props.dateConfig);
  return (
    <DataTable
      ariaLabel={t().unusedDatabases}
      rows={props.rows}
      getRowId={(row) => row.codeId}
      hoverRows={false}
      cellContentClass="whitespace-normal"
      columns={[
        { id: "code", header: t().code },
        { id: "owner", header: t().owner, priority: 3 },
        { id: "size", header: t().databaseSize, priority: 3 },
        { id: "since", header: t().unusedSince, priority: 3 },
        { id: "access", header: t().lastAccess, priority: 3 },
        { id: "actions", header: "" },
      ]}
      renderCell={({ row, col }) =>
        col.id === "code" ? (
          <span class="grid min-w-0 gap-2">
            <ButtonLink variant="ghost" size="sm" class="whitespace-normal text-left" href={codeAreaHref({ sec: "code", id: row.codeId })}>
              {row.title}
            </ButtonLink>
            <span class="text-xs text-(--k2b-text-muted)">
              {t().deleteAt}: {row.deleteAt ? when(row.deleteAt) : t().deletionOff}
            </span>
          </span>
        ) : col.id === "owner" ? (
          row.owner
        ) : col.id === "size" ? (
          row.bytes === null ? (
            "—"
          ) : (
            `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 2 }).format(row.bytes / 1048576)} MB`
          )
        ) : col.id === "since" ? (
          when(row.since)
        ) : col.id === "access" ? (
          row.lastAccess ? (
            when(row.lastAccess)
          ) : (
            "—"
          )
        ) : (
          <CodeDatabaseControls
            codeId={row.codeId}
            database={{
              bytes: row.bytes,
              limit: 0,
              state: "ready",
              canExport: true,
              unused: { since: row.since, deleteAt: row.deleteAt, namespace: row.namespace, canDelete: true },
            }}
            actionsOnly
          />
        )
      }
    />
  );
}
