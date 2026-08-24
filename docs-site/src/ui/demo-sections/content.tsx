import {
  Button,
  Chart,
  CodeDisplay,
  DataTable,
  type DataTableColumn,
  DocCode,
  DocConceptGrid,
  DocLead,
  DocNote,
  DocPage,
  DocRows,
  DocSection,
  FileBrowserPanel,
  type FileSource,
  FilterChip,
  Format,
  Lightbox,
  LocaleProvider,
  LogEntriesTable,
  MarkdownEditor,
  MarkdownView,
  Pagination,
  PdfPreview,
  RangePicker,
  StatusBadge,
  StructuredDataPreview,
  TemplateEditor,
  TemplatePreview,
  TemplateSampleData,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import { DemoCard } from "../DemoCard";
import { PaginationDemo } from "./layout";
import { CalendarDemo } from "./surfaces";
import { DemoGrid, type DemoSection } from "./types";

const ChartDemo = () => (
  <DemoCard
    id="charts"
    chip={{ kind: "component", name: "Chart", from: "@k2b/ui" }}
    description="Typed SSR charts with bounded line inspection, map pan and zoom, and state-timeline navigation. The wrapper is a plain block, so the caller owns the height — except for stateTimeline, which derives its own from the row count."
    code={`<RangePicker value="24h" options={rangeOptions} />
<Chart kind="line" style={{ height: "14rem" }} series={series} legend smooth interactive />
<Chart kind="map" style={{ height: "14rem" }} series={locations} interactive />
<Chart kind="stateTimeline" rows={rows} states={states} domain={[0, 10]} interactive />`}
  >
    <RangePicker
      value="24h"
      options={[
        { value: "1h", href: "?window=1h" },
        { value: "24h", href: "?window=24h" },
      ]}
    />
    <div class="ui-chart-demo">
      <Chart
        kind="line"
        style={{ height: "14rem" }}
        series={[
          {
            label: "Requests",
            data: [
              { x: 1, y: 12 },
              { x: 2, y: 28 },
              { x: 3, y: 24 },
              { x: 4, y: 42 },
            ],
          },
        ]}
        legend
        smooth
        interactive
      />
      <Chart
        kind="map"
        style={{ height: "14rem" }}
        series={[
          {
            label: "Requests",
            data: [
              { latitude: 52.52, longitude: 13.405, label: "Berlin" },
              { latitude: 48.137, longitude: 11.575, label: "Munich" },
            ],
          },
        ]}
        interactive
      />
      <Chart
        kind="stateTimeline"
        rows={[
          {
            label: "Worker",
            intervals: [
              { from: 0, to: 4, state: "ok", tooltip: "Succeeded" },
              { from: 5, to: 8, state: "running", tooltip: "Running" },
            ],
          },
        ]}
        states={[
          { state: "ok", label: "Healthy", color: "#10b981" },
          { state: "running", label: "Running", color: "#3b82f6" },
        ]}
        domain={[0, 10]}
        interactive
      />
    </div>
  </DemoCard>
);

type Row = { id: string; name: string; owner: string; requests: number };
const rows: Row[] = [
  { id: "api", name: "Public API", owner: "Platform", requests: 18492 },
  { id: "docs", name: "Documentation", owner: "Design systems", requests: 3274 },
];
const columns: DataTableColumn<Row>[] = [
  { id: "name", header: ({ col }) => `Name (${col.id})`, value: "name", sortable: true },
  { id: "owner", header: "Owner", value: "owner" },
  { id: "requests", header: "Requests", value: "requests", align: "right" },
];
const TableDemo = () => (
  <DemoCard
    id="tables"
    chip={[
      { kind: "component", name: "DataTable", from: "@k2b/ui" },
      { kind: "component", name: "Pagination", from: "@k2b/ui" },
    ]}
    description="The basic form renders exact typed records. Sorting, selection, totals, and pagination stay application-owned."
    code={`<DataTable
  rows={rows}
  columns={columns}
  getRowId={(row) => row.id}
  selectedRowId="api"
  sort={{ key: "name", direction: "asc" }}
  renderCell={({ col, value, render }) => col.id === "name" ? <strong>{value}</strong> : render(value)}
  sortHref={(sort) => \`?sort=\${sort.key}&direction=\${sort.direction}\`}
  footer={{ values: { name: "Total", requests: 21_766 } }}
/>
<Pagination currentPage={2} totalPages={6} baseUrl="?page=" />`}
  >
    <DataTable
      rows={rows}
      columns={columns}
      getRowId={(row) => row.id}
      selectedRowId="api"
      sort={{ key: "name", direction: "asc" }}
      sortHref={(sort) => `?sort=${sort.key}&direction=${sort.direction}`}
      renderHeader={({ render }) => render()}
      renderCell={({ col, value, render }) => (col.id === "name" ? <strong>{String(value)}</strong> : render(value))}
      footer={{ values: { name: "Total", requests: 21766 } }}
      scrollPreserveKey="content-demo-table"
    />
    <Pagination currentPage={2} totalPages={6} baseUrl="?page=" />
  </DemoCard>
);

type OrderRow = {
  id: string;
  customer: string;
  status: "new" | "shipped" | "delivered";
  items: number;
  total: number;
};

const orderRows: OrderRow[] = [
  { id: "ord-1", customer: "Alice Becker", status: "delivered", items: 3, total: 129.9 },
  { id: "ord-2", customer: "Bob Schmidt", status: "shipped", items: 1, total: 42.5 },
  { id: "ord-3", customer: "Cara Müller", status: "new", items: 5, total: 219.99 },
];

const orderColumns: DataTableColumn<OrderRow>[] = [
  { id: "customer", header: "Customer", value: "customer" },
  { id: "status", header: "Status", value: "status" },
  { id: "items", header: "Items", value: "items", align: "right" },
  { id: "total", header: "Total", value: "total", align: "right" },
  { id: "actions", header: "Settings", align: "right" },
];

const orderStatus = {
  new: { label: "New", tone: "running" },
  shipped: { label: "Shipped", tone: "warning" },
  delivered: { label: "Delivered", tone: "ok" },
} as const;

const ProfessionalTableDemo = () => {
  const [query, setQuery] = createSignal("");
  const [statuses, setStatuses] = createSignal<string[]>([]);
  const filteredRows = createMemo(() => {
    const normalizedQuery = query().trim().toLowerCase();
    const selectedStatuses = new Set(statuses());
    return orderRows.filter(
      (row) =>
        (normalizedQuery.length === 0 || row.customer.toLowerCase().includes(normalizedQuery)) &&
        (selectedStatuses.size === 0 || selectedStatuses.has(row.status)),
    );
  });
  const totals = createMemo(() =>
    filteredRows().reduce((result, row) => ({ items: result.items + row.items, total: result.total + row.total }), { items: 0, total: 0 }),
  );

  return (
    <DemoCard
      id="tables-professional"
      chip={[
        { kind: "component", name: "DataTable", from: "@k2b/ui" },
        { kind: "component", name: "FilterChip", from: "@k2b/ui" },
        { kind: "component", name: "TextInput", from: "@k2b/ui" },
      ]}
      description="The professional composition adds a labelled panel, actions, search, filters, and pagination without moving data ownership into the component."
      code={`const [query, setQuery] = createSignal("");

<DataTable.Panel>
  <DataTable.Header title="Orders" subtitle={\`\${filteredRows().length} of \${total} rows\`}>
    <Button size="sm" variant="subtle"><i class="ti ti-settings" />Settings</Button>
  </DataTable.Header>

  <DataTable.Controls>
    <TextInput aria-label="Search orders" value={query()} onValueChange={setQuery} icon="ti ti-search" placeholder="Search orders..." clearable />
    <FilterChip label="Status" icon="ti ti-filter" value={statuses()} onValueChange={setStatuses} options={statusOptions} />
  </DataTable.Controls>

  <DataTable
    rows={filteredRows()}
    columns={columns}
    getRowId={(row) => row.id}
    footer={{ values: { customer: "Total", items: totals().items, total: totals().total } }}
    renderCell={({ row, col, value, render }) => {
      if (col.id === "status") {
        const status = orderStatus[row.status];
        return <StatusBadge label={status.label} tone={status.tone} icon={null} />;
      }
      if (col.id === "actions") return <Button size="sm" variant="subtle">Open</Button>;
      return col.id === "total" ? formatCurrency(value) : render(value);
    }}
  />

  <DataTable.Footer>
    <Pagination currentPage={1} totalPages={6} baseUrl="?page=" />
  </DataTable.Footer>
</DataTable.Panel>`}
    >
      <DataTable.Panel>
        <DataTable.Header title="Orders" subtitle={`${filteredRows().length} of ${orderRows.length} rows`}>
          <Button size="sm" variant="subtle">
            <i class="ti ti-settings" aria-hidden="true" /> Settings
          </Button>
        </DataTable.Header>
        <DataTable.Controls>
          <TextInput
            aria-label="Search orders"
            value={query()}
            onValueChange={setQuery}
            icon="ti ti-search"
            placeholder="Search orders..."
            clearable
          />
          <div class="ui-demo-row">
            <FilterChip
              label="Status"
              icon="ti ti-filter"
              value={statuses()}
              onValueChange={setStatuses}
              options={[
                {
                  multiple: true,
                  options: [
                    { value: "new", label: "New", color: "#3b82f6" },
                    { value: "shipped", label: "Shipped", color: "#f59e0b" },
                    { value: "delivered", label: "Delivered", color: "#10b981" },
                  ],
                },
              ]}
            />
          </div>
        </DataTable.Controls>
        <DataTable
          rows={filteredRows()}
          columns={orderColumns}
          getRowId={(row) => row.id}
          footer={{
            values: {
              customer: "Total",
              items: totals().items,
              total: totals().total,
            },
            renderCell: ({ col, value, render }) => {
              if (col.id === "status" || col.id === "actions") return null;
              if (col.id === "total") return `€${Number(value).toFixed(2)}`;
              return render(value);
            },
          }}
          renderCell={({ row, col, value, render }) => {
            if (col.id === "customer") return <strong>{row.customer}</strong>;
            if (col.id === "status") {
              const status = orderStatus[row.status];
              return <StatusBadge label={status.label} tone={status.tone} icon={null} />;
            }
            if (col.id === "total") return `€${Number(value).toFixed(2)}`;
            if (col.id === "actions") {
              return (
                <Button size="sm" variant="subtle">
                  Open
                </Button>
              );
            }
            return render(value);
          }}
        />
        <DataTable.Footer>
          <Pagination currentPage={1} totalPages={6} baseUrl="?page=" />
        </DataTable.Footer>
      </DataTable.Panel>
    </DemoCard>
  );
};

const CodeDemo = () => (
  <DemoCard
    id="code"
    chip={{ kind: "component", name: "CodeDisplay", from: "@k2b/ui" }}
    description="Selectable source with quiet chrome, optional titles, copy, and exact language modes."
    code={`<CodeDisplay title="Install" language="script" code="bun add @k2b/ui" />
<CodeDisplay title="component.tsx" language="tsx" code={componentSource} />`}
  >
    <CodeDisplay title="Install" language="script" code={"bun add @k2b/ui\nbun run build"} />
    <CodeDisplay title="component.tsx" language="tsx" code={'export const Status = () => <span data-ready="true">Ready</span>;'} />
  </DemoCard>
);

const LogsDemo = () => (
  <DemoCard
    id="logs"
    chip={{ kind: "component", name: "LogEntriesTable", from: "@k2b/ui" }}
    description="Timestamped log entries with semantic levels, sources, messages, and optional structured metadata."
    code={`<LogEntriesTable entries={entries} />`}
  >
    <LogEntriesTable
      entries={[
        {
          id: 1,
          level: "info",
          source: "build",
          message: "Package compiled",
          metadata: null,
          createdAt: "2026-07-28T09:42:00Z",
        },
        {
          id: 2,
          level: "warn",
          source: "preview",
          message: "One optional font was not loaded",
          metadata: { font: "IBM Plex Mono" },
          createdAt: "2026-07-28T09:43:00Z",
        },
      ]}
    />
  </DemoCard>
);

const StructuredDemo = () => (
  <DemoCard
    id="structured-data"
    chip={{ kind: "component", name: "StructuredDataPreview", from: "@k2b/ui" }}
    description="Formatted and raw disclosure for unknown JSON-like values with bounded rows and copy."
    code={`<StructuredDataPreview title="Response" data={payload} maxRows={8} />`}
  >
    <StructuredDataPreview title="Response" data={{ status: "ready", counts: { pages: 52, sections: 9 }, portable: true }} maxRows={8} />
  </DemoCard>
);

const gallery = [
  {
    src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='960' height='540'%3E%3Crect width='960' height='540' fill='%2306b6d4'/%3E%3C/svg%3E",
    alt: "Cyan field",
  },
  {
    src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='960' height='540'%3E%3Crect width='960' height='540' fill='%238b5cf6'/%3E%3C/svg%3E",
    alt: "Purple field",
  },
];
const MediaDemo = () => {
  const [open, setOpen] = createSignal(false);
  return (
    <DemoCard
      id="media"
      chip={[
        { kind: "component", name: "Lightbox", from: "@k2b/ui" },
        { kind: "component", name: "PdfPreview", from: "@k2b/ui" },
      ]}
      description="Application-owned media in a native image dialog and an explicitly requested local PDF preview."
      code={`const [open, setOpen] = createSignal(false);

<Button variant="secondary" onClick={() => setOpen(true)}>Open gallery</Button>
<Show when={open()}>
  <Lightbox images={images} initialIndex={0} onClose={() => setOpen(false)} />
</Show>
<PdfPreview request={() => Promise.resolve(pdfBlob)} title="Report" emptyText="Generate the report to inspect it." />`}
    >
      <div class="ui-demo-row">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Open gallery
        </Button>
      </div>
      <Show when={open()}>
        <Lightbox images={gallery} initialIndex={0} onClose={() => setOpen(false)} />
      </Show>
      <div class="ui-pdf-demo">
        <PdfPreview
          request={async () => new Blob(["%PDF-1.4\n%%EOF"], { type: "application/pdf" })}
          title="Sample report"
          emptyText="Generate the local sample to inspect it."
        />
      </div>
    </DemoCard>
  );
};

type DemoFile = {
  encoding: "utf8" | "base64";
  content: string;
  mediaType: string;
};

const initialFileContent: Record<string, DemoFile> = {
  "/src/app.tsx": {
    encoding: "utf8",
    content: 'export const App = () => <main class="k2b-ui">Portable</main>;',
    mediaType: "text/typescript",
  },
  "/README.md": {
    encoding: "utf8",
    content: "# Portable files\n\nThe application owns this in-memory source.",
    mediaType: "text/markdown",
  },
};

const demoMediaType = (path: string): string => {
  if (path.endsWith(".md") || path.endsWith(".markdown")) return "text/markdown";
  if (path.endsWith(".tsx") || path.endsWith(".ts")) return "text/typescript";
  if (path.endsWith(".json")) return "application/json";
  return "text/plain";
};

const FilesDemo = () => {
  const [files, setFiles] = createSignal<Record<string, DemoFile>>({ ...initialFileContent });
  const fileSource: FileSource = {
    list: async () =>
      Object.entries(files()).map(([path, file]) => ({
        path,
        mediaType: file.mediaType,
        size: file.encoding === "utf8" ? new TextEncoder().encode(file.content).byteLength : file.content.length,
      })),
    read: async (path) => {
      const file = files()[path];
      if (!file) throw new Error(`File not found: ${path}`);
      return file;
    },
    write: async (path, content, encoding = "utf8") => {
      setFiles((current) => ({
        ...current,
        [path]: {
          encoding,
          content,
          mediaType: current[path]?.mediaType ?? demoMediaType(path),
        },
      }));
    },
    remove: async (path) => {
      setFiles((current) =>
        Object.fromEntries(Object.entries(current).filter(([candidate]) => candidate !== path && !candidate.startsWith(`${path}/`))),
      );
    },
    rename: async (from, to) => {
      setFiles((current) => {
        const file = current[from];
        if (!file) throw new Error(`File not found: ${from}`);
        if (current[to]) throw new Error(`File already exists: ${to}`);
        const next = { ...current, [to]: file };
        delete next[from];
        return next;
      });
    },
    upload: async (dirPath, selectedFiles) => {
      const additions: Record<string, DemoFile> = {};
      for (const file of selectedFiles) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.addEventListener("load", () => resolve(String(reader.result)));
          reader.addEventListener("error", () => reject(reader.error ?? new Error(`Failed to read ${file.name}`)));
          reader.readAsDataURL(file);
        });
        const path = `${dirPath === "/" ? "" : dirPath}/${file.name}`;
        additions[path] = {
          encoding: "base64",
          content: dataUrl.slice(dataUrl.indexOf(",") + 1),
          mediaType: file.type || "application/octet-stream",
        };
      }
      setFiles((current) => ({ ...current, ...additions }));
    },
  };

  return (
    <DemoCard
      id="files"
      chip={[
        { kind: "component", name: "FileBrowserPanel", from: "@k2b/ui" },
        { kind: "component", name: "FileTree", from: "@k2b/ui" },
        { kind: "component", name: "FileView", from: "@k2b/ui" },
      ]}
      description="A fully interactive, path-first browser over an application-owned in-memory source. Create, upload, rename, move, delete, edit, save, and download without a backend."
      code={`const source: FileSource = {
  list: async () => entries,
  read: async (path) => content[path],
  write: async (path, value) => update(path, value),
  rename: async (from, to) => move(from, to),
  remove: async (path) => remove(path),
  upload: async (dir, files) => upload(dir, files),
};

<FileBrowserPanel source={source} initialPath="/README.md" />`}
    >
      {/* No showcase wrapper: FileBrowserPanel sizes itself when it is not given
          a `class`, so any sizing failure has to stay visible here. */}
      <FileBrowserPanel source={fileSource} initialPath="/README.md" />
    </DemoCard>
  );
};

