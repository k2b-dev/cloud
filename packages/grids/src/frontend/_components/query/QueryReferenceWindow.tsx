import {
  AppWorkspace,
  ButtonLink,
  CopyButton,
  DataTable,
  type DataTableColumn,
  DocCode,
  DocInlineCode,
  DocLead,
  DocNote,
  DocPage,
  DocRows,
  DocSection,
  Tag,
} from "@k2b/ui";
import type { HelpDocumentManifest } from "@valentinkolb/cloud/shared";
import { createMemo, For, type JSX, Show } from "solid-js";
import type { PublicField as Field, PublicTable as Table, PublicView as View } from "../../../api/public-dto";
import { GRID_FORMULA_FUNCTIONS } from "../../../formula/function-catalog";
import { GQL_EXAMPLES } from "../../../help/gql-examples";
import { formatIdentifierRef } from "../../../ref-syntax";
import { fieldTypeIcon, fieldTypeLabel } from "../fields/field-type-meta";
import GridsEmbeddedHelp from "./GridsEmbeddedHelp.island";

const TAB_ALIASES = {
  overview: "basics",
  "data-types": "datatypes",
  "available-data": "tables",
  "query-language": "gql",
  "document-templates": "templates",
  workflow: "workflows",
} as const;

type GqlReferenceTab = "basics" | "datatypes" | "tables" | "formulas" | "gql" | "templates" | "examples" | "how-it-works" | "workflows";
const QUERY_REFERENCE_TABS: readonly GqlReferenceTab[] = [
  "basics",
  "datatypes",
  "tables",
  "formulas",
  "gql",
  "examples",
  "how-it-works",
  "templates",
  "workflows",
];

export const normalizeQueryReferenceTab = (value: string | null | undefined): GqlReferenceTab | null => {
  if (!value) return null;
  if (QUERY_REFERENCE_TABS.includes(value as GqlReferenceTab)) return value as GqlReferenceTab;
  return TAB_ALIASES[value as keyof typeof TAB_ALIASES] ?? null;
};

type Props = {
  baseId: string;
  baseName: string;
  defaultTab?: GqlReferenceTab;
  inspectedSourceId?: string;
  tables: Table[];
  fieldsByTable: Record<string, Field[]>;
  viewsByTable: Record<string, View[]>;
  recordCountsByTable: Record<string, number>;
  documents: readonly HelpDocumentManifest[];
};

type SourceRow = {
  id: string;
  publicId: string;
  kind: "table" | "view";
  tableId?: string;
  parentTableId?: string;
  name: string;
  ref: string;
  parent?: string;
  description: string;
  fieldCount: number;
  recordCount: number;
  search: string;
};

type FieldRow = {
  id: string;
  tableId: string;
  table: string;
  name: string;
  ref: string;
  type: string;
  typeLabel: string;
  description: string;
  search: string;
};

type FunctionRow = {
  name: string;
  category: string;
  signature: string;
  description: string;
  returnType: string;
  search: string;
};

type DataTypeRow = {
  type: string;
  icon: string;
  use: JSX.Element;
  watch: JSX.Element;
};

const REFERENCE_TABS: Array<{ value: GqlReferenceTab; label: string; icon: string; description: string }> = [
  { value: "basics", label: "Grids basics", icon: "ti-layout-grid", description: "Overview and workflow" },
  { value: "datatypes", label: "Data & datatypes", icon: "ti-table", description: "Tables, fields, views, forms" },
  { value: "tables", label: "Tables & views", icon: "ti-database", description: "Available data in this base" },
  { value: "formulas", label: "Formulas", icon: "ti-function", description: "Fields, computed columns, predicates" },
  { value: "gql", label: "GQL reference", icon: "ti-code", description: "Syntax, clauses, limits" },
  { value: "examples", label: "GQL examples", icon: "ti-copy", description: "Copyable query patterns" },
  { value: "how-it-works", label: "How GQL works", icon: "ti-shield-check", description: "Resolution, permissions, limits" },
  { value: "templates", label: "Templates & PDFs", icon: "ti-file-type-pdf", description: "Documents, Liquid, snapshots" },
  { value: "workflows", label: "Workflows", icon: "ti-route", description: "Inputs, triggers, steps, and runs" },
];

