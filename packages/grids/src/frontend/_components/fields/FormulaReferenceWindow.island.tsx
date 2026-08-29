import { fuzzy } from "@k2b/stdlib";
import { CopyButton, DataTable, type DataTableColumn, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import type { PublicField as Field } from "../../../api/public-dto";
import { GRID_FORMULA_FUNCTIONS } from "../../../formula/function-catalog";
import { fieldTypeIcon, fieldTypeLabel } from "./field-type-meta";
import { formulaFieldRefs, formulaFieldToken } from "./formula-authoring";
import { gridsFieldMessages } from "./messages";

type RefField = ReturnType<typeof formulaFieldRefs>[number];
type FunctionCategory = "number" | "text" | "date" | "logic";
type FunctionRow = {
  kind: "function";
  fn: (typeof GRID_FORMULA_FUNCTIONS)[number];
  category: FunctionCategory;
  search: string;
};
type ReferenceItem = { kind: "field"; field: RefField; search: string } | FunctionRow;

const FUNCTION_CATEGORY_META: Record<
  FunctionCategory,
  {
    label: string;
    icon: string;
    class: string;
  }
> = {
  number: {
    label: "Number",
    icon: "ti ti-number",
    class: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200",
  },
  text: {
    label: "Text",
    icon: "ti ti-typography",
    class: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200",
  },
  date: {
    label: "Date",
    icon: "ti ti-calendar",
    class: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-200",
  },
  logic: {
    label: "Logic",
    icon: "ti ti-git-branch",
    class: "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-200",
  },
};

const FUNCTION_CATEGORY_ORDER: FunctionCategory[] = ["number", "text", "date", "logic"];

const functionCategory = (name: string): FunctionCategory => {
  if (
    ["SUM", "AVG", "MEAN", "COUNT", "MIN", "MAX", "MEDIAN", "ABS", "ROUND", "FLOOR", "CEIL", "SQRT", "POW", "MOD", "PERCENT"].includes(name)
  ) {
    return "number";
  }
  if (["TODAY", "NOW", "YEAR", "MONTH", "DAY", "DATEADD", "DATEDIFF"].includes(name)) {
    return "date";
  }
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
  ) {
    return "text";
  }
  return "logic";
};

const functionExample = (name: string): string => {
  const examples: Record<string, string> = {
    SUM: "SUM(Price, Tax)",
    AVG: "AVG(Score, Bonus)",
    MEAN: "MEAN(Score, Bonus)",
    COUNT: "COUNT(Name, '', Status)",
    MIN: "MIN(Price, Cost)",
    MAX: "MAX(Price, Cost)",
    MEDIAN: "MEDIAN(Score, Bonus)",
    ABS: "ABS(Balance)",
    ROUND: "ROUND(Total, 2)",
    FLOOR: "FLOOR(Total)",
    CEIL: "CEIL(Total)",
    SQRT: "SQRT(Area)",
    POW: "POW(Units, 2)",
    MOD: "MOD(Units, 2)",
    PERCENT: "PERCENT(Done, Total)",
    IF: "IF(Active, 'Available', 'Out')",
    IFEMPTY: "IFEMPTY(Notes, 'No notes')",
    IFERROR: "IFERROR(Total / Units, 0)",
    AND: "AND(Active, Units > 0)",
    OR: "OR(Active, Units > 0)",
    NOT: "NOT(Active)",
    ISBLANK: "ISBLANK(Notes)",
    CONTAINS: "CONTAINS(Name, 'Pro')",
    STARTSWITH: "STARTSWITH(Name, 'A')",
    ENDSWITH: "ENDSWITH(Name, 'Ltd')",
    ICONTAINS: "ICONTAINS(Name, 'pro')",
    ISTARTSWITH: "ISTARTSWITH(Name, 'a')",
    IENDSWITH: "IENDSWITH(Name, 'ltd')",
    CONCAT: "CONCAT(Name, ' - ', Price)",
    LEN: "LEN(Name)",
    LOWER: "LOWER(Name)",
    UPPER: "UPPER(Name)",
    TRIM: "TRIM(Name)",
    LEFT: "LEFT(Name, 3)",
    RIGHT: "RIGHT(Name, 3)",
    SUBSTRING: "SUBSTRING(Name, 1, 3)",
    REPLACE: "REPLACE(Name, 'old', 'new')",
    TODAY: "TODAY()",
    NOW: "NOW()",
    YEAR: "YEAR(Date)",
    MONTH: "MONTH(Date)",
    DAY: "DAY(Date)",
    DATEADD: "DATEADD(Date, 7, 'days')",
    DATEDIFF: "DATEDIFF(Date, TODAY(), 'days')",
  };
  return examples[name] ?? `${name}()`;
};