const interpolatePreviewTokens = (template: string, values: Readonly<Record<string, string>>): string =>
  Object.entries(values).reduce((preview, [key, replacement]) => preview.replaceAll(`{{ ${key} }}`, replacement), template);

const TemplateDemo = () => {
  const variables = [
    { name: "PROJECT", kind: "string" as const },
    { name: "OWNER", kind: "string" as const },
  ];
  const [value, setValue] = createSignal("<h1>{{ PROJECT }}</h1><p>Owner: {{ OWNER }}</p>");
  const [sample, setSample] = createSignal<Record<string, string>>({ PROJECT: "Atlas", OWNER: "Team" });
  const html = createMemo(() => `<style>body{font:16px sans-serif;padding:24px}</style>${interpolatePreviewTokens(value(), sample())}`);
  return (
    <DemoCard
      id="template-editor"
      chip={[
        { kind: "component", name: "TemplateEditor", from: "@k2b/ui" },
        { kind: "component", name: "TemplatePreview", from: "@k2b/ui" },
        { kind: "component", name: "TemplateSampleData", from: "@k2b/ui" },
      ]}
      description="Portable HTML and Liquid editing with a sandboxed illustrative preview, not a Liquid renderer. Rendering policy and persistence remain application-owned."
      code={`<TemplateEditor
  aria-label="Template source"
  value={value()}
  onValueChange={setValue}
  variables={variables}
  lines={8}
/>
<TemplatePreview html={html()} />
<TemplateSampleData variables={variables} values={sample()} onValueChange={setSampleValue} />`}
    >
      <div class="ui-template-demo">
        <section class="ui-showcase-frame">
          <span>TemplateEditor</span>
          <TemplateEditor aria-label="Template source" value={value()} onValueChange={setValue} variables={variables} lines={8} />
        </section>
        <section class="ui-showcase-frame">
          <span>TemplatePreview</span>
          <TemplatePreview html={html()} />
        </section>
        <section class="ui-showcase-frame">
          <span>TemplateSampleData</span>
          <TemplateSampleData
            variables={variables}
            values={sample()}
            onValueChange={(name, next) => setSample((current) => ({ ...current, [name]: next }))}
          />
        </section>
      </div>
    </DemoCard>
  );
};