const functionCategory = (name: string, returnType: string): string => {
  if (["SUM", "AVG", "MEAN", "COUNT", "MIN", "MAX", "MEDIAN"].includes(name)) return "Aggregate";
  if (["ABS", "ROUND", "FLOOR", "CEIL", "SQRT", "POW", "MOD", "PERCENT"].includes(name)) return "Number";
  if (["IF", "IFEMPTY", "IFERROR", "AND", "OR", "NOT", "ISBLANK"].includes(name)) return "Logic";
  if (
    [
      "CONTAINS",
      "STARTSWITH",
      "ENDSWITH",
      "ICONTAINS",
      "ISTARTSWITH",
      "IENDSWITH",
      "CONCAT",
      "LEN",
      "LOWER",
      "UPPER",
      "TRIM",
      "LEFT",
      "RIGHT",
      "SUBSTRING",
      "REPLACE",
    ].includes(name)
  )
    return "Text";
  if (["TODAY", "NOW", "YEAR", "MONTH", "DAY", "DATEADD", "DATEDIFF"].includes(name)) return "Date";
  return returnType === "number" ? "Number" : "General";
};

const firstDateField = (fields: Field[]) => fields.find((field) => field.type === "date")?.name ?? "Created at";
const firstNumberField = (fields: Field[]) =>
  fields.find((field) => field.type === "number" || field.type === "decimal" || field.type === "percent")?.name ?? "Amount";

const buildExampleForCatalog = (tables: Table[], fieldsByTable: Record<string, Field[]>): string => {
  const table = tables[0];
  if (!table) return GQL_EXAMPLES[0]?.code ?? "from table Records\nlimit 20";
  const fields = fieldsByTable[table.id] ?? [];
  const date = firstDateField(fields);
  const amount = firstNumberField(fields);
  return `from table ${formatIdentifierRef(table.name)}
select ${
    fields
      .slice(0, 3)
      .map((field) => formatIdentifierRef(field.name))
      .join(", ") || formatIdentifierRef(amount)
  }
where ${formatIdentifierRef(amount)} > 0
sort ${formatIdentifierRef(date)} desc
limit 20`;
};

const Doc = (props: { children: JSX.Element }) => <DocPage class="!mx-0 !max-w-none w-full">{props.children}</DocPage>;
const FormulaSnippet = (props: { code: string; title?: string }) => <DocCode title={props.title} code={props.code} copy />;
const assistantFileHref = (baseId: string, file: "SKILL.md" | "context.md") =>
  `/api/grids/gql/by-base/${encodeURIComponent(baseId)}/assistant/${file}`;

const GqlAssistantFiles = (props: { baseId: string }) => (
  <Doc>
    <DocSection title="AI assistant files">
      <div class="paper flex flex-wrap items-center justify-between gap-3 p-4">
        <div class="min-w-0">
          <h3 class="font-semibold text-primary">Download assistant context</h3>
          <p class="mt-1 text-sm text-dimmed">Use the skill once, then pair it with this base's permission-filtered schema context.</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <ButtonLink variant="secondary" size="sm" href={assistantFileHref(props.baseId, "SKILL.md")} download="SKILL.md">
            <i class="ti ti-download" /> SKILL.md
          </ButtonLink>
          <ButtonLink variant="secondary" size="sm" href={assistantFileHref(props.baseId, "context.md")} download="context.md">
            <i class="ti ti-download" /> context.md
          </ButtonLink>
        </div>
      </div>
    </DocSection>
  </Doc>
);

const plural = (count: number, singular: string, pluralLabel = `${singular}s`) => `${count} ${count === 1 ? singular : pluralLabel}`;

const functionColumns: DataTableColumn<FunctionRow>[] = [
  { id: "category", header: "Group", value: (row) => row.category },
  { id: "signature", header: "Function", value: (row) => row.signature, cellClass: "font-mono text-xs min-w-48" },
  { id: "description", header: "What it does", value: (row) => row.description, cellClass: "min-w-72" },
  { id: "returnType", header: "Returns", value: (row) => row.returnType },
  { id: "copy", header: "", value: (row) => row.name, cellClass: "w-12 text-right" },
];

