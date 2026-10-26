import {
  CLOUD_AI_CHART_MAX_SERIES,
  CLOUD_AI_CHART_MAX_VALUES,
  type CloudAiChartInput,
  type CloudAiChartTable,
  type CloudAiNumberFormat,
  chartDrawingIssue,
  cloudAiChartLegend,
  cloudAiChartMarkKey,
  cloudAiChartReferenceMark,
  cloudAiChartRenderOptions,
  cloudAiChartRows,
  cloudAiChartSchema,
  cloudAiChartTable,
  cloudAiChartTooltip,
} from "@k2b/cloud/ai/browser";
import { type EvalResult, evaluateTableCell, isFormula, isTotalRow } from "@k2b/cloud/shared";
import { highlight, text } from "@k2b/stdlib";
import { prepareChartSnapshot } from "@k2b/ui";
import { Lexer, type Tokens } from "marked";
import { evaluatePrettyTable } from "../frontend/lib/pretty-table";
import { bookRendererMessages } from "./book-renderer-messages";
import { extractNamedBlocks, isNamedBlockHandle, type NamedDataEntry, namedBlockBody, parseNamedDataBlockResult } from "./named-blocks";
import {
  directives,
  type NotebookBlockDiagnostic,
  type NotebookBlockDiagnosticCode,
  parseScalar,
  parseValue,
  QUERY_MAX_BLOCKS,
} from "./query-blocks";

export const CHART_MAX_BLOCKS = QUERY_MAX_BLOCKS;
export type ChartBlock = { line: number; input: CloudAiChartInput };
type Frame = { kind: CloudAiChartInput["kind"]; area?: boolean; title: string; subtitle?: string };
type Entry = { value: string; line: number };
type Cell = { raw: string; result: EvalResult };
type SourceData = { columns: string[]; rows: Cell[][]; implicit: boolean; entries?: NamedDataEntry[]; invalid?: boolean };
const TYPES = new Set(["line", "area", "bar", "pie", "donut", "scatter", "stat"]);
const escape = highlight.escape;
const chartSchema = cloudAiChartSchema();
const scalarCell = (value: string | number | boolean): Cell => {
  const raw = String(value);
  return {
    raw,
    result:
      typeof value === "string"
        ? evaluateTableCell(0, 0, { headers: ["value"], rows: [[raw]], currentRow: 0, currentCol: 0 })
        : { kind: "ok", value },
  };
};

/** Reads only local note data. Markdown table tokens match the Book table renderer's cell text. */
const namedSource = (
  markdown: string,
  namedBlocks: ReturnType<typeof extractNamedBlocks>,
  name: string,
): SourceData | "duplicate" | null => {
  const matches = namedBlocks.filter((candidate) => candidate.name === name);
  // Two blocks of one name would make the chart pick one silently; named data and queries reject them too.
  if (matches.length > 1) return "duplicate";
  const block = matches[0];
  if (!block) return null;
  const source = markdown.slice(block.blockStart, block.blockEnd);
  if (block.type === "table") {
    const table = Lexer.lex(source, { gfm: true }).find((token): token is Tokens.Table => token.type === "table");
    if (!table || table.type !== "table") return null;
    const columns = table.header.map((cell) => cell.text);
    const data = { headers: columns, rows: table.rows.map((row) => row.map((cell) => cell.text)) };
    // Count before evaluating formulas in a table that cannot fit the chart budget.
    const valueRows = data.rows.filter((row) => !isTotalRow(row));
    const rows =
      valueRows.length > CLOUD_AI_CHART_MAX_VALUES
        ? valueRows
            .slice(0, CLOUD_AI_CHART_MAX_VALUES + 1)
            .map((row) => row.map((cell) => ({ raw: cell, result: { kind: "ok" as const, value: cell } })))
        : evaluatePrettyTable(data)
            .filter((row) => !row.isTotalRow)
            .map((row) => row.cells);
    return { columns, rows, implicit: false };
  }
  if (block.type === "list") {
    const list = Lexer.lex(source, { gfm: true }).find((token): token is Tokens.List => token.type === "list");
    if (!list || list.type !== "list") return null;
    const rows = list.items.slice(0, CLOUD_AI_CHART_MAX_VALUES + 1).map((item) => {
      // The last colon followed by a space ends the label, so times like 10:30 stay in it.
      const pair = item.text.match(/^([^\n]+):[ \t]+(\S.*)$/);
      return pair ? [scalarCell(pair[1]!.trim()), scalarCell(pair[2]!)] : [scalarCell(item.text), scalarCell("")];
    });
    return { columns: ["label", "value"], rows, implicit: true };
  }
  if (block.type === "data") {
    const parsed = parseNamedDataBlockResult(namedBlockBody(markdown, block));
    if (parsed.diagnostics.length) return { columns: [], rows: [], implicit: true, invalid: true };
    const entries = parsed.entries.filter((entry) => typeof entry.value === "number");
    return {
      columns: ["label", "value"],
      implicit: true,
      entries: parsed.entries,
      rows: entries.map((entry) => [scalarCell(text.humanize(entry.key)), scalarCell(typeof entry.value === "number" ? entry.value : "")]),
    };
  }
  return null;
};