const DocsDemo = () => (
  <DemoCard
    id="docs"
    chip={[
      { kind: "component", name: "DocPage", from: "@k2b/ui" },
      { kind: "component", name: "DocSection", from: "@k2b/ui" },
    ]}
    description="Portable in-product documentation primitives for an application-owned composition."
    code={`<DocPage>
  <DocLead>…</DocLead>
  <DocConceptGrid items={concepts} />
  <DocSection title="Install" eyebrow="Package">
    <DocCode language="script" code="bun add @k2b/ui" />
    <DocNote title="Keep the scope" variant="tip">…</DocNote>
  </DocSection>
  <DocRows items={references} />
</DocPage>`}
  >
    <DocPage>
      <DocLead>Build a consistent application without importing Cloud.</DocLead>
      {/* DocConceptGrid and DocRows prefix `ti ` themselves, so items carry the
          bare icon name — unlike Widget, StatCell, or NoticeCard. */}
      <DocConceptGrid
        items={[
          { title: "Scoped", text: "No global reset.", icon: "ti-box-margin" },
          { title: "Portable", text: "Solid and SSR.", icon: "ti-package" },
        ]}
      />
      <DocSection title="Install" eyebrow="Package">
        <DocCode language="script" code="bun add @k2b/ui" />
        <DocNote title="Keep the scope" variant="tip">
          Wrap component output in <code>.k2b-ui</code>.
        </DocNote>
      </DocSection>
      <DocRows items={[{ title: "Runtime", icon: "ti-server", text: "The host owns data and routes." }]} />
    </DocPage>
  </DemoCard>
);