const dataTypeRows: DataTypeRow[] = [
  {
    type: "Text",
    icon: "ti-typography",
    use: "Short names, titles, codes, email addresses, URLs, and labels.",
    watch: "Use regex templates or validation when the value must follow a format.",
  },
  {
    type: "Long text",
    icon: "ti-align-left",
    use: "Notes, instructions, descriptions, and Markdown content.",
    watch: "Do not use long text as the record label; it makes relations and detail headers hard to scan.",
  },
  {
    type: "Number / percent",
    icon: "ti-decimal",
    use: "Counts, money, measurements, percentages, progress, and calculations.",
    watch: "Number fields use decimal-safe arithmetic. Percent fields use 0–100 by default and can be configured for a 0–1 fraction scale.",
  },
  {
    type: "Boolean",
    icon: "ti-toggle-left",
    use: "Yes/no facts such as approved, active, returned, or billable.",
    watch: "An optional boolean can also be empty. Use a required field when the process needs an explicit yes or no.",
  },
  {
    type: "Date / date-time",
    icon: "ti-calendar",
    use: "Due dates, event dates, publication dates, timestamps, and calendar views.",
    watch: "Use date for whole days. Use date-time only when the exact moment matters.",
  },
  {
    type: "Duration",
    icon: "ti-clock-hour-4",
    use: "Elapsed time such as call length, work duration, or response time.",
    watch: "Durations are stored as seconds and accept seconds, MM:SS, or HH:MM:SS input.",
  },
  {
    type: "Select",
    icon: "ti-tags",
    use: "Known option lists such as status, priority, type, condition, or category labels.",
    watch: "Use relations instead when options need their own fields, permissions, forms, or history.",
  },
  {
    type: "JSON",
    icon: "ti-braces",
    use: "Structured data that does not need separate Grids fields.",
    watch: "Use normal fields when people need to search, filter, explain, or validate individual properties.",
  },
  {
    type: "Relation",
    icon: "ti-link",
    use: "Links between records: order to customer, item to location, loan to kit.",
    watch: "Set a good record label in the target table. Self-relations are useful for parent-child structures.",
  },
  {
    type: "Lookup / rollup",
    icon: "ti-corner-down-right",
    use: "Display or summarize values through a relation without copying the source field.",
    watch: "Formatting is configured on the lookup/rollup field; it does not blindly inherit source formatting.",
  },
  {
    type: "Formula",
    icon: "ti-function",
    use: "Computed values that should recalculate from other fields when a record is read.",
    watch: "Formula errors render as an error value. Use IFERROR for expected empty or divide-by-zero cases.",
  },
  {
    type: "ID / system fields",
    icon: "ti-id",
    use: "Generated identifiers plus created/updated timestamps and actors.",
    watch: "System fields are managed by Grids. Add a visible ID only when people or external systems need to refer to it.",
  },
  {
    type: "File",
    icon: "ti-paperclip",
    use: "Attachments, images, documents, and files that belong to a record.",
    watch: "Put searchable metadata in normal fields; file bytes are not the filter model.",
  },
];

const renderCopyCell = (value: unknown) => <CopyButton text={String(value ?? "")} size="xs" class="h-7 w-7" />;

const referenceTabHref = (baseId: string, tab: GqlReferenceTab) =>
  `/app/grids/${encodeURIComponent(baseId)}/reference/${encodeURIComponent(tab)}`;

const referenceSourceHref = (baseId: string, source: SourceRow) =>
  `/app/grids/${encodeURIComponent(baseId)}/reference/tables/${encodeURIComponent(source.publicId)}`;

