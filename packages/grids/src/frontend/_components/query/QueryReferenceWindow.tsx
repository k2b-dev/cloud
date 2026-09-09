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
  useLocale,
} from "@k2b/ui";
import type { HelpDocumentManifest } from "@k2b/cloud/shared";
import { createMemo, For, type JSX, Show } from "solid-js";
import type { PublicField as Field, PublicTable as Table, PublicView as View } from "../../../api/public-dto";
import { GRID_FORMULA_FUNCTIONS } from "../../../formula/function-catalog";
import { GQL_EXAMPLES } from "../../../help/gql-examples";
import { formatIdentifierRef } from "../../../ref-syntax";
import { fieldTypeIcon, fieldTypeLabel } from "../fields/field-type-meta";
import GridsEmbeddedHelp from "./GridsEmbeddedHelp.island";
import { type QueryMessages, queryMessages } from "./messages";

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

const referenceTabs = (t: QueryMessages): Array<{ value: GqlReferenceTab; label: string; icon: string; description: string }> => [
  { value: "basics", label: t.basicsTab, icon: "ti-layout-grid", description: t.basicsTabDescription },
  { value: "datatypes", label: t.datatypesTab, icon: "ti-table", description: t.datatypesTabDescription },
  { value: "tables", label: t.tablesTab, icon: "ti-database", description: t.tablesTabDescription },
  { value: "formulas", label: t.formulasTab, icon: "ti-function", description: t.formulasTabDescription },
  { value: "gql", label: t.gqlTab, icon: "ti-code", description: t.gqlTabDescription },
  { value: "examples", label: t.examplesTab, icon: "ti-copy", description: t.examplesTabDescription },
  { value: "how-it-works", label: t.howItWorksTab, icon: "ti-shield-check", description: t.howItWorksTabDescription },
  { value: "templates", label: t.templatesTab, icon: "ti-file-type-pdf", description: t.templatesTabDescription },
  { value: "workflows", label: t.workflowsTab, icon: "ti-route", description: t.workflowsTabDescription },
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

const GqlAssistantFiles = (props: { baseId: string }) => {
  const { t } = queryMessages.resolve([useLocale()()]);
  return (
    <Doc>
      <DocSection title={t.assistantFiles}>
        <div class="paper flex flex-wrap items-center justify-between gap-3 p-4">
          <div class="min-w-0">
            <h3 class="font-semibold text-primary">{t.downloadAssistantContext}</h3>
            <p class="mt-1 text-sm text-dimmed">{t.assistantContextDescription}</p>
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
};

const functionColumns = (t: QueryMessages): DataTableColumn<FunctionRow>[] => [
  { id: "category", header: t.group, value: (row) => row.category },
  { id: "signature", header: t.function, value: (row) => row.signature, cellClass: "font-mono text-xs min-w-48" },
  { id: "description", header: t.whatItDoes, value: (row) => row.description, cellClass: "min-w-72" },
  { id: "returnType", header: t.returns, value: (row) => row.returnType },
  { id: "copy", header: "", value: (row) => row.name, cellClass: "w-12 text-right" },
];

const dataTypeRows = (t: QueryMessages): DataTypeRow[] => [
  {
    type: t.dataTypeLabel({ type: "Text" }),
    icon: "ti-typography",
    use: t.dataTypeUse({ type: "Text" }),
    watch: t.dataTypeWatch({ type: "Text" }),
  },
  {
    type: t.dataTypeLabel({ type: "Long text" }),
    icon: "ti-align-left",
    use: t.dataTypeUse({ type: "Long text" }),
    watch: t.dataTypeWatch({ type: "Long text" }),
  },
  {
    type: t.dataTypeLabel({ type: "Number / percent" }),
    icon: "ti-decimal",
    use: t.dataTypeUse({ type: "Number / percent" }),
    watch: t.dataTypeWatch({ type: "Number / percent" }),
  },
  {
    type: t.dataTypeLabel({ type: "Boolean" }),
    icon: "ti-toggle-left",
    use: t.dataTypeUse({ type: "Boolean" }),
    watch: t.dataTypeWatch({ type: "Boolean" }),
  },
  {
    type: t.dataTypeLabel({ type: "Date / date-time" }),
    icon: "ti-calendar",
    use: t.dataTypeUse({ type: "Date / date-time" }),
    watch: t.dataTypeWatch({ type: "Date / date-time" }),
  },
  {
    type: t.dataTypeLabel({ type: "Duration" }),
    icon: "ti-clock-hour-4",
    use: t.dataTypeUse({ type: "Duration" }),
    watch: t.dataTypeWatch({ type: "Duration" }),
  },
  {
    type: t.dataTypeLabel({ type: "Select" }),
    icon: "ti-tags",
    use: t.dataTypeUse({ type: "Select" }),
    watch: t.dataTypeWatch({ type: "Select" }),
  },
  {
    type: "JSON",
    icon: "ti-braces",
    use: t.dataTypeUse({ type: "JSON" }),
    watch: t.dataTypeWatch({ type: "JSON" }),
  },
  {
    type: t.dataTypeLabel({ type: "Relation" }),
    icon: "ti-link",
    use: t.dataTypeUse({ type: "Relation" }),
    watch: t.dataTypeWatch({ type: "Relation" }),
  },
  {
    type: t.dataTypeLabel({ type: "Lookup / rollup" }),
    icon: "ti-corner-down-right",
    use: t.dataTypeUse({ type: "Lookup / rollup" }),
    watch: t.dataTypeWatch({ type: "Lookup / rollup" }),
  },
  {
    type: t.dataTypeLabel({ type: "Formula" }),
    icon: "ti-function",
    use: t.dataTypeUse({ type: "Formula" }),
    watch: t.dataTypeWatch({ type: "Formula" }),
  },
  {
    type: t.dataTypeLabel({ type: "ID / system fields" }),
    icon: "ti-id",
    use: t.dataTypeUse({ type: "ID / system fields" }),
    watch: t.dataTypeWatch({ type: "ID / system fields" }),
  },
  {
    type: t.dataTypeLabel({ type: "File" }),
    icon: "ti-paperclip",
    use: t.dataTypeUse({ type: "File" }),
    watch: t.dataTypeWatch({ type: "File" }),
  },
];

const renderCopyCell = (value: unknown) => <CopyButton text={String(value ?? "")} size="xs" class="h-7 w-7" />;

const referenceTabHref = (baseId: string, tab: GqlReferenceTab) =>
  `/app/grids/${encodeURIComponent(baseId)}/reference/${encodeURIComponent(tab)}`;

const referenceSourceHref = (baseId: string, source: SourceRow) =>
  `/app/grids/${encodeURIComponent(baseId)}/reference/tables/${encodeURIComponent(source.publicId)}`;

function ReferenceSidebar(props: { activeTab: GqlReferenceTab; baseId: string; baseName: string }) {
  const { t } = queryMessages.resolve([useLocale()()]);
  const items = (
    <AppWorkspace.SidebarSection title={t.reference}>
      <For each={referenceTabs(t)}>
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
      <AppWorkspace.SidebarMobileTrigger label={t.gridsReference} />
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
  const { t } = queryMessages.resolve([useLocale()()]);
  return (
    <Doc>
      <DocLead>{t.datatypesLead}</DocLead>

      <DocSection title={t.dataModelLayers}>
        <DocRows
          items={[
            {
              title: t.tableKind,
              icon: "ti-table",
              text: t.dataLayerText({ layer: "Tables" }),
            },
            {
              title: t.fields,
              icon: "ti-columns",
              text: t.dataLayerText({ layer: "Fields" }),
            },
            {
              title: t.relations,
              icon: "ti-link",
              text: t.dataLayerText({ layer: "Relations" }),
            },
            {
              title: t.view,
              icon: "ti-filter",
              text: t.dataLayerText({ layer: "Views" }),
            },
          ]}
        />
      </DocSection>

      <DocSection title={t.datatypeReference}>
        <div class="grid gap-3 xl:grid-cols-2">
          <For each={dataTypeRows(t)}>
            {(row) => (
              <article class="paper p-4">
                <div class="flex items-center gap-2 font-semibold text-primary">
                  <i class={`ti ${row.icon} text-dimmed`} />
                  <span>{row.type}</span>
                </div>
                <dl class="mt-3 space-y-3 text-sm leading-relaxed">
                  <div>
                    <dt class="text-xs font-semibold uppercase tracking-wide text-dimmed">{t.useWhen}</dt>
                    <dd class="mt-1 text-primary">{row.use}</dd>
                  </div>
                  <div>
                    <dt class="text-xs font-semibold uppercase tracking-wide text-dimmed">{t.watchFor}</dt>
                    <dd class="mt-1 text-primary">{row.watch}</dd>
                  </div>
                </dl>
              </article>
            )}
          </For>
        </div>
      </DocSection>

      <DocSection title={t.viewsDisplayModes}>
        <DocRows
          items={[
            {
              title: t.tableKind,
              icon: "ti-table",
              text: t.displayModeText({ mode: "Table" }),
            },
            {
              title: t.cards,
              icon: "ti-layout-cards",
              text: t.displayModeText({ mode: "Cards" }),
            },
            {
              title: t.calendar,
              icon: "ti-calendar-event",
              text: t.displayModeText({ mode: "Calendar" }),
            },
          ]}
        />
      </DocSection>

      <DocNote title={t.keepFieldsUseful}>{t.keepFieldsUsefulText}</DocNote>
    </Doc>
  );
}

function AvailableDataTab(props: { baseId: string; sourceRows: SourceRow[]; fieldRows: FieldRow[]; inspectedSourceId?: string }) {
  const { t } = queryMessages.resolve([useLocale()()]);
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
      header: t.field,
      value: (field) => field.name,
      class: "w-[30%]",
      cellClass: "min-w-56",
    },
    { id: "type", header: t.type, value: (field) => field.typeLabel, class: "w-[14%]", cellClass: "text-dimmed" },
    {
      id: "description",
      header: t.description,
      value: fieldReason,
      class: "w-[40%]",
      cellClass: "min-w-72 leading-relaxed text-dimmed",
    },
    { id: "use", header: t.useAs, value: (field) => field.ref, class: "w-[16%]", align: "right" },
  ];

  const SourceRef = (source: SourceRow) => (
    <div class="inline-flex min-w-0 items-center gap-1.5 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-2 py-1 text-xs">
      <span class="shrink-0 text-dimmed">{t.usePrefix}</span>
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
      <DocLead>{t.sourceLead}</DocLead>

      <Show
        when={inspectedSource()}
        fallback={
          <>
            <DocSection title={t.sources}>
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
                            <Tag size="sm">{t.tableKind}</Tag>
                            <span class="text-xs text-dimmed">
                              {t.recordsCount({ count: table.recordCount })} · {t.fieldsCount({ count: table.fieldCount })}
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
                            <i class="ti ti-eye" /> {t.inspect}
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
                                    <Tag size="sm">{t.view}</Tag>
                                    <span class="text-xs text-dimmed">{t.sourceParent({ parent: view.parent ?? t.aTable })}</span>
                                  </div>
                                </div>
                                <div class="flex min-w-0 flex-wrap items-center justify-end gap-2">
                                  {SourceRef(view)}
                                  <CopyButton text={refSourceLabel(view)} class="h-8 w-8" />
                                  <ButtonLink variant="ghost" size="sm" href={referenceSourceHref(props.baseId, view)}>
                                    {t.inspect}
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
                      <Tag size="sm">{source().kind === "view" ? t.view : t.tableKind}</Tag>
                      <span class="text-sm text-dimmed">
                        {source().kind === "view" ? t.sourceParent({ parent: source().parent ?? t.aTable }) : t.baseSource}
                      </span>
                      <span class="text-sm text-dimmed">
                        {t.recordsCount({ count: source().recordCount })} · {t.fieldsCount({ count: source().fieldCount })}
                      </span>
                    </div>
                    <p class="mt-2 max-w-3xl text-sm leading-relaxed text-dimmed">{source().description || t.noDescription}</p>
                  </div>
                  <div class="flex min-w-0 flex-wrap items-center justify-end gap-2">
                    {SourceRef(source())}
                    <CopyButton text={refSourceLabel(source())} variant="secondary" size="sm" />
                  </div>
                </div>
              </div>
            </DocSection>

            <DocSection title={t.fields}>
              <DataTable
                ariaLabel={t.sourceFieldsAria({ source: source().name })}
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

            <DocNote title={t.backAllSources}>
              <a class="link" href={referenceTabHref(props.baseId, "tables")}>
                {t.showAllSources}
              </a>
            </DocNote>
          </>
        )}
      </Show>
    </Doc>
  );
}

