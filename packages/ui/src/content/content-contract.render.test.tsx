import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { dates } from "@k2b/stdlib";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { CalendarEvent } from "./Calendar";
import type { DataTableProps } from "./DataTable";
import { getFileViewPreviewKind } from "./file-view-preview";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-content-contract-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: Calendar } = await import("./Calendar");
const { default: CodeDisplay } = await import("./CodeDisplay");
const { default: DataTable } = await import("./DataTable");
const { DocCode, DocConceptGrid, DocRows } = await import("./Docs");
const { default: FileTree } = await import("./FileTree");
const { default: LogEntriesTable } = await import("./LogEntriesTable");
const { default: MarkdownView } = await import("./MarkdownView");
const { Pagination } = await import("./Pagination");
const { default: PdfPreview } = await import("./PdfPreview");
const { default: RangePicker } = await import("./RangePicker");
const { default: StructuredDataPreview } = await import("./StructuredDataPreview");
const contentCss = await Bun.file(resolve(import.meta.dir, "../styles/content-parity.css")).text();
const uiCss = await Bun.file(resolve(import.meta.dir, "../styles/index.css")).text();

describe("@k2b/ui Cloud content contract", () => {
  test("keeps the complete calendar event and view contract on the server", () => {
    const events: CalendarEvent[] = [
      {
        id: "review",
        title: "Review",
        start: "2026-07-15T09:00:00Z",
        end: "2026-07-15T10:00:00Z",
        color: "emerald",
        location: "Studio",
      },
      {
        id: "planning",
        title: "Planning",
        start: "2026-07-16T09:00:00Z",
        end: "2026-07-16T10:00:00Z",
        colorHex: "#0ea5e9",
      },
    ];
    const html = renderToString(() =>
      createComponent(Calendar, {
        date: "2026-07-15T12:00:00Z",
        events,
        view: "month",
        views: ["day", "week", "month", "year"],
        timeZone: "UTC",
        withWeekNumbers: true,
        navigationPending: true,
        getDateHref: (date, view) => `/calendar?view=${view}&date=${date.toISOString()}`,
        getViewHref: (view) => `/calendar?view=${view}`,
      }),
    );

    expect(html).toContain('aria-label="Calendar view"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/class="k2b-button k2b-calendar-header__today[^"]*"[^>]*data-size="sm"[^>]*data-variant="input"/);
    expect(html).toContain('<span class="k2b-button__label">Today</span>');
    expect(html).toContain("Review");
    expect(html).toContain("Review, 09:00 to 10:00");
    expect(html).toContain("view=day");
    expect(html).toMatch(/class="k2b-calendar-month__day-target\s*"/);
    expect(html).toContain('aria-label="Open Wednesday, July 1, 2026"');
    expect(html).not.toContain('class="k2b-calendar-month__day" role="button"');
    expect(html).toContain("--k2b-calendar-accent:#0ea5e9");
    expect(html).not.toContain("background-color:color-mix");
    expect(contentCss).toContain("--k2b-calendar-accent: #10b981");
    expect(contentCss).not.toContain("--k2b-calendar-event-text");
    expect(contentCss).toMatch(/\.k2b-calendar-event \{[^}]*border: 0;[^}]*color: var\(--k2b-text\);/s);
    expect(contentCss).toContain(
      "background: color-mix(in srgb, var(--k2b-calendar-accent, var(--k2b-text-muted)) 12%, var(--k2b-surface-elevated))",
    );
    expect(contentCss).toMatch(/\.k2b-calendar-event__title \{[^}]*font-weight: 500;/s);
    expect(contentCss).toMatch(/\.k2b-calendar-month__day-target \{[^}]*position: absolute;[^}]*inset: 0;/s);
    expect(contentCss).toMatch(/\.k2b-calendar-event__title \+ \.k2b-calendar-event__meta \{[^}]*margin-top: 0\.25rem;/s);
    const createInMonthHtml = renderToString(() =>
      createComponent(Calendar, {
        date: "2026-07-15T12:00:00Z",
        events: [],
        view: "month",
        timeZone: "UTC",
        getDateHref: (date, view) => `/calendar?view=${view}&date=${date.toISOString()}`,
        onSlotActivate: () => undefined,
      }),
    );
    expect(createInMonthHtml).toMatch(/<button[^>]*class="k2b-calendar-month__day-target\s*"/);
    expect(createInMonthHtml).toContain('aria-label="Create event on Wednesday, July 1, 2026"');
    expect(createInMonthHtml).toMatch(/class="k2b-calendar-month__day-number\s*"/);
    const shortEventHtml = renderToString(() =>
      createComponent(Calendar, {
        date: "2026-07-15T12:00:00Z",
        events: [{ id: "short", title: "Short event", start: "2026-07-15T09:00:00Z", end: "2026-07-15T09:15:00Z" }],
        view: "day",
        timeZone: "UTC",
      }),
    );
    expect(shortEventHtml).toContain('data-short="true"');
    const describedEventHtml = renderToString(() =>
      createComponent(Calendar, {
        date: "2026-07-15T12:00:00Z",
        events: [
          {
            id: "described",
            title: "Described event",
            description: "A concise plain-text preview.",
            start: "2026-07-15T09:00:00Z",
            end: "2026-07-15T10:30:00Z",
          },
        ],
        view: "day",
        timeZone: "UTC",
      }),
    );
    const smallerDescribedEventHtml = renderToString(() =>
      createComponent(Calendar, {
        date: "2026-07-15T12:00:00Z",
        events: [
          {
            id: "smaller-described",
            title: "Smaller described event",
            description: "This preview needs more room.",
            start: "2026-07-15T09:00:00Z",
            end: "2026-07-15T10:29:00Z",
          },
        ],
        view: "day",
        timeZone: "UTC",
      }),
    );
    expect(describedEventHtml).toContain('<span class="k2b-calendar-event__description">A concise plain-text preview.</span>');
    expect(smallerDescribedEventHtml).not.toContain("k2b-calendar-event__description");
    expect(contentCss).toMatch(/\.k2b-calendar-event__description \{[^}]*display: -webkit-box;[^}]*-webkit-line-clamp: 2;/s);
    expect(contentCss).toMatch(
      /\.k2b-calendar-event\[data-short="true"\] \{[^}]*display: flex;[^}]*align-items: center;[^}]*padding-block: 0;/s,
    );
    expect(contentCss).toMatch(/\.k2b-calendar-event\[data-selected="true"\] \.k2b-calendar-event__title \{[^}]*font-weight: 600;/s);
    expect(contentCss).toContain(
      "box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--k2b-calendar-accent, var(--k2b-action)) 42%, transparent)",
    );
    expect(contentCss).not.toContain("0 0 0 2px color-mix(in srgb, var(--k2b-calendar-accent");
    expect(contentCss).toMatch(
      /\.k2b-calendar-event\[data-interactive="true"\]:not\(\[data-selected="true"\]\):hover \{[^}]*box-shadow: 0 1px 2px rgb\(9 9 11 \/ 0\.12\);/s,
    );
    expect(contentCss).toMatch(/\.k2b-calendar-time-grid__now \{[^}]*border-top: 2px solid var\(--k2b-danger-500\);/s);
    expect(contentCss).toMatch(
      /\.k2b-calendar-time-grid__resize \{[^}]*left: 50%;[^}]*width: 2\.5rem;[^}]*height: 1\.5rem;[^}]*background: transparent;[^}]*transform: translateX\(-50%\);/s,
    );
    expect(contentCss).toMatch(
      /\.k2b-calendar-time-grid__resize-icon \{[^}]*width: 1rem;[^}]*height: 0\.125rem;[^}]*background: currentColor;[^}]*font-size: 0;/s,
    );
    expect(contentCss).toMatch(/\.k2b-calendar-preview--timed \{[^}]*right: 0\.25rem;[^}]*left: 0\.25rem;/s);
    expect(contentCss).toMatch(
      /\.k2b-calendar-month__events > \.k2b-calendar-preview \{[^}]*padding-block: calc\(0\.25rem - 1px\);[^}]*font-size: 0\.6875rem;[^}]*line-height: 1\.15;/s,
    );
    expect(contentCss).toMatch(/\.k2b-calendar-preview__title \{[^}]*font-size: 0\.6875rem;[^}]*font-weight: 600;/s);
    expect(contentCss).toMatch(
      /\.k2b-calendar-preview--timed\[data-short="true"\] \.k2b-calendar-preview__content \{[^}]*bottom: calc\(100% \+ 0\.25rem\);[^}]*display: flex;/s,
    );
    expect(contentCss).toMatch(/\.k2b-calendar-event\[data-fill="true"\] \{[^}]*width: 100%;[^}]*height: 100%;/s);
    expect(contentCss).toMatch(/\.k2b-calendar-year \{[^}]*gap: 0\.5rem;/s);
    expect(contentCss).toMatch(
      /\.k2b-calendar-year__month:nth-child\(-n \+ 3\) \{[^}]*border-start-start-radius: 0;[^}]*border-start-end-radius: 0;/s,
    );
    expect(contentCss).toMatch(
      /\.k2b-calendar-year__month:nth-child\(3n \+ 1\) \{[^}]*border-start-start-radius: 0;[^}]*border-end-start-radius: 0;/s,
    );
    expect(contentCss).toMatch(
      /\.k2b-calendar-year__month:nth-child\(3n\) \{[^}]*border-start-end-radius: 0;[^}]*border-end-end-radius: 0;/s,
    );
  });

  test("indexes year-view events once instead of rescanning them for every day", () => {
    const formatDateKey = dates.formatDateKey;
    const mutableDates = dates as { -readonly [Key in keyof typeof dates]: (typeof dates)[Key] };
    let calls = 0;
    mutableDates.formatDateKey = (...args: Parameters<typeof formatDateKey>) => {
      calls += 1;
      return formatDateKey(...args);
    };

    try {
      renderToString(() =>
        createComponent(Calendar, {
          date: "2026-07-15T12:00:00Z",
          view: "year",
          timeZone: "Europe/Berlin",
          events: Array.from({ length: 64 }, (_, index) => ({
            id: String(index),
            title: `Event ${index}`,
            start: "2026-07-15T09:00:00Z",
            end: "2026-07-15T10:00:00Z",
          })),
        }),
      );
    } finally {
      mutableDates.formatDateKey = formatDateKey;
    }

    expect(calls).toBeLessThan(2_000);
  });

  test("keeps code language defaults and custom documentation hooks", () => {
    const code = renderToString(() => createComponent(CodeDisplay, { code: "const answer = 42;", language: "ts" }));
    const docs = renderToString(() => [
      createComponent(DocCode, {
        code: "select 1",
        format: (value) => value.toUpperCase(),
        highlight: (value) => `<mark>${value}</mark>`,
        copy: true,
        copyText: "select 1",
        lineNumbers: true,
      }),
      createComponent(DocConceptGrid, { items: [{ title: "Source", icon: "ti ti-code", text: "Exact contract" }] }),
      createComponent(DocRows, { items: [{ title: "Mode", icon: "ti ti-check", text: "Portable" }] }),
    ]);

    expect(code).toContain("code-display");
    expect(code).toContain("k2b-content-code-display__body");
    expect(code).toContain('role="region"');
    expect(code).toContain('aria-label="ts code"');
    expect(code).toContain('tabindex="0"');
    expect(code).toContain("cd-k");
    expect(code).toContain("Copy");
    expect(docs).toContain("<mark>SELECT 1</mark>");
    expect(docs).toContain("Exact contract");
    expect(docs).toContain("Portable");
  });

  test("keeps DataTable callback names, URL sorting, defaults and scroll hooks", () => {
    type PersonRow = { id: string; name: string; count: number };
    const html = renderToString(() =>
      DataTable<PersonRow>({
        rows: [{ id: "one", name: "Ada", count: 3 }],
        columns: [
          { id: "name", header: ({ col }) => `Name (${col.id})`, value: "name", sortable: true },
          { id: "count", header: "Count", value: "count" },
        ],
        sort: { key: "count", direction: "asc" },
        sortHref: (sort) => `?sort=${sort.key}&direction=${sort.direction}`,
        getRowId: (row) => row.id,
        selectedRowId: "one",
        renderCell: ({ col, value, render }) => (col.id === "name" ? String(value).toUpperCase() : render(value)),
        footer: { values: { name: "Total", count: 3 } },
        scrollPreserveKey: "people",
      }),
    );

    expect(html).toContain("Name (name)");
    expect(html).toContain("ADA");
    expect(html).toContain("direction=desc");
    expect(html).toContain('data-scroll-preserve="people"');
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain('data-scrollbar-enhanced="true"');
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('data-has-footer="true"');
    expect(html).toContain("Total");
  });

  test("keeps table hover subtle without weakening the selected row", () => {
    expect(uiCss).toMatch(
      /\.k2b-data-table :is\(th, td\)\[data-highlighted="true"\] \{[^}]*var\(--k2b-hover\) 30%, transparent/s,
    );
    expect(uiCss).toMatch(
      /\.k2b-data-table__row\[data-hover="true"\]:not\(\[data-selected="true"\]\):hover \{[^}]*var\(--k2b-hover\) 50%, transparent/s,
    );
    expect(uiCss).toMatch(/\.k2b-data-table__row\[data-selected="true"\] \{[^}]*background: var\(--k2b-selected\)/s);
    expect(uiCss).toMatch(
      /\.k2b-data-table__row\[data-selected="true"\] > td\[data-highlighted="true"\] \{[^}]*background: transparent/s,
    );
  });

  test("keeps the DataTable overlay scrollbar as quiet as shared panel scrollbars", () => {
    expect(uiCss).toMatch(/\.k2b-data-table__scrollbar\[data-axis="y"\] \{[^}]*width: 0\.5rem/s);
    expect(uiCss).toMatch(/\.k2b-data-table__scrollbar\[data-axis="x"\] \{[^}]*height: 0\.5rem/s);
    expect(uiCss).toMatch(
      /\.k2b-data-table__scrollbar > span \{[^}]*border: 1px solid transparent[^}]*var\(--k2b-scrollbar-thumb\) 45%, transparent/s,
    );
    expect(uiCss).toMatch(
      /\.k2b-data-table__scrollbar:hover > span \{[^}]*background: var\(--k2b-scrollbar-thumb\)[^}]*background-clip: padding-box/s,
    );
  });

  test("keeps the load-more sentinel observable without creating vertical overflow", () => {
    expect(uiCss).toMatch(/\.k2b-data-table__sentinel \{[^}]*height: 1px[^}]*margin-top: -1px/s);
  });

  test("composes a labelled professional DataTable panel without component-valued props", () => {
    type Row = { id: string; name: string };
    const html = renderToString(() =>
      createComponent(DataTable.Panel, {
        get children() {
          return [
            createComponent(DataTable.Header, { title: "Orders", subtitle: "1 of 1 rows", children: "Settings" }),
            createComponent(DataTable.Controls, { children: "Search orders" }),
            DataTable<Row>({
              rows: [{ id: "one", name: "Ada" }],
              columns: [{ id: "name", header: "Name", value: "name" }],
              getRowId: (row) => row.id,
            }),
            createComponent(DataTable.Footer, { children: "Page 1 of 1" }),
          ];
        },
      }),
    );

    const headingId = html.match(/id="(k2b-data-table-[^"]+-heading)"/)?.[1];
    expect(headingId).toBeTruthy();
    expect(html).toContain(`aria-labelledby="${headingId}"`);
    expect(html).not.toContain('aria-label="Data table"');
    expect(html).toContain('class="k2b-paper k2b-data-panel');
    expect(html).toContain("k2b-data-panel__controls");
    expect(html).toContain("Settings");
    expect(html).toContain("Page 1 of 1");
  });

  test("lets standalone DataTable regions override their accessible name", () => {
    const html = renderToString(() =>
      DataTable({
        ariaLabel: "Project orders",
        rows: [{ id: "one" }],
        columns: [{ id: "id", header: "ID", value: "id" }],
      }),
    );

    expect(html).toContain('aria-label="Project orders"');
  });

  test("lets callers choose table surface independently from geometry classes", () => {
    const paper = renderToString(() =>
      DataTable({
        surface: "paper",
        class: "overflow-x-auto",
        rows: [{ id: "one" }],
        columns: [{ id: "id", header: "ID", value: "id" }],
      }),
    );
    const plain = renderToString(() =>
      DataTable({
        surface: "plain",
        rows: [{ id: "one" }],
        columns: [{ id: "id", header: "ID", value: "id" }],
      }),
    );

    expect(paper).toContain('data-surface="paper"');
    expect(paper).toContain('class="k2b-paper k2b-table-shell overflow-x-auto');
    expect(paper).toContain('class="k2b-table-wrap"');
    expect(paper).toContain("overflow-x-auto");
    expect(plain).toContain('data-surface="plain"');
    expect(plain).not.toContain("k2b-paper");
  });

  test("keeps SSR navigation and observability content defaults", () => {
    const pagination = renderToString(() => createComponent(Pagination, { currentPage: 5, totalPages: 10, baseUrl: "/items?page=" }));
    const range = renderToString(() =>
      createComponent(RangePicker, {
        value: "24h",
        options: [
          { value: "1h", href: "?window=1h" },
          { value: "24h", href: "?window=24h" },
        ],
      }),
    );
    const logs = renderToString(() =>
      createComponent(LogEntriesTable, {
        entries: [
          {
            id: 1,
            level: "error",
            source: "worker",
            message: "Failed",
            metadata: null,
            createdAt: "2026-01-01T12:00:00Z",
          },
        ],
      }),
    );

    expect(pagination).toContain('href="/items?page=4"');
    expect(pagination).toContain('rel="next"');
    expect(range).toContain('aria-current="true"');
    expect(logs).toContain("ti-alert-circle");
    expect(logs).toContain("worker");
  });

  test("renders unknown log levels without mislabelling them as debug", () => {
    const html = renderToString(() =>
      createComponent(LogEntriesTable, {
        entries: [{ id: 1, level: "notice", source: "worker", message: "Observed", metadata: null, createdAt: "2026-01-01T12:00:00Z" }],
      }),
    );

    expect(html).toContain('data-level="neutral"');
    expect(html).toContain("notice");
    expect(html).not.toContain("ti-bug");
    expect(html).toContain('aria-hidden="true"');
  });

  test("keeps pagination work bounded for very large result sets", () => {
    const html = renderToString(() =>
      createComponent(Pagination, {
        currentPage: 500_000_000,
        totalPages: 1_000_000_000,
        baseUrl: "/items?page=",
      }),
    );

    expect(html.match(/<a /g)?.length).toBeLessThanOrEqual(6);
    expect(html).toContain("500000000");
    expect(html).toContain("1000000000");
  });

  test("normalizes invalid pagination bounds", () => {
    const html = renderToString(() => createComponent(Pagination, { currentPage: -4, totalPages: 3, baseUrl: "/items?page=" }));

    expect(html).toContain("Page 1 of 3");
    expect(html).not.toContain("page=0");
  });

  test("keeps date-only calendar values in the configured local day and noninteractive events neutral", () => {
    const html = renderToString(() =>
      createComponent(Calendar, {
        date: "2026-07-15",
        selectedDate: "2026-07-15",
        view: "day",
        timeZone: "America/Los_Angeles",
        events: [{ id: "planning", title: "All-day planning", start: "2026-07-15", end: "2026-07-16", allDay: true }],
      }),
    );

    expect(html).toContain("All-day planning");
    const event = html.match(/<div class="k2b-calendar-event"[^>]*>/)?.[0] ?? "";
    expect(event).not.toContain('role="button"');
    expect(event).not.toContain("tabindex");
  });

  test("keeps trusted Markdown, structured data and PDF interaction shells", () => {
    const compactMarkdown = renderToString(() =>
      createComponent(MarkdownView, { trustedHtml: "<h2>Result</h2>", headingScale: "compact" }),
    );
    const normalMarkdown = renderToString(() => createComponent(MarkdownView, { trustedHtml: "<h2>Result</h2>", headingScale: "normal" }));
    const largeMarkdown = renderToString(() => createComponent(MarkdownView, { trustedHtml: "<h2>Result</h2>", headingScale: "large" }));
    const data = renderToString(() => createComponent(StructuredDataPreview, { data: { ok: true }, defaultMode: "raw", copy: true }));
    const pdf = renderToString(() =>
      createComponent(PdfPreview, { request: async () => new Blob([], { type: "application/pdf" }), title: "Report" }),
    );

    expect(compactMarkdown).toContain("k2b-content-markdown");
    expect(compactMarkdown).toContain('data-heading-scale="compact"');
    expect(normalMarkdown).not.toContain("data-heading-scale");
    expect(largeMarkdown).toContain('data-heading-scale="large"');
    expect(compactMarkdown).toContain("<h2>Result</h2>");
    expect(contentCss).toMatch(/\.k2b-content-markdown \{[^}]*white-space: normal/s);
    expect(contentCss).toContain('.k2b-content-markdown[data-heading-scale="compact"] h1');
    expect(contentCss).toContain('.k2b-content-markdown[data-heading-scale="large"] h1');
    expect(contentCss).toMatch(/\.k2b-content-markdown :is\(h1, h2, h3, h4, h5, h6\) \{[^}]*margin: 1rem 0 0\.5em/s);
    expect(contentCss).toMatch(/data-heading-scale="compact"[^}]*margin: 0\.75rem 0 0\.4em/s);
    expect(contentCss).toMatch(/> :first-child \{[^}]*margin-block-start: 0/s);
    expect(contentCss).toMatch(/> :last-child \{[^}]*margin-block-end: 0/s);
    expect(contentCss.indexOf("margin-block-start: 0")).toBeGreaterThan(contentCss.indexOf("margin-block: 1.1428571em"));
    expect(contentCss).not.toMatch(/data-heading-scale="compact"[^}]*text-decoration:\s*underline/s);
    expect(data).toContain("View formatted");
    expect(data).toContain("k2b-content-structured-data__action");
    expect(pdf).toContain("Open preview");
    expect(pdf).toContain("Preview PDF");
  });

  test("keeps DataTable density, alignment, sticky and footer geometry hooks", () => {
    type Row = { id: string; label: string; total: number };
    const html = renderToString(() =>
      DataTable<Row>({
        rows: [{ id: "one", label: "Ada", total: 3 }],
        columns: [
          { id: "label", header: "Label", subtitle: "who", value: "label" },
          { id: "total", header: "Total", value: "total" },
          { id: "mid", header: "Mid", value: "label", align: "center" },
        ],
        density: "compact",
        verticalAlign: "top",
        fillHeight: true,
        footer: { values: { total: 3 } },
        onLoadMore: () => {},
      }),
    );

    expect(html).toContain('data-density="compact"');
    expect(html).toContain('class="k2b-data-table" data-fill="true"');
    expect(html).toContain('data-sticky="true"');
    expect(html).toContain("k2b-data-table__head-row");
    expect(html).toContain("k2b-data-table__foot-row");
    expect(html).toContain("k2b-data-table__footer-cell");
    expect(html).toContain("k2b-data-table__header-subtitle");
    expect(html).toContain('data-align="right"');
    expect(html).toContain('data-align="center"');
    expect(html).toContain('data-valign="top"');
    expect(html).toContain("k2b-data-table__fill");
    expect(html).toContain("k2b-data-table__sentinel");
    expect(html).toContain("k2b-data-table__cell-text");
    expect(html).toContain('scope="col"');
    expect(html.indexOf("<tbody")).toBeLessThan(html.indexOf("<tfoot"));
  });

  test("infers each DataTable column alignment once per row set", () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ value: index + 1 }));
    let reads = 0;
    const tableProps: DataTableProps<(typeof rows)[number]> = {
      rows,
      get columns() {
        return [
          {
            id: "value",
            header: "Value",
            value: (row: (typeof rows)[number]) => {
              reads += 1;
              return row.value;
            },
          },
        ];
      },
    };
    const html = renderToString(() => DataTable(tableProps));

    // One read determines the alignment; one read per row renders the cells.
    expect(reads).toBe(rows.length + 1);
    expect(html).toContain('data-align="right"');
  });

  test("keeps the DataTable base geometry when callers add table classes", () => {
    const html = renderToString(() =>
      DataTable({
        rows: [{ id: "one" }],
        columns: [{ id: "id", header: "ID", value: "id" }],
        tableClass: "min-w-[72rem] text-sm",
      }),
    );

    expect(html).toContain('class="k2b-data-table min-w-[72rem] text-sm"');
  });

  test("keeps observability presentation hooks off Cloud-era utility names", () => {
    const pagination = renderToString(() => createComponent(Pagination, { currentPage: 5, totalPages: 20, baseUrl: "/items?page=" }));
    const range = renderToString(() =>
      createComponent(RangePicker, {
        value: "24h",
        label: "Window",
        options: [
          { value: "1h", href: "?window=1h" },
          { value: "24h", href: "?window=24h" },
        ],
      }),
    );
    const logs = renderToString(() =>
      createComponent(LogEntriesTable, {
        entries: [{ id: 1, level: "warn", source: "worker", message: "Slow", metadata: null, createdAt: "2026-01-01T12:00:00Z" }],
      }),
    );

    // Screen-reader summary must stay visually hidden, and the far pages must
    // stay collapsible below the `sm` breakpoint like Cloud.
    expect(pagination).toContain("k2b-sr-only");
    expect(pagination).toContain("k2b-pagination__pages");
    expect(pagination).toContain("k2b-pagination__ellipsis");
    expect(pagination).toContain("k2b-pagination__page--wide-only");
    expect(pagination).toContain("k2b-pagination__page is-current");
    expect(pagination).not.toContain('class="sr-only"');
    expect(pagination).not.toContain("pagination-item");

    expect(range).toContain("k2b-range-picker__caption");
    expect(range).toContain('data-selected="true"');
    expect(range).not.toContain("btn-input");

    expect(logs).toContain('data-level="warn"');
    expect(logs).toContain("k2b-log-table__source");
    expect(logs).toContain("k2b-log-table__time");
    expect(logs).not.toContain("text-amber-500");
  });

  test("styles every class the content group renders", async () => {
    const owned = ["Calendar.tsx", "Chart.tsx", "DataTable.tsx", "LogEntriesTable.tsx", "Pagination.tsx", "RangePicker.tsx"];
    const packageRoot = resolve(import.meta.dir, "../..");
    const css = await Bun.file(resolve(packageRoot, "dist/styles.css")).text();
    const defined = new Set<string>();
    for (const match of css.matchAll(/\.((?:[A-Za-z0-9_-]|\\.)+)/g)) defined.add(match[1]!.replace(/\\/g, ""));

    const unstyled: string[] = [];
    for (const file of owned) {
      // Comments carry documentation examples, not rendered markup.
      const source = (await Bun.file(resolve(import.meta.dir, file)).text()).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const match of source.matchAll(/class(?:Name)?\s*[:=]\s*\{?\s*[`"']([^`"']*)[`"']/g)) {
        // Interpolated segments are caller-owned classes, not package classes.
        const literal = match[1]!.replace(/\$\{[^}]*\}?/g, " ");
        for (const token of literal.split(/\s+/)) {
          // `ti*` icon classes ship in the optional Tabler preset, not here.
          if (!token || token.startsWith("ti-") || token === "ti") continue;
          if (!/^[A-Za-z][\w-]*$/.test(token)) continue;
          if (!defined.has(token)) unstyled.push(`${file}: ${token}`);
        }
      }
    }

    expect(unstyled).toEqual([]);
  });

  test("keeps path-first files and preview helpers", () => {
    const tree = renderToString(() =>
      createComponent(FileTree, {
        entries: [
          { path: "/src/app.ts", size: 4 },
          { path: "/README.md", size: 10 },
        ],
        selectedPath: "/README.md",
        actions: { download: () => {} },
      }),
    );
    expect(tree).toContain('role="tree"');
    expect(tree).toContain("README.md");
    expect(tree).toContain("k2b-content-file-tree__row");
    expect(tree).toContain("k2b-content-file-tree__select");
    expect(tree).toContain("<button");
    expect(tree).toContain("Actions for README.md");
    expect(getFileViewPreviewKind({ path: "report.json" })).toBe("json");
  });
});