function ReferenceSidebar(props: { activeTab: GqlReferenceTab; baseId: string; baseName: string }) {
  const items = (
    <AppWorkspace.SidebarSection title="Reference">
      <For each={REFERENCE_TABS}>
        {(tab) => (
          <AppWorkspace.SidebarItem
            href={referenceTabHref(props.baseId, tab.value)}
            navigation="document"
            active={props.activeTab === tab.value}
            title={tab.description}
          >
            <AppWorkspace.SidebarItemIcon icon={tab.icon} />
            <AppWorkspace.SidebarItemLabel>{tab.label}</AppWorkspace.SidebarItemLabel>
          </AppWorkspace.SidebarItem>
        )}
      </For>
    </AppWorkspace.SidebarSection>
  );

  return (
    <AppWorkspace.Sidebar>
      <AppWorkspace.SidebarMobileTrigger label="Grids reference" />
      <AppWorkspace.SidebarMobile>
        <AppWorkspace.SidebarMobileBody scrollPreserveKey="grids-query-reference-mobile">{items}</AppWorkspace.SidebarMobileBody>
      </AppWorkspace.SidebarMobile>
      <AppWorkspace.SidebarDesktop>
        <AppWorkspace.SidebarBody scrollPreserveKey="grids-query-reference-sidebar">{items}</AppWorkspace.SidebarBody>
      </AppWorkspace.SidebarDesktop>
    </AppWorkspace.Sidebar>
  );
}

function DataTypesTab() {
  return (
    <Doc>
      <DocLead>
        Datatypes are the foundation of a Grids base. They decide validation, display, search, filtering, formulas, relation labels, App
        blocks, and what a form can collect.
      </DocLead>

      <DocSection title="Data model layers">
        <DocRows
          items={[
            {
              title: "Tables",
              icon: "ti-table",
              text: "Use a table when records have their own lifecycle, permissions, forms, Apps, or relations.",
            },
            {
              title: "Fields",
              icon: "ti-columns",
              text: "Use a field when the value is one property of the same record. Keep names short and add descriptions for forms and detail panels.",
            },
            {
              title: "Relations",
              icon: "ti-link",
              text: "Use relations when a value points to another record. This keeps names, metadata, permissions, and history in one source table.",
            },
            {
              title: "Views",
              icon: "ti-filter",
              text: "Use views to save how records should be queried and displayed. A view never duplicates the records it shows.",
            },
          ]}
        />
      </DocSection>

      <DocSection title="Datatype reference">
        <div class="grid gap-3 xl:grid-cols-2">
          <For each={dataTypeRows}>
            {(row) => (
              <article class="paper p-4">
                <div class="flex items-center gap-2 font-semibold text-primary">
                  <i class={`ti ${row.icon} text-dimmed`} />
                  <span>{row.type}</span>
                </div>
                <dl class="mt-3 space-y-3 text-sm leading-relaxed">
                  <div>
                    <dt class="text-xs font-semibold uppercase tracking-wide text-dimmed">Use when</dt>
                    <dd class="mt-1 text-primary">{row.use}</dd>
                  </div>
                  <div>
                    <dt class="text-xs font-semibold uppercase tracking-wide text-dimmed">Watch for</dt>
                    <dd class="mt-1 text-primary">{row.watch}</dd>
                  </div>
                </dl>
              </article>
            )}
          </For>
        </div>
      </DocSection>

      <DocSection title="Views and display modes">
        <DocRows
          items={[
            {
              title: "Table",
              icon: "ti-table",
              text: "Best for dense editing, scanning many columns, and operational work.",
            },
            {
              title: "Cards",
              icon: "ti-layout-cards",
              text: "Best when a few fields, a title, and optional image should be read at a glance.",
            },
            {
              title: "Calendar",
              icon: "ti-calendar-event",
              text: "Best when one date or date-time field places each record on a calendar.",
            },
          ]}
        />
      </DocSection>

      <DocNote title="Keep fields useful">
        Prefer a few clear fields over many vague ones. Required, unique, default, index, and display-format settings should explain real
        behavior users will rely on.
      </DocNote>
    </Doc>
  );
}