const parseChart = (
  directive: ReturnType<typeof directives>[number],
  markdown: string,
  namedBlocks: ReturnType<typeof extractNamedBlocks>,
  sources: Map<string, SourceData | "duplicate" | null>,
) => {
  const diagnostics: NotebookBlockDiagnostic[] = [];
  const top = new Map<string, Entry>();
  const tooltip = new Map<string, Entry>();
  const rows: { cells: Cell[]; line: number }[] = [];
  const add = (
    code: NotebookBlockDiagnosticCode,
    key: string,
    line = top.get(key)?.line ?? directive.line,
    params?: NotebookBlockDiagnostic["params"],
  ) => diagnostics.push({ code, line, path: key ? `chart.${key}` : "chart", ...(params ? { params } : {}) });
  const pair = (target: Map<string, Entry>, key: string, entry: Entry, path: string) => {
    if (target.has(key)) add("duplicate-key", path, entry.line);
    else target.set(key, entry);
  };
  let section = "";
  let rowsExceeded = false;
  for (const [index, source] of directive.body.entries()) {
    const line = directive.line + index + 1;
    if (!source.trim()) continue;
    const entry = source.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/);
    if (entry) {
      const key = entry[1]!;
      section = "";
      if (
        !["type", "title", "subtitle", "data", "columns", "rows", "x", "y", "label", "value", "format", "unit", "tooltip"].includes(key)
      ) {
        add("unknown-key", key, line);
        continue;
      }
      pair(top, key, { value: entry[2]!, line }, key);
      if (key === "rows" || key === "tooltip") {
        section = key;
        if (entry[2]!.trim()) add("invalid-type", key, line);
      }
      continue;
    }
    const row = section === "rows" ? source.match(/^ {2}- (.+)$/) : null;
    if (row) {
      if (rows.length >= CLOUD_AI_CHART_MAX_VALUES) {
        if (!rowsExceeded) add("too-many-items", `rows.${rows.length}`, line, { limit: CLOUD_AI_CHART_MAX_VALUES });
        rowsExceeded = true;
        continue;
      }
      const values = parseValue(row[1]!);
      if (!Array.isArray(values)) add("invalid-type", `rows.${rows.length}`, line);
      else rows.push({ cells: values.map(scalarCell), line });
      continue;
    }
    const nested = section === "tooltip" ? source.match(/^ {2}([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/) : null;
    if (nested) {
      const key = nested[1]!;
      if (!["label", "format", "unit"].includes(key)) add("unknown-key", `tooltip.${key}`, line);
      else pair(tooltip, key, { value: nested[2]!, line }, `tooltip.${key}`);
      continue;
    }
    add("unexpected-line", section, line);
  }
  if (!directive.closed) add("unclosed-block", "");
  const string = (key: string, entries = top): string | undefined => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    const value = parseScalar(entry.value);
    if (typeof value === "string" && value.trim()) return value;
    add("invalid-type", entries === tooltip ? `tooltip.${key}` : key, entry.line);
    return undefined;
  };
  for (const key of ["type", "title"]) if (!top.has(key)) add("missing-key", key);
  const type = string("type");
  const title = string("title");
  const subtitle = string("subtitle");
  if (type && !TYPES.has(type)) add("invalid-type", "type");
  let data: SourceData = { columns: [], rows: [], implicit: false };
  if (top.has("data")) {
    if (top.has("columns") || top.has("rows")) add("invalid-type", "data");
    const name = isNamedBlockHandle(top.get("data")!.value);
    if (!name) add("invalid-type", "data");
    else {
      if (!sources.has(name)) sources.set(name, namedSource(markdown, namedBlocks, name));
      const source = sources.get(name);
      if (source === "duplicate") add("duplicate-block", "data", undefined, { name });
      else if (!source) add("unknown-block", "data", undefined, { name });
      else if (source.invalid) add("invalid-source", "data", undefined, { name });
      else data = source;
    }
  } else if (top.has("columns") || top.has("rows")) {
    for (const key of ["columns", "rows"]) if (!top.has(key)) add("missing-key", key);
    const columns = parseValue(top.get("columns")?.value ?? "");
    if (
      !Array.isArray(columns) ||
      !columns.length ||
      !columns.every((column): column is string => typeof column === "string" && !!column.trim())
    ) {
      if (top.has("columns")) add("invalid-type", "columns");
    } else {
      if (new Set(columns).size !== columns.length) add("duplicate-key", "columns");
      data = { columns, rows: rows.map((row) => row.cells), implicit: false };
      rows.forEach((row, index) => {
        if (row.cells.length !== columns.length) add("invalid-type", `rows.${index}`, row.line);
      });
    }
  } else if (type !== "stat") add("missing-key", "data");
  const dataKey = top.has("data") ? "data" : "rows";
  if (data.rows.length > CLOUD_AI_CHART_MAX_VALUES) add("too-many-items", dataKey, undefined, { limit: CLOUD_AI_CHART_MAX_VALUES });
  if (diagnostics.length || !type || !title) return { diagnostics };

  const column = (key: string, defaultName?: string): string | undefined => {
    const name = top.has(key) ? string(key) : defaultName;
    if (name === undefined) add("missing-key", key);
    else if (!data.columns.includes(name)) add("unknown-column", key, undefined, { name });
    return name;
  };
  const cells = (name: string) => data.rows.map((row) => row[data.columns.indexOf(name)]!);
  // A column reports its first bad cell only: one fix at a time, never a diagnostic per row.
  const reported = new Set<string>();
  const once = (code: NotebookBlockDiagnosticCode, key: string, params: NotebookBlockDiagnostic["params"]) => {
    if (reported.has(`${code}:${key}:${params?.name}`)) return;
    reported.add(`${code}:${key}:${params?.name}`);
    add(code, key, undefined, params);
  };
  const numbers = (name: string, key: string) =>
    cells(name).map((cell, index) => {
      if (cell.result.kind === "ok" && typeof cell.result.value === "number" && Number.isFinite(cell.result.value))
        return cell.result.value;
      once("not-a-number", key, { name, row: index + 1 });
      return 0;
    });
  const labels = (name: string, key: string) =>
    cells(name).map((cell, index) => {
      if (cell.result.kind === "error") once("not-a-number", key, { name, row: index + 1 });
      return isFormula(cell.raw) && cell.result.kind === "ok" ? String(cell.result.value) : cell.raw.trim();
    });
  const readFormat = (entries: Map<string, Entry>): CloudAiNumberFormat | undefined => {
    let format: CloudAiNumberFormat | undefined;
    const name = string("format", entries);
    const unit = string("unit", entries);
    if (name === "number" || name === "percent") format = { style: name };
    else if (name && /^[A-Z]{3}$/.test(name)) format = { style: "currency", currency: name };
    else if (name) add("invalid-type", entries === tooltip ? "tooltip.format" : "format", entries.get("format")?.line);
    return unit ? { ...format, unit } : format;
  };
  // The chart's format writes its axis, printed values and tooltips; a tooltip format applies to tooltips first.
  const chartFormat = readFormat(top);
  const tooltipFormat = readFormat(tooltip);
  const format = tooltipFormat ?? chartFormat;
  const axisFormat = chartFormat ?? tooltipFormat;
  const namedValue = string("label", tooltip);
  let valueLabel: string | undefined;
  let mapped: unknown;
  const common = { title, ...(subtitle ? { subtitle } : {}) };
  if (type === "stat") {
    const raw = top.get("value");
    const value = raw ? parseScalar(raw.value) : undefined;
    if (typeof value === "number") mapped = { ...common, kind: "stat", value, format };
    else if (typeof value === "string" && data.entries?.some((entry) => entry.key === value)) {
      const index = data.entries.findIndex((entry) => entry.key === value);
      valueLabel = text.humanize(value);
      const entry = data.entries[index]!;
      if (typeof entry.value !== "number" || !Number.isFinite(entry.value))
        add("not-a-number", "value", raw?.line, { name: value, row: index + 1 });
      else mapped = { ...common, kind: "stat", value: entry.value, format };
    } else {
      const name = column("value", data.implicit ? "value" : undefined);
      if (name && !diagnostics.length) {
        if (!data.implicit) valueLabel = name;
        const values = numbers(name, "value");
        mapped = { ...common, kind: "stat", value: values.at(-1), ...(values.length >= 2 ? { sparkline: values } : {}), format };
      }
    }
  } else if (type === "pie" || type === "donut") {
    const label = column("label", data.implicit ? "label" : undefined);
    const value = column("value", data.implicit ? "value" : undefined);
    if (label && value && !diagnostics.length) {
      if (!data.implicit) valueLabel = value;
      const values = numbers(value, "value");
      mapped = { ...common, kind: type, data: labels(label, "label").map((label, i) => ({ label, value: values[i] })), format };
    }
  } else {
    const x = column("x", data.implicit ? "label" : undefined);
    const y = top.has("y") ? parseValue(top.get("y")!.value) : data.implicit ? "value" : undefined;
    const ys = typeof y === "string" ? [y] : y;
    if (!ys) add("missing-key", "y");
    else if (!Array.isArray(ys) || !ys.length || !ys.every((name) => typeof name === "string")) add("invalid-type", "y");
    else {
      for (const name of ys) if (!data.columns.includes(String(name))) add("unknown-column", "y", undefined, { name: String(name) });
      if (type === "bar" && ys.length > 1) add("chart-one-series", "y");
      if (ys.length > CLOUD_AI_CHART_MAX_SERIES) add("too-many-items", "y", undefined, { limit: CLOUD_AI_CHART_MAX_SERIES });
      if (x && !diagnostics.length) {
        // The implicit `label` and `value` of a list or data block are no names a reader wrote: the contract's own
        // localized value label stays.
        if (ys.length === 1 && !data.implicit) valueLabel = String(ys[0]);
        // Axis titles name what a reader wrote: the x column and the value, as the tooltip calls it.
        const valueTitle = namedValue ?? valueLabel;
        const yAxis =
          valueTitle || axisFormat
            ? { yAxis: { ...(valueTitle ? { label: valueTitle } : {}), ...(axisFormat ? { format: axisFormat } : {}) } }
            : {};
        if (type === "bar") {
          const values = numbers(String(ys[0]), "y");
          mapped = {
            ...common,
            kind: "bar",
            data: labels(x, "x").map((label, i) => ({ label, value: values[i] })),
            ...(data.implicit ? {} : { xAxis: { label: x } }),
            ...yAxis,
          };
        } else {
          const xs = cells(x).map((cell, i) => {
            if (cell.result.kind === "error") {
              once("not-a-number", "x", { name: x, row: i + 1 });
              return 0;
            }
            const value = cell.result.value;
            // Calendar validity is checked by the shared ChartDate schema below.
            if (typeof value === "number" || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/.test(value)))
              return value;
            once("chart-x-type", "x", { name: x });
            return 0;
          });
          mapped = {
            ...common,
            kind: type === "area" ? "line" : type,
            ...(type === "area" ? { area: true } : {}),
            ...(data.implicit ? {} : { xAxis: { label: x } }),
            ...yAxis,
            series: ys.map((name) => ({ label: name, data: numbers(String(name), "y").map((y, i) => ({ x: xs[i], y })) })),
          };
        }
      }
    }
  }
  const tooltipLabel = namedValue ?? valueLabel;
  const parsed = chartSchema.safeParse({
    ...(typeof mapped === "object" && mapped !== null ? mapped : {}),
    ...(tooltipLabel || format ? { tooltip: { ...(tooltipLabel ? { label: tooltipLabel } : {}), ...(format ? { format } : {}) } } : {}),
  });
  if (diagnostics.length) return { diagnostics };
  if (!parsed.success) {
    const unsupported = new Set<string>();
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String);
      const first = path[0];
      // The axis and printed values share the format and value name with the tooltip; an issue points at the entry the
      // value came from, once.
      const yLabel = first === "yAxis" && path[1] === "label";
      const formatField = path.includes("unit") ? "unit" : "format";
      const fromTooltip =
        first === "tooltip" ||
        (first === "format" && !!tooltipFormat) ||
        (first === "yAxis" && (yLabel ? !!namedValue : path.includes("format") && !chartFormat));
      const tooltipField = fromTooltip ? ((first === "tooltip" && path[1] === "label") || yLabel ? "label" : formatField) : undefined;
      const key = tooltipField
        ? `tooltip.${tooltipField}`
        : first === "format" || (first === "yAxis" && path.includes("format"))
          ? formatField
          : first === "series"
            ? path.includes("x")
              ? "x"
              : "y"
            : first === "data" || first === "sparkline"
              ? dataKey
              : first === "xAxis"
                ? "x"
                : first === "yAxis"
                  ? "y"
                  : first === "kind"
                    ? "type"
                    : (first ?? "");
      const line = (tooltipField ? (tooltip.get(tooltipField)?.line ?? top.get("tooltip")?.line) : top.get(key)?.line) ?? directive.line;
      const id = `${line}:${key}`;
      if (unsupported.has(id)) continue;
      unsupported.add(id);
      add("chart-unsupported", key, line);
    }
    return { diagnostics };
  }
  if (chartDrawingIssue(parsed.data)) {
    add("chart-unsupported", dataKey);
    return { diagnostics };
  }
  return { diagnostics, block: { line: directive.line, input: parsed.data } };
};

