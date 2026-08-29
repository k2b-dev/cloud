import { CopyButton, NoticeCard, Placeholder, type TemplateVariable, useLocale } from "@k2b/ui";
import { createMemo, For, Show } from "solid-js";
import { documentMessages } from "../documents/messages";

type DocumentDataTreeRow = {
  id: string;
  label: string;
  path: string;
  depth: number;
  value: unknown;
  copyText: string;
  loopText?: string;
};

const liquidPathKey = (key: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);
const liquidPath = (parent: string, key: string) => `${parent}${liquidPathKey(key)}`;
const liquidValue = (path: string) => `{{ ${path} }}`;

const valueKind = (value: unknown): TemplateVariable["kind"] => {
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (value && typeof value === "object") return "object";
  return "string";
};

const inlineValue = (value: unknown, locale: string): string => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value || '\"\"';
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const t = documentMessages.resolve([locale]).t;
  if (Array.isArray(value)) return t.arrayItems({ count: value.length, formatted: new Intl.NumberFormat(locale).format(value.length) });
  if (value && typeof value === "object") {
    const count = Object.keys(value as Record<string, unknown>).length;
    return t.objectKeys({ count, formatted: new Intl.NumberFormat(locale).format(count) });
  }
  return String(value);
};

const loopSnippet = (path: string, value: unknown): string | undefined => {
  if (!Array.isArray(value)) return undefined;
  const first = value[0];
  const itemName = path === "rows" ? "row" : "item";
  if (first && typeof first === "object" && !Array.isArray(first)) {
    const firstKey = Object.keys(first as Record<string, unknown>)[0];
    const body = firstKey ? `  {{ ${itemName}${liquidPathKey(firstKey)} }}` : `  {{ ${itemName} }}`;
    return `{% for ${itemName} in ${path} %}\n${body}\n{% endfor %}`;
  }
  return `{% for ${itemName} in ${path} %}\n  {{ ${itemName} }}\n{% endfor %}`;
};

const addDataTreeRows = (rows: DocumentDataTreeRow[], value: unknown, path: string, label: string, depth: number) => {
  rows.push({ id: `${path}:${depth}`, label, path, depth, value, copyText: liquidValue(path), loopText: loopSnippet(path, value) });

  if (depth >= 4 || value === null || value === undefined || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > 0) addDataTreeRows(rows, value[0], `${path}[0]`, "[0]", depth + 1);
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    addDataTreeRows(rows, child, liquidPath(path, key), key, depth + 1);
  }
};

const dataTreeRows = (data: Record<string, unknown> | null | undefined): DocumentDataTreeRow[] => {
  if (!data) return [];
  const rows: DocumentDataTreeRow[] = [];
  for (const key of ["record", "rows", "columns", "query", "table", "app", "business", "images", "primaryImage", "document", "snapshot"]) {
    if (key in data) addDataTreeRows(rows, data[key], key, key, 0);
  }
  return rows;
};

export const templateVariablesFromData = (data: Record<string, unknown> | null | undefined): TemplateVariable[] =>
  dataTreeRows(data)
    .filter((row) => !row.path.includes("[0]"))
    .slice(0, 120)
    .map((row) => ({ name: row.path, kind: valueKind(row.value) }));

export function DocumentDataTree(props: {
  data: () => Record<string, unknown> | null;
  loading: () => boolean;
  error: () => string | null;
}) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const rows = createMemo(() => dataTreeRows(props.data()));
  return (
    <section class="min-h-0 flex-1 overflow-auto">
      <Show when={!props.loading()} fallback={<Placeholder state="loading" align="left" title={t().loadingPreviewData} />}>
        <Show
          when={props.error()}
          fallback={
            <Show when={rows().length > 0} fallback={<Placeholder align="left" description={t().choosePreviewData} />}>
              <div class="flex flex-col gap-1 p-1 text-xs">
                <For each={rows()}>
                  {(row) => (
                    <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5">
                      <div class="min-w-0" style={{ "padding-left": `${row.depth * 0.8}rem` }}>
                        <div class="flex min-w-0 items-center gap-2">
                          <span class={row.depth === 0 ? "font-semibold text-primary" : "text-secondary"}>{row.label}</span>
                          <code class="truncate text-[11px] text-dimmed">{row.path}</code>
                        </div>
                        <div class="truncate text-[11px] text-dimmed">{inlineValue(row.value, locale())}</div>
                      </div>
                      <div class="flex items-center gap-1">
                        <Show when={row.loopText}>
                          {(snippet) => <CopyButton text={snippet()} label={t().loop} variant="ghost" size="sm" />}
                        </Show>
                        <CopyButton text={row.copyText} label={t().copy} variant="ghost" size="sm" />
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          }
        >
          {(message) => (
            <NoticeCard tone="danger" icon={false} class="m-3">
              {message()}
            </NoticeCard>
          )}
        </Show>
      </Show>
    </section>
  );
}

export function RenderedDocumentSource(props: { source: () => string | null; loading: () => boolean; error: () => string | null }) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const sourceText = () => props.source() ?? "";
  return (
    <section class="relative min-h-0 flex-1 overflow-hidden">
      <Show when={!props.loading()} fallback={<Placeholder state="loading" align="left" title={t().renderingSource} />}>
        <Show
          when={props.error()}
          fallback={
            <Show when={sourceText()} fallback={<Placeholder align="left" description={t().chooseRenderedGql} />}>
              <pre class="h-full overflow-auto whitespace-pre-wrap p-3 pr-20 font-mono text-xs leading-relaxed text-secondary">
                {sourceText()}
              </pre>
              <div class="absolute right-2 top-2">
                <CopyButton text={sourceText()} label={t().copy} variant="secondary" size="sm" />
              </div>
            </Show>
          }
        >
          {(message) => (
            <NoticeCard tone="danger" icon={false} class="m-3">
              {message()}
            </NoticeCard>
          )}
        </Show>
      </Show>
    </section>
  );
}