const MarkdownDemo = (props: { html: string }) => {
  const [value, setValue] = createSignal("# Hello @auth.name");
  return (
    <DemoCard
      id="markdown"
      chip={[
        { kind: "component", name: "MarkdownView", from: "@k2b/ui" },
        { kind: "component", name: "MarkdownEditor", from: "@k2b/ui" },
      ]}
      description="Untrusted Markdown is safe by default. Known authoring tokens can be emphasized without crossing the trusted-HTML boundary."
      code={`<MarkdownView markdown={value()} inlineTokens={["@auth.name"]} headingScale="compact" />
<MarkdownView markdown={value()} />
<MarkdownView markdown={value()} headingScale="large" />
<MarkdownView trustedHtml={trustedHtml} />
<MarkdownEditor value={value()} onValueChange={setValue} aria-label="Markdown source" />`}
    >
      <section aria-label="Rendered untrusted Markdown">
        <MarkdownView markdown={value()} inlineTokens={["@auth.name"]} headingScale="large" />
      </section>
      <section aria-label="Rendered trusted HTML">
        <MarkdownView trustedHtml={props.html} />
      </section>
      <MarkdownEditor value={value()} onValueChange={setValue} aria-label="Markdown source" />
    </DemoCard>
  );
};

const IntlValues = () => {
  const locale = useLocale();
  return (
    <div style="display:grid;gap:6px">
      <p style="margin:0">
        Effective locale: <output>{locale()}</output>
      </p>
      <p style="margin:0">
        <Format.Number value={1234567.89} decimals={2} /> · <Format.Currency value={1999.5} currency="EUR" /> ·{" "}
        <Format.Percent value={0.421} /> · <Format.Bytes value={1536} />
      </p>
      <p style="margin:0">
        <Format.DateTime value="2026-07-28T09:00:00Z" timeZone="Europe/Berlin" /> ·{" "}
        <Format.RelativeTime value="2026-07-28T09:00:00Z" base="2026-07-28T11:00:00Z" /> · <Format.DurationMs value={90_000} />
      </p>
    </div>
  );
};