/**
 * Every chart block of a note, or with `line` only the one opening there: reading one block never resolves or draws
 * the others, and it still counts against the note's block budget.
 */
export const parseNotebookChartBlocks = (
  markdown: string,
  options: { line?: number } = {},
): { blocks: ChartBlock[]; diagnostics: NotebookBlockDiagnostic[] } => {
  const blocks: ChartBlock[] = [];
  const diagnostics: NotebookBlockDiagnostic[] = [];
  const namedBlocks = extractNamedBlocks(markdown);
  const sources = new Map<string, SourceData | "duplicate" | null>();
  for (const [index, directive] of directives(markdown)
    .filter((entry) => entry.type === "chart")
    .entries()) {
    if (options.line !== undefined && directive.line !== options.line) continue;
    if (index >= CHART_MAX_BLOCKS) {
      diagnostics.push({ code: "too-many-items", line: directive.line, path: "chart" });
      continue;
    }
    const result = parseChart(directive, markdown, namedBlocks, sources);
    diagnostics.push(...result.diagnostics);
    if (result.block) blocks.push(result.block);
  }
  return { blocks, diagnostics };
};

/** A cheap frame for an editor placeholder; it never resolves or draws data. */
export const chartBlockFrame = (body: string[]): Frame | null => {
  const entries = new Map<string, string>();
  for (const line of body) {
    const pair = /^(type|title|subtitle):\s*(.*)$/.exec(line);
    if (!pair) continue;
    if (entries.has(pair[1]!)) return null;
    entries.set(pair[1]!, pair[2]!);
  }
  const type = parseScalar(entries.get("type") ?? "");
  const title = parseScalar(entries.get("title") ?? "");
  const subtitle = entries.has("subtitle") ? parseScalar(entries.get("subtitle")!) : undefined;
  if (typeof type !== "string" || !TYPES.has(type) || typeof title !== "string" || (subtitle !== undefined && typeof subtitle !== "string"))
    return null;
  // Validate the shared header fields without reading data or drawing a chart.
  const header = chartSchema.safeParse({ kind: "stat", title, subtitle, value: 0 });
  if (!header.success) return null;
  switch (type) {
    case "area":
      return { kind: "line", area: true, title: header.data.title, ...(header.data.subtitle ? { subtitle: header.data.subtitle } : {}) };
    case "line":
    case "bar":
    case "scatter":
    case "pie":
    case "donut":
    case "stat":
      return { kind: type, title: header.data.title, ...(header.data.subtitle ? { subtitle: header.data.subtitle } : {}) };
    default:
      return null;
  }
};