function FormulasTab(props: { functionRows: FunctionRow[] }) {
  const { t } = queryMessages.resolve([useLocale()()]);
  return (
    <Doc>
      <DocLead>
        {t.formulaLead} <DocInlineCode>where Status = 'Open'</DocInlineCode>
      </DocLead>

      <DocSection title={t.formulaUsage}>
        <DocRows
          items={[
            {
              title: t.formulaUsageTitle({ item: "field" }),
              icon: "ti-table",
              text: t.formulaUsageText({ item: "field" }),
            },
            {
              title: t.formulaUsageTitle({ item: "column" }),
              icon: "ti-calculator",
              text: t.formulaUsageText({ item: "column" }),
            },
            {
              title: t.formulaUsageTitle({ item: "predicate" }),
              icon: "ti-filter",
              text: t.formulaUsageText({ item: "predicate" }),
            },
            {
              title: t.formulaUsageTitle({ item: "output" }),
              icon: "ti-code-plus",
              text: t.formulaUsageText({ item: "output" }),
            },
          ]}
        />
      </DocSection>

      <DocSection title={t.formulaBasics}>
        <DocRows
          items={[
            {
              title: t.formulaBasicsTitle({ item: "fields" }),
              icon: "ti-columns",
              text: (
                <>
                  {t.formulaFieldsPrefix} <DocInlineCode>"Unit price"</DocInlineCode>
                </>
              ),
            },
            {
              title: t.formulaBasicsTitle({ item: "text" }),
              icon: "ti-quote",
              text: (
                <>
                  {t.formulaTextPrefix} <DocInlineCode>'Open'</DocInlineCode>. {t.formulaTextSuffix}
                </>
              ),
            },
            {
              title: t.formulaBasicsTitle({ item: "empty" }),
              icon: "ti-circle-dashed",
              text: t.formulaBasicsText({ item: "empty" }),
            },
            {
              title: t.formulaBasicsTitle({ item: "errors" }),
              icon: "ti-alert-triangle",
              text: t.formulaBasicsText({ item: "errors" }),
            },
            {
              title: t.formulaBasicsTitle({ item: "decimal" }),
              icon: "ti-decimal",
              text: t.formulaBasicsText({ item: "decimal" }),
            },
          ]}
        />
      </DocSection>

      <DocSection title={t.commonFormulas}>
        <div class="grid gap-3 xl:grid-cols-2">
          <FormulaSnippet title={t.formulaSnippetTitle({ item: "total" })} code="price * quantity" />
          <FormulaSnippet title={t.formulaSnippetTitle({ item: "gross" })} code='"Unit price" * quantity * 1.19' />
          <FormulaSnippet title={t.formulaSnippetTitle({ item: "fallback" })} code="IFEMPTY(notes, 'No notes')" />
          <FormulaSnippet title={t.formulaSnippetTitle({ item: "conditional" })} code="IF(inStock, 'Available', 'Out of stock')" />
          <FormulaSnippet title={t.formulaSnippetTitle({ item: "due" })} code="DATEDIFF(TODAY(), dueDate, 'days')" />
          <FormulaSnippet title={t.formulaSnippetTitle({ item: "division" })} code="IFERROR(total / quantity, 0)" />
        </div>
      </DocSection>

      <DocSection title={t.fullFunctionReference}>
        <DataTable
          ariaLabel={t.gqlFunctionReference}
          rows={props.functionRows}
          columns={functionColumns(t)}
          getRowId={(row) => row.name}
          density="compact"
          class="paper max-h-[36rem] overflow-auto"
          renderCell={({ col, value, render }) => (col.id === "copy" ? renderCopyCell(value) : render(value))}
        />
      </DocSection>

      <DocNote title={t.sqlLookingValues} variant="warning">
        <DocInlineCode>status = "open"</DocInlineCode> {t.sqlLookingPrefix} <DocInlineCode>status</DocInlineCode> {t.sqlLookingMiddle}{" "}
        <DocInlineCode>open</DocInlineCode>. {t.sqlLookingSuffix} <DocInlineCode>status = 'open'</DocInlineCode>
      </DocNote>
    </Doc>
  );
}

export default function QueryReferenceWindow(props: Props) {
  const locale = useLocale();
  const { t } = queryMessages.resolve([locale()]);
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
        description: t.savedView,
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
        typeLabel: fieldTypeLabel(field.type, locale()),
        description: field.description ?? "",
        search: [table.name, field.name, formatIdentifierRef(field.name), field.type, field.description ?? ""].join(" "),
      })),
    ),
  );

  const functionRows = createMemo<FunctionRow[]>(() =>
    GRID_FORMULA_FUNCTIONS.map((fn) => {
      const category = functionCategory(fn.name, fn.returnType);
      const categoryLabel = t.functionCategoryLabel({ category });
      const description = t.functionDescription({ description: fn.description });
      const returnType = t.functionReturnType({ type: fn.returnType });
      return {
        name: fn.name,
        category: categoryLabel,
        signature: fn.signature,
        description,
        returnType,
        search: [categoryLabel, fn.name, fn.signature, description, returnType].join(" "),
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
              <DocSection title={t.forThisBase}>
                <DocCode title={t.generatedFirstTable} code={catalogExample()} language="text" copy />
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