const IntlDemo = () => (
  <DemoCard
    id="intl"
    chip={{ kind: "component", name: "Format", from: "@k2b/ui" }}
    description="One inherited render locale for unstyled semantic formatters. The German block wraps the same values in a LocaleProvider; date and time components take an explicit timezone and default to UTC."
    code={`<LocaleProvider locale="de">
  <Format.Currency value={1999.5} currency="EUR" />
  <Format.DateTime value={order.createdAt} timeZone="Europe/Berlin" />
  <Format.RelativeTime value={order.updatedAt} />
</LocaleProvider>`}
  >
    <IntlValues />
    <LocaleProvider locale="de">
      <IntlValues />
    </LocaleProvider>
  </DemoCard>
);

const demos: DemoSection = {
  charts: () => (
    <DemoGrid columns="one">
      <ChartDemo />
    </DemoGrid>
  ),
  tables: () => (
    <DemoGrid columns="one">
      <TableDemo />
      <ProfessionalTableDemo />
    </DemoGrid>
  ),
  calendar: () => (
    <DemoGrid columns="one">
      <CalendarDemo />
    </DemoGrid>
  ),
  pagination: () => (
    <DemoGrid columns="one">
      <PaginationDemo />
    </DemoGrid>
  ),
  code: () => (
    <DemoGrid columns="one">
      <CodeDemo />
    </DemoGrid>
  ),
  logs: () => (
    <DemoGrid columns="one">
      <LogsDemo />
    </DemoGrid>
  ),
  "structured-data": () => (
    <DemoGrid columns="one">
      <StructuredDemo />
    </DemoGrid>
  ),
  media: () => (
    <DemoGrid columns="one">
      <MediaDemo />
    </DemoGrid>
  ),
  files: () => (
    <DemoGrid columns="one">
      <FilesDemo />
    </DemoGrid>
  ),
  "template-editor": () => (
    <DemoGrid columns="one">
      <TemplateDemo />
    </DemoGrid>
  ),
  docs: () => (
    <DemoGrid columns="one">
      <DocsDemo />
    </DemoGrid>
  ),
  markdown: (props) => (
    <DemoGrid columns="one">
      <MarkdownDemo html={props.markdownHtml} />
    </DemoGrid>
  ),
  intl: () => (
    <DemoGrid columns="one">
      <IntlDemo />
    </DemoGrid>
  ),
};

export default demos;