/**
 * The figure around a chart: title, subtitle, a place for the chart's controls and a viewport whose height comes from
 * the kind alone (app.css). The editor draws the same frame with an empty viewport while a preview loads, so the
 * drawing never moves the text. `input` is the drawn chart for the browser enhancement (`notebook-charts.tsx`): it adds
 * tooltips, the table view and Copy data in place, so the controls' box is reserved here. Print frames have no controls.
 */
export const notebookChartFrameHtml = (
  frame: Frame,
  viewportHtml: string,
  options: { legend?: boolean; input?: CloudAiChartInput; print?: boolean } = {},
): string =>
  `<figure class="notebook-book-chart" data-kind="${frame.kind === "line" && frame.area ? "area" : frame.kind}"${options.input ? ` data-chart="${escape(JSON.stringify(options.input))}"` : ""}><figcaption class="notebook-book-chart__header"><span class="notebook-book-chart__title">${escape(frame.title)}</span>${frame.subtitle ? `<span class="notebook-book-chart__subtitle">${escape(frame.subtitle)}</span>` : ""}</figcaption>${options.print ? "" : '<div class="notebook-book-chart__actions"></div>'}<div class="notebook-book-chart__viewport"${options.legend ? ' data-legend="true"' : ""}>${viewportHtml}</div></figure>`;

