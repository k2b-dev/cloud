import type { CodePageField, CodePageNode, CodePageTree } from "@k2b/cloud/code";
import { codeOwnPath } from "@k2b/cloud/contracts";
import { chartTable } from "@k2b/editor/charts";
import { Button, Checkbox, DataTable, DetailPanel, LocaleProvider, NoticeCard, NumberInput, Select, TextInput } from "@k2b/ui";
import { createSignal, For } from "solid-js";

/** First SSR renderer; all data has passed Core's wire validator. No Code source runs in the browser. */
type PageProps = { tree: CodePageTree; codeId: string; csrf: string; locale: string };
export default function CodePageTreeView(props: PageProps) {
  return (
    <LocaleProvider locale={props.locale}>
      <CodePageContent {...props} />
    </LocaleProvider>
  );
}
function CodePageContent(props: { tree: CodePageTree; codeId: string; csrf: string; locale: string }) {
  const href = (path: string) => codeOwnPath(props.codeId, path);
  const field = (item: CodePageField) => {
    const common = { name: item.name, label: item.label, required: item.required };
    switch (item.type) {
      case "checkbox": {
        const [value, setValue] = createSignal(item.value === true);
        return <Checkbox {...common} value={value} onValueChange={setValue} />;
      }
      case "number": {
        const [value, setValue] = createSignal<number | null>(typeof item.value === "number" ? item.value : null);
        return <NumberInput {...common} value={value} onValueChange={setValue} />;
      }
      case "select": {
        const [value, setValue] = createSignal<string | null>(typeof item.value === "string" ? item.value : null);
        return <Select {...common} value={value} onValueChange={setValue} options={item.options ?? []} />;
      }
      default: {
        const [value, setValue] = createSignal(typeof item.value === "string" ? item.value : "");
        return (
          <TextInput
            {...common}
            type={item.type === "email" ? "email" : "text"}
            multiline={item.type === "textarea"}
            value={value}
            onValueChange={setValue}
          />
        );
      }
    }
  };
  const node = (item: CodePageNode) => {
    switch (item.kind) {
      case "Section":
        return (
          <section class="grid gap-4">
            <h2 class="text-lg font-semibold text-primary">{item.title}</h2>
            <For each={item.children}>{node}</For>
          </section>
        );
      case "Text":
        return <p class="whitespace-pre-wrap text-secondary">{item.text}</p>;
      case "Heading":
        return item.level === 4 ? (
          <h4 class="font-semibold text-primary">{item.text}</h4>
        ) : item.level === 3 ? (
          <h3 class="text-base font-semibold text-primary">{item.text}</h3>
        ) : (
          <h2 class="text-lg font-semibold text-primary">{item.text}</h2>
        );
      case "Table":
        return (
          <section class="grid gap-3">
            <h2 class="text-lg font-semibold text-primary">{item.title}</h2>
            <DataTable<(typeof item.rows)[number]>
              ariaLabel={item.title}
              rows={item.rows}
              columns={item.columns.map((column) => ({ id: column.key, header: column.label, value: (row) => row[column.key] ?? "" }))}
            />
          </section>
        );
      case "Detail":
        return (
          <DetailPanel.Section title={item.title}>
            <For each={item.items}>{(row) => <DetailPanel.Row title={row.label} trailing={String(row.value ?? "")} />}</For>
          </DetailPanel.Section>
        );
      case "Chart": {
        const table = chartTable(item.description, props.locale);
        return (
          <section class="grid gap-3">
            <h2 class="text-lg font-semibold text-primary">{item.description.title}</h2>
            {item.description.subtitle && <p class="text-secondary">{item.description.subtitle}</p>}
            <DataTable<(typeof table.rows)[number]>
              ariaLabel={item.description.title}
              rows={table.rows}
              columns={table.columns.map((column) => ({
                id: column.id,
                header: column.label,
                value: (row) => row.cells[column.id] ?? "",
                align: column.numeric ? "right" : "left",
              }))}
            />
          </section>
        );
      }
      case "Form":
        return (
          <form action={href(item.action)} method="post" class="grid gap-4">
            <h2 class="text-lg font-semibold text-primary">{item.title}</h2>
            <input type="hidden" name="_csrf" value={props.csrf} />
            <For each={item.fields}>{field}</For>
            <div>
              <Button type="submit">{item.submit}</Button>
            </div>
          </form>
        );
      case "Link":
        return (
          <a href={href(item.href)} class="text-accent underline underline-offset-2">
            {item.label}
          </a>
        );
      case "Button":
      case "Action":
        return (
          <form action={href(item.action)} method="post">
            <input type="hidden" name="_csrf" value={props.csrf} />
            <For each={Object.entries(item.values ?? {})}>{([name, value]) => <input type="hidden" name={name} value={value} />}</For>
            <Button type="submit" variant="secondary">
              {item.label}
            </Button>
          </form>
        );
      case "Notice":
        return <NoticeCard tone={item.tone} title={item.title} detail={item.text} />;
    }
  };
  return (
    <main class="mx-auto grid w-full max-w-4xl gap-6 p-4 sm:p-8" data-print-region="" data-code-page-version={props.tree.version}>
      <header>
        <h1 class="text-2xl font-semibold text-primary">{props.tree.title}</h1>
      </header>
      <For each={props.tree.children}>{node}</For>
    </main>
  );
}