function AvailableDataTab(props: { baseId: string; sourceRows: SourceRow[]; fieldRows: FieldRow[]; inspectedSourceId?: string }) {
  const inspectedSource = createMemo(() =>
    props.inspectedSourceId
      ? props.sourceRows.find((source) => source.publicId === props.inspectedSourceId || source.id.endsWith(`:${props.inspectedSourceId}`))
      : null,
  );
  const inspectedFields = createMemo(() => {
    const source = inspectedSource();
    if (!source) return [];
    const tableId = source.kind === "table" ? source.tableId : source.parentTableId;
    return props.fieldRows.filter((field) => field.tableId === tableId);
  });
  const tableSources = createMemo(() => props.sourceRows.filter((source) => source.kind === "table"));
  const viewsForTable = (table: SourceRow) =>
    props.sourceRows.filter((source) => source.kind === "view" && source.parentTableId === table.tableId);
  const fieldsForTable = (table: SourceRow) => props.fieldRows.filter((field) => field.tableId === table.tableId);
  const refSourceLabel = (source: SourceRow) => `from ${source.kind} ${source.ref}`;
  const shownFields = (table: SourceRow) => fieldsForTable(table).slice(0, 8);
  const hiddenFieldCount = (table: SourceRow) => Math.max(0, fieldsForTable(table).length - shownFields(table).length);
  const fieldReason = (field: FieldRow) => field.description || field.typeLabel;
  const fieldColumns: DataTableColumn<FieldRow>[] = [
    {
      id: "field",
      header: "Field",
      value: (field) => field.name,
      class: "w-[30%]",
      cellClass: "min-w-56",
    },
    { id: "type", header: "Type", value: (field) => field.typeLabel, class: "w-[14%]", cellClass: "text-dimmed" },
    {
      id: "description",
      header: "Description",
      value: fieldReason,
      class: "w-[40%]",
      cellClass: "min-w-72 leading-relaxed text-dimmed",
    },
    { id: "use", header: "Use as", value: (field) => field.ref, class: "w-[16%]", align: "right" },
  ];

  const SourceRef = (source: SourceRow) => (
    <div class="inline-flex min-w-0 items-center gap-1.5 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-2 py-1 text-xs">
      <span class="shrink-0 text-dimmed">use:</span>
      <code class="truncate font-mono text-primary">{refSourceLabel(source)}</code>
    </div>
  );

  const FieldChip = (field: FieldRow) => (
    <code class="inline-flex max-w-full items-center gap-1 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-1.5 py-0.5 text-[11px] text-secondary">
      <span class="truncate">{field.ref}</span>
      <span class="text-[10px] text-dimmed">{field.typeLabel}</span>
    </code>
  );

  return (
    <Doc>
      <DocLead>
        Tables and views are the data sources GQL can read. Start from the source you understand, then inspect its fields before writing
        filters, formulas, joins, or grouped reports.
      </DocLead>

      <Show
        when={inspectedSource()}
        fallback={
          <>
            <DocSection title="Sources">
              <div class="space-y-3">
                <For each={tableSources()}>
                  {(table) => (
                    <article class="paper px-4 py-3">
                      <div class="flex flex-wrap items-start justify-between gap-3">
                        <div class="min-w-0 flex-1">
                          <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <h3 class="inline-flex min-w-0 items-center gap-2 font-semibold text-primary">
                              <i class="ti ti-table text-dimmed" />
                              <span class="truncate">{table.name}</span>
                            </h3>
                            <Tag size="sm">Table</Tag>
                            <span class="text-xs text-dimmed">
                              {plural(table.recordCount, "record")} · {plural(table.fieldCount, "field")}
                            </span>
                          </div>
                          <Show when={table.description}>
                            <p class="mt-1 text-sm leading-relaxed text-dimmed">{table.description}</p>
                          </Show>
                        </div>
                        <div class="flex shrink-0 flex-wrap items-center justify-end gap-2">
                          {SourceRef(table)}
                          <CopyButton text={refSourceLabel(table)} variant="secondary" size="sm" />
                          <ButtonLink variant="secondary" size="sm" href={referenceSourceHref(props.baseId, table)}>
                            <i class="ti ti-eye" /> Inspect
                          </ButtonLink>
                        </div>
                      </div>

                      <div class="mt-3 flex flex-wrap gap-1.5">
                        <For each={shownFields(table)}>{FieldChip}</For>
                        <Show when={hiddenFieldCount(table) > 0}>
                          <Tag size="sm">+{hiddenFieldCount(table)}</Tag>
                        </Show>
                      </div>

                      <Show when={viewsForTable(table).length > 0}>
                        <div class="mt-3 space-y-2 pl-2">
                          <For each={viewsForTable(table)}>
                            {(view) => (
                              <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
                                <div class="min-w-0">
                                  <div class="flex min-w-0 flex-wrap items-center gap-2">
                                    <span class="inline-flex min-w-0 items-center gap-1.5 font-medium text-primary">
                                      <i class="ti ti-table-spark text-dimmed" />
                                      <span class="truncate">{view.name}</span>
                                    </span>
                                    <Tag size="sm">View</Tag>
                                    <span class="text-xs text-dimmed">of {view.parent}</span>
                                  </div>
                                </div>
                                <div class="flex min-w-0 flex-wrap items-center justify-end gap-2">
                                  {SourceRef(view)}
                                  <CopyButton text={refSourceLabel(view)} class="h-8 w-8" />
                                  <ButtonLink variant="ghost" size="sm" href={referenceSourceHref(props.baseId, view)}>
                                    Inspect
                                  </ButtonLink>
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </article>
                  )}
                </For>
              </div>
            </DocSection>
          </>
        }
      >
        {(source) => (
          <>
            <DocSection title={source().name}>
              <div class="paper px-4 py-3">
                <div class="flex flex-wrap items-start justify-between gap-4">
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <Tag size="sm">{source().kind === "view" ? "View" : "Table"}</Tag>
                      <span class="text-sm text-dimmed">
                        {source().kind === "view" ? `of ${source().parent ?? "a table"}` : "Base source"}
                      </span>
                      <span class="text-sm text-dimmed">
                        {plural(source().recordCount, source().kind === "view" ? "base record" : "record")} ·{" "}
                        {plural(source().fieldCount, "field")}
                      </span>
                    </div>
                    <p class="mt-2 max-w-3xl text-sm leading-relaxed text-dimmed">{source().description || "No description yet."}</p>
                  </div>
                  <div class="flex min-w-0 flex-wrap items-center justify-end gap-2">
                    {SourceRef(source())}
                    <CopyButton text={refSourceLabel(source())} variant="secondary" size="sm" />
                  </div>
                </div>
              </div>
            </DocSection>

            <DocSection title="Fields">
              <DataTable
                ariaLabel={`${source().name} fields`}
                rows={inspectedFields()}
                columns={fieldColumns}
                getRowId={(field) => field.id}
                class="paper overflow-auto"
                tableClass="min-w-[820px] table-fixed"
                verticalAlign="middle"
                hoverRows={false}
                renderCell={({ row: field, col, value, render }) => {
                  if (col.id === "field") {
                    return (
                      <span class="flex min-w-0 items-center gap-2 font-semibold text-primary">
                        <i class={`${fieldTypeIcon(field.type)} shrink-0 text-dimmed`} aria-hidden="true" />
                        <span class="truncate">{field.name}</span>
                      </span>
                    );
                  }
                  if (col.id === "use") {
                    return (
                      <span class="flex items-center justify-end gap-2">
                        <code class="inline-flex rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-2 py-1 text-xs text-primary">
                          {field.ref}
                        </code>
                        <CopyButton text={field.ref} class="h-8 w-8" />
                      </span>
                    );
                  }
                  return render(value);
                }}
              />
            </DocSection>

            <DocNote title="Back to all sources">
              <a class="link" href={referenceTabHref(props.baseId, "tables")}>
                Show all tables and views
              </a>
            </DocNote>
          </>
        )}
      </Show>
    </Doc>
  );
}

function FormulasTab(props: { functionRows: FunctionRow[] }) {
  return (
    <Doc>
      <DocLead>
        Formulas calculate values from fields in one record. They are used in formula table fields, in-place computed columns, formula
        previews, and query predicates such as <DocInlineCode>where Status = 'Open'</DocInlineCode>.
      </DocLead>

      <DocSection title="Where formulas are used">
        <DocRows
          items={[
            {
              title: "Formula fields",
              icon: "ti-table",
              text: "A saved table field. It recalculates whenever a record is read and can be shown in tables, cards, detail panels, views, and Apps.",
            },
            {
              title: "Computed columns",
              icon: "ti-calculator",
              text: "A temporary view/table column for analysis. It does not change the table schema and can be saved in URL-backed view state.",
            },
            {
              title: "Query predicates",
              icon: "ti-filter",
              text: "A condition inside GQL. The predicate filters rows on the server.",
            },
            {
              title: "Query output",
              icon: "ti-code-plus",
              text: "A computed result column written as formula(expression) as alias in GQL.",
            },
          ]}
        />
      </DocSection>

      <DocSection title="Formula basics">
        <DocRows
          items={[
            {
              title: "Fields",
              icon: "ti-columns",
              text: (
                <>
                  Reference fields by name. Quote names with spaces: <DocInlineCode>"Unit price"</DocInlineCode>.
                </>
              ),
            },
            {
              title: "Text values",
              icon: "ti-quote",
              text: (
                <>
                  Use single quotes for text values: <DocInlineCode>'Open'</DocInlineCode>. Double quotes mean a field name, not a value.
                </>
              ),
            },
            {
              title: "Empty values",
              icon: "ti-circle-dashed",
              text: "Empty input stays empty unless the formula decides otherwise. Use IFEMPTY for a fallback.",
            },
            {
              title: "Errors",
              icon: "ti-alert-triangle",
              text: "Formula errors render as an error value. Use IFERROR for expected edge cases such as division by zero.",
            },
            {
              title: "Decimal math",
              icon: "ti-decimal",
              text: "Number and decimal calculations use decimal-safe arithmetic when exact values are involved.",
            },
          ]}
        />
      </DocSection>

      <DocSection title="Common formulas">
        <div class="grid gap-3 xl:grid-cols-2">
          <FormulaSnippet title="Total" code="price * quantity" />
          <FormulaSnippet title="Gross amount" code='"Unit price" * quantity * 1.19' />
          <FormulaSnippet title="Fallback text" code="IFEMPTY(notes, 'No notes')" />
          <FormulaSnippet title="Conditional label" code="IF(inStock, 'Available', 'Out of stock')" />
          <FormulaSnippet title="Days until due" code="DATEDIFF(TODAY(), dueDate, 'days')" />
          <FormulaSnippet title="Safe division" code="IFERROR(total / quantity, 0)" />
        </div>
      </DocSection>

      <DocSection title="Full function reference">
        <DataTable
          ariaLabel="GQL function reference"
          rows={props.functionRows}
          columns={functionColumns}
          getRowId={(row) => row.name}
          density="compact"
          class="paper max-h-[36rem] overflow-auto"
          renderCell={({ col, value, render }) => (col.id === "copy" ? renderCopyCell(value) : render(value))}
        />
      </DocSection>

      <DocNote title="SQL-looking values" variant="warning">
        <DocInlineCode>status = "open"</DocInlineCode> compares the field <DocInlineCode>status</DocInlineCode> with a field named{" "}
        <DocInlineCode>open</DocInlineCode>. Write <DocInlineCode>status = 'open'</DocInlineCode> for a text value.
      </DocNote>
    </Doc>
  );
}

export default function QueryReferenceWindow(props: Props) {
  const activeTab = () => props.defaultTab ?? "basics";

  const sourceRows = createMemo<SourceRow[]>(() => {
    const tableRows = props.tables.map((table) => ({
      id: `table:${table.id}`,
      publicId: table.id,
      kind: "table" as const,
      tableId: table.id,
      name: table.name,
      ref: formatIdentifierRef(table.name),
      description: table.description ?? "",
      fieldCount: props.fieldsByTable[table.id]?.length ?? 0,
      recordCount: props.recordCountsByTable[table.id] ?? 0,
      search: [table.name, table.description ?? "", formatIdentifierRef(table.name), "table"].join(" "),
    }));
    const viewRows = props.tables.flatMap((table) =>
      (props.viewsByTable[table.id] ?? []).map((view) => ({
        id: `view:${view.id}`,
        publicId: view.id,
        kind: "view" as const,
        parentTableId: table.id,
        name: view.name,
        parent: table.name,
        ref: formatIdentifierRef(view.name),
        description: "Saved view",
        fieldCount: props.fieldsByTable[table.id]?.length ?? 0,
        recordCount: props.recordCountsByTable[table.id] ?? 0,
        search: [view.name, formatIdentifierRef(view.name), table.name, "view"].join(" "),
      })),
    );
    return [...tableRows, ...viewRows];
  });

  const fieldRows = createMemo<FieldRow[]>(() =>
    props.tables.flatMap((table) =>
      (props.fieldsByTable[table.id] ?? []).map((field) => ({
        id: field.id,
        tableId: table.id,
        table: table.name,
        name: field.name,
        ref: formatIdentifierRef(field.name),
        type: field.type,
        typeLabel: fieldTypeLabel(field.type),
        description: field.description ?? "",
        search: [table.name, field.name, formatIdentifierRef(field.name), field.type, field.description ?? ""].join(" "),
      })),
    ),
  );

  const functionRows = createMemo<FunctionRow[]>(() =>
    GRID_FORMULA_FUNCTIONS.map((fn) => {
      const category = functionCategory(fn.name, fn.returnType);
      return {
        name: fn.name,
        category,
        signature: fn.signature,
        description: fn.description,
        returnType: fn.returnType,
        search: [category, fn.name, fn.signature, fn.description, fn.returnType].join(" "),
      };
    }),
  );

  const catalogExample = createMemo(() => buildExampleForCatalog(props.tables, props.fieldsByTable));
  const helpTopic = (): string | null => {
    switch (activeTab()) {
      case "basics":
        return "grids-overview";
      case "gql":
      case "examples":
      case "how-it-works":
        return "grids-gql";
      case "templates":
        return "grids-documents-pdfs";
      case "workflows":
        return "grids-workflows";
      default:
        return null;
    }
  };
  const content = (): JSX.Element => {
    switch (activeTab()) {
      case "datatypes":
        return <DataTypesTab />;
      case "tables":
        return (
          <AvailableDataTab
            baseId={props.baseId}
            sourceRows={sourceRows()}
            fieldRows={fieldRows()}
            inspectedSourceId={props.inspectedSourceId}
          />
        );
      case "formulas":
        return <FormulasTab functionRows={functionRows()} />;
      case "examples":
        return (
          <div class="flex min-h-0 flex-1 flex-col overflow-auto">
            <Doc>
              <DocSection title="For this base">
                <DocCode title="Generated from the first table" code={catalogExample()} language="text" copy />
              </DocSection>
            </Doc>
            <GridsEmbeddedHelp documents={props.documents.filter((document) => document.id === "grids-gql")} initialTopic="grids-gql" />
          </div>
        );
      case "gql":
        return (
          <div class="flex min-h-0 flex-1 flex-col overflow-auto">
            <GqlAssistantFiles baseId={props.baseId} />
            <GridsEmbeddedHelp documents={props.documents.filter((document) => document.id === "grids-gql")} initialTopic="grids-gql" />
          </div>
        );
      case "templates":
      case "how-it-works":
      case "workflows":
      case "basics":
      default:
        return (
          <GridsEmbeddedHelp
            documents={props.documents.filter((document) => document.id === helpTopic())}
            initialTopic={helpTopic() ?? undefined}
          />
        );
    }
  };

  return (
    <AppWorkspace class="h-screen">
      <ReferenceSidebar activeTab={activeTab()} baseId={props.baseId} baseName={props.baseName} />
      <AppWorkspace.Content>
        <AppWorkspace.Main class="p-[var(--ui-space-shell)]" scroll={false}>
          <div class="flex min-h-0 flex-1 flex-col overflow-auto">{content()}</div>
        </AppWorkspace.Main>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