/** A chart's data as a note table: the PDF prints it below the figure, and the table view shows it in the frame. */
export const notebookChartTableHtml = (table: CloudAiChartTable, options: { label?: string; className?: string } = {}): string =>
  `<div class="md-table-wrap${options.className ? ` ${options.className}` : ""}"><table class="md-table"${options.label ? ` aria-label="${escape(options.label)}"` : ""}><thead><tr>${table.columns.map((col) => `<th scope="col">${escape(col.label)}</th>`).join("")}</tr></thead><tbody>${table.rows.map((row) => `<tr>${table.columns.map((col) => `<td><span${col.numeric ? ' class="md-align-right"' : ""}>${escape(row.cells[col.id] ?? "")}</span></td>`).join("")}</tr>`).join("")}</tbody></table></div>`;

/** Only the shared renderer supplies SVG. A failed drawing leaves the caller's source visible. */
export const renderNotebookChartFigure = (input: CloudAiChartInput, locale: string, options: { print?: boolean } = {}): string | null => {
  try {
    const rows = cloudAiChartRows(input, locale);
    const snapshot = prepareChartSnapshot(cloudAiChartRenderOptions(input, locale, { legend: "outside" }), {
      key: ({ datum }) => cloudAiChartMarkKey(datum),
      tooltip: ({ datum }) => {
        const row = rows.add(datum);
        return cloudAiChartTooltip(rows.columns(), row);
      },
      reference: ({ datum }) => cloudAiChartReferenceMark(input, datum),
    });
    if (!snapshot.marks.length) return null;
    const legend = cloudAiChartLegend(input, locale);
    const t = bookRendererMessages.resolve([locale]).t;
    const legendHtml = legend.length
      ? `<ul class="k2b-chart-legend" aria-label="${escape(t.chartLegend)}">${legend.map((entry) => `<li><span class="k2b-chart-legend__swatch"${entry.style && entry.style !== "solid" ? ` data-style="${entry.style}"` : ""}${entry.reference ? ' data-reference="true"' : ""} style="--k2b-chart-legend-color:var(--stdlib-chart-c${(entry.color % 8) + 1})" aria-hidden="true"></span>${escape(entry.label)}</li>`).join("")}</ul>`
      : "";
    const viewport = `<div class="k2b-chart" data-chart-kind="${snapshot.kind}"><div class="k2b-chart__svg"${snapshot.stretch ? ' data-stretch="true"' : ""} style="--k2b-chart-width:${snapshot.width}px;--k2b-chart-height:${snapshot.height}px">${snapshot.svg}</div></div>${legendHtml}`;
    const figure = notebookChartFrameHtml(input, viewport, { legend: legend.length > 0, ...(options.print ? { print: true } : { input }) });
    if (!options.print) return figure;
    return `${figure}${notebookChartTableHtml(cloudAiChartTable(input, locale))}`;
  } catch {
    return null;
  }
};