const functionCopyText = (fn: (typeof GRID_FORMULA_FUNCTIONS)[number]) => functionExample(fn.name);

export default function FormulaReferenceWindow(props: { tableName: string; fields: Field[]; currentFieldId?: string | null }) {
  const locale = useLocale();
  const t = () => gridsFieldMessages.resolve([locale()]).t;
  const categoryMeta = (category: FunctionCategory) => ({
    ...FUNCTION_CATEGORY_META[category],
    label:
      category === "number"
        ? t().numberCategory
        : category === "text"
          ? t().textCategory
          : category === "date"
            ? t().dateCategory
            : t().logicCategory,
  });
  const [query, setQuery] = createSignal("");
  const fields = createMemo(() => formulaFieldRefs(props.fields, props.currentFieldId ?? undefined));
  const fieldRows = createMemo(() => {
    const rows = fields().map((field) => ({
      kind: "field" as const,
      field,
      search: `${field.name} ${field.type} ${formulaFieldToken(field)} ${fieldTypeLabel(field.type, locale())}`,
    }));
    const q = query().trim();
    if (!q) return rows;
    return fuzzy.filter(q, rows, { key: (item) => item.search, limit: 80 }).map((hit) => hit.item);
  });
  const functionRows = createMemo(() => {
    const rows = GRID_FORMULA_FUNCTIONS.map((fn) => {
      const category = functionCategory(fn.name);
      const meta = categoryMeta(category);
      const description = t().formulaFunctionDescription({ name: fn.name, fallback: fn.description });
      return {
        kind: "function" as const,
        fn,
        category,
        search: `${meta.label} ${category} ${fn.name} ${fn.signature} ${description} ${functionExample(fn.name)}`,
      };
    }).sort(
      (a, b) =>
        FUNCTION_CATEGORY_ORDER.indexOf(a.category) - FUNCTION_CATEGORY_ORDER.indexOf(b.category) || a.fn.name.localeCompare(b.fn.name),
    );
    const q = query().trim();
    if (!q) return rows;
    return fuzzy.filter(q, rows, { key: (item) => item.search, limit: 80 }).map((hit) => hit.item);
  });
  const fieldsCount = () => fieldRows().length;
  const functionsCount = () => functionRows().length;

  const fieldColumns: DataTableColumn<Extract<ReferenceItem, { kind: "field" }>>[] = [
    {
      id: "field",
      header: t().field,
      value: (row) => row.field.name,
    },
    {
      id: "type",
      header: t().type,
      value: (row) => row.field.type,
    },
    {
      id: "ref",
      header: t().reference,
      value: (row) => formulaFieldToken(row.field),
    },
    {
      id: "copy",
      header: "",
      value: (row) => formulaFieldToken(row.field),
      headerClass: "w-12",
      cellClass: "w-12",
    },
  ];
  const functionColumns: DataTableColumn<Extract<ReferenceItem, { kind: "function" }>>[] = [
    {
      id: "category",
      header: t().type,
      value: (row) => row.category,
      headerClass: "w-28",
      cellClass: "w-28",
    },
    {
      id: "function",
      header: t().function,
      value: (row) => row.fn.name,
    },
    {
      id: "example",
      header: t().example,
      value: (row) => functionExample(row.fn.name),
    },
    {
      id: "copy",
      header: "",
      value: (row) => functionCopyText(row.fn),
      headerClass: "w-12",
      cellClass: "w-12",
    },
  ];

  return (
    <main class="flex h-screen overflow-hidden bg-[var(--ui-canvas)] p-[var(--ui-space-shell)]">
      <div class="mx-auto flex h-full min-h-0 w-full max-w-7xl flex-col gap-[var(--ui-space-section)]">
        <header class="flex flex-wrap items-start justify-between gap-[var(--ui-space-section)]">
          <div>
            <h1 class="text-2xl font-semibold tracking-normal">{t().formulaReference}</h1>
            <p class="text-sm text-dimmed">{props.tableName}</p>
          </div>
          <div class="w-full max-w-md">
            <TextInput
              aria-label={t().searchFieldsFunctions}
              value={query}
              onValueChange={setQuery}
              icon="ti ti-search"
              placeholder={t().searchFieldsFunctionsPlaceholder}
              clearable
            />
          </div>
        </header>

        <div class="grid min-h-0 flex-1 grid-cols-1 gap-[var(--ui-space-section)] lg:grid-cols-2">
          <section class="flex min-h-0 flex-col gap-2">
            <h2 class="flex items-center gap-2 text-sm font-semibold text-secondary">
              <i class="ti ti-columns" /> {t().fields} <span class="text-dimmed">{fieldsCount()}</span>
            </h2>
            <DataTable
              ariaLabel={t().formulaFields}
              rows={fieldRows()}
              columns={fieldColumns}
              getRowId={(row) => row.field.id}
              class="paper min-h-0 flex-1 overflow-auto"
              empty={t().noMatchingFields}
              renderCell={({ row, col, value }) => {
                if (col.id === "field") {
                  return (
                    <span class="flex min-w-0 items-center gap-2">
                      <i class={`${fieldTypeIcon(row.field.type)} text-sm text-dimmed`} />
                      <span class="truncate text-secondary">{row.field.name}</span>
                    </span>
                  );
                }
                if (col.id === "type") {
                  return <span class="text-dimmed">{fieldTypeLabel(row.field.type, locale())}</span>;
                }
                if (col.id === "ref") return <code class="font-mono text-primary">{String(value)}</code>;
                return <CopyButton text={String(value)} class="h-8 w-8 text-dimmed hover:text-primary" />;
              }}
            />
          </section>

          <section class="flex min-h-0 flex-col gap-2">
            <h2 class="flex items-center gap-2 text-sm font-semibold text-secondary">
              <i class="ti ti-function" /> {t().functions} <span class="text-dimmed">{functionsCount()}</span>
            </h2>
            <DataTable
              ariaLabel={t().formulaFunctions}
              rows={functionRows()}
              columns={functionColumns}
              getRowId={(row) => row.fn.name}
              class="paper min-h-0 flex-1 overflow-auto"
              empty={t().noMatchingFunctions}
              renderCell={({ row, col, value }) => {
                if (col.id === "category") {
                  const meta = categoryMeta(row.category);
                  return (
                    <span class={`chip ${meta.class}`}>
                      <i class={`${meta.icon} text-xs`} />
                      <span>{meta.label}</span>
                    </span>
                  );
                }
                if (col.id === "function") {
                  return (
                    <span class="flex min-w-0 flex-col gap-0.5">
                      <code class="truncate font-mono text-[12px] font-semibold text-primary">{row.fn.signature}</code>
                      <span class="truncate text-[11px] text-dimmed">
                        {t().formulaFunctionDescription({ name: row.fn.name, fallback: row.fn.description })}
                      </span>
                    </span>
                  );
                }
                if (col.id === "example") {
                  return (
                    <code class="block max-w-full truncate rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-2 py-1 font-mono text-[11px] text-dimmed">
                      {String(value)}
                    </code>
                  );
                }
                return <CopyButton text={String(value)} class="h-8 w-8 text-dimmed hover:text-primary" />;
              }}
            />
          </section>
        </div>
      </div>
    </main>
  );
}
