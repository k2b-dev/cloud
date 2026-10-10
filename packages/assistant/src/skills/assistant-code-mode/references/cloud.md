The `cloud` contract of HTML apps, scripts and actions is self-contained; read it before writing code.

```ts
// The one global a Studio app or script gets: `cloud`.
// Agent-facing reference, self-contained (no imports).
// The same cloud global is available in HTML apps (index.html), scripts and app actions.
//
// Rules for agents
// - Await every cloud.* call. cloud.money.*, cloud.chart(), cloud.html`` and
//   cloud.http.secret() are synchronous helpers (awaiting them is harmless).
// - Every failed call rejects with a CloudError: `error.code` is one of the
//   CloudErrorCode values, `error.message` is a human sentence. An app shows
//   failures in the page (role="alert"); an unhandled failure also makes Cloud
//   show a notice outside the app. Scripts report them in the returned error or log.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Scalar = string | number | boolean | null;
type CloudBody = Blob | string | ArrayBuffer | Uint8Array;

type CloudErrorCode =
  | "denied" // the user declined an approval, or the viewer may not do this (for example kv.user in a public share)
  | "not_found" // unknown table, file or capability
  | "invalid" // wrong arguments; the message names the fix
  | "conflict"
  | "limit" // a size or row limit; the message says how to page or shrink
  | "unavailable" // not possible here (no network, service down, not executed during code_check)
  | "cancelled";
interface CloudError extends Error {
  name: "CloudError";
  code: CloudErrorCode;
}

/** Markup from cloud.html`` and cloud.chart(): a string that cloud.html`` does not escape again. Use it as innerHTML, inside cloud.html``, or as cloud.pdf.render html. */
// Html is a String object; compare with String(markup), never strict equality to a primitive.
// Quote attribute values. Boolean attributes work as ${condition ? "checked" : ""}.
interface Html extends String {}

// ---------------------------------------------------------------- identity

/** The signed-in viewer; null for anonymous visitors of a public share. */
type CloudUser = { readonly id: string; readonly name: string };

// ---------------------------------------------------------------- ai

type ExtractField = {
  name: string;
  type: "text" | "number" | "boolean" | "date_time" | "enum";
  description: string;
  required?: boolean;
  choices?: string[];
  maxLength?: number;
};

/** Bounded AI tasks on the server, billed to the viewer: no tools, no history. */
interface CloudAi {
  /** Free text answer to `prompt` about optional `input`. */
  text(options: { prompt: string; input?: Json; maxOutputChars?: number }): Promise<string>;
  /** Picks one of `choices`. */
  classify(options: { prompt: string; input: Json; choices: string[] }): Promise<string>;
  /** Picks several of `choices` (bounded by `min`/`max`). */
  classify(options: { prompt: string; input: Json; choices: string[]; multiple: true | { min?: number; max?: number } }): Promise<string[]>;
  /** Fills exactly the declared fields from unstructured `input`. */
  extract(options: { prompt: string; input: Json; fields: ExtractField[] }): Promise<Record<string, string | number | boolean | null>>;
}

// ---------------------------------------------------------------- http

/** Opaque placeholder; the server inserts the secret value. Cannot be read or concatenated. */
interface SecretRef {
  readonly secret: string;
  readonly prefix: string;
}

/**
 * Public HTTPS through the Cloud server. The user approves every request in a
 * Cloud dialog outside the app; the promise stays pending until then, and a
 * refusal rejects with code "denied". Private addresses and redirects are refused.
 */
interface CloudHttp {
  /** Like `fetch(url, init)`; native `fetch` does not exist in apps. */
  fetch(
    url: string,
    init?: {
      method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
      headers?: Record<string, string | SecretRef>;
      body?: CloudBody;
      signal?: AbortSignal;
    },
  ): Promise<Response>;
  /** Header value for a secret the user stored for this app, e.g. `{ Authorization: cloud.http.secret("api", { prefix: "Bearer " }) }`. */
  secret(name: string, options?: { prefix?: string }): SecretRef;
}

// ---------------------------------------------------------------- capabilities

/** Opaque stream descriptor from a capability result; pass it back unchanged. */
type StreamRef = { readonly [key: string]: unknown };

/** Cloud operations of other apps (Grids, Files, Mail, ...), with the viewer's permissions and approvals. */
interface CloudCapabilities {
  /** Runs a capability; returns its own envelope (`data`, `refs`, `stream` when supplied). */
  run<T = unknown>(name: string, input?: Json): Promise<T>;
  streams: {
    /** Reads a capability stream as a File. */
    read(stream: StreamRef): Promise<File>;
    /** Uploads bytes into a capability stream. */
    write(stream: StreamRef, body: CloudBody): Promise<unknown>;
    /** Current stream state and final result. */
    status(stream: StreamRef): Promise<{ state: "open" | "completed" | "aborted"; result?: unknown }>;
    /** Cancels an open stream. */
    abort(stream: StreamRef): Promise<void>;
  };
}

// ---------------------------------------------------------------- db

/**
 * Every row carries id, created_at, updated_at, created_by and updated_by;
 * Cloud sets them (created_by/updated_by are user ids, see cloud.user).
 */
type Row = {
  id: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
  [column: string]: Json;
};

/**
 * The app's database, shared by everyone who uses the app. Tables and columns
 * are created while building with the database tools, never from app code.
 * Column types: text, integer, real, boolean, json, date, datetime.
 */
// Table definitions carry write: "everyone" (default), "own", or "managers".
// Schema is managed through code_database. own allows inserts by every signed-in
// viewer with Use; updates/deletes require created_by === the requester. managers
// requires Manage for every write. Anonymous public-share visitors cannot write.
// created_by/updated_by are nullable user ids, set by Cloud. Existing tables gain
// these columns on first access without backfill. Do not declare or send them.
interface CloudDb {
  /** Rows of `table` matching every `where` column exactly (null matches NULL). At most 1,000 rows; more without an explicit `limit` rejects with "limit". */
  list(
    table: string,
    where?: Record<string, Scalar>,
    options?: { order?: string /* "name", "-updated_at" or "name desc" */; limit?: number; offset?: number },
  ): Promise<Row[]>;
  /** One row, or null. */
  get(table: string, id: number): Promise<Row | null>;
  /** Inserts one row (returns it) or many (returns them), with ids and timestamps. */
  insert(table: string, row: Record<string, Json>): Promise<Row>;
  insert(table: string, rows: Record<string, Json>[]): Promise<Row[]>;
  /** Changes the given columns of one row; returns the updated row, or null when it does not exist. */
  update(table: string, id: number, values: Record<string, Json>): Promise<Row | null>;
  /** Deletes one row; true when it existed. */
  delete(table: string, id: number): Promise<boolean>;
  /** One read-only SELECT with positional `?` parameters; returns raw rows (booleans as 0/1), at most 1,000. */
  query<R = Record<string, Scalar>>(sql: string, params?: Scalar[]): Promise<R[]>;
}

// ---------------------------------------------------------------- kv and files

/**
 * Pick the store by who owns the data:
 * - per person (my todos, my settings)        → cloud.kv.user
 * - small app-wide settings                   → cloud.kv
 * - records several people add or edit        → cloud.db, one row each
 * Each store allows 1,000 keys, 1 MiB per value, and 16 MiB in total.
 */
interface KvStore {
  /** Value or `null`. */
  get<T = Json>(key: string): Promise<T | null>;
  /** Stores JSON, at most 1 MiB per value (last writer wins). */
  set(key: string, value: Json): Promise<void>;
  /** Removes a key. */
  delete(key: string): Promise<void>;
  /** Keys in sorted order; `limit` 1-1000 (default 100). */
  keys(page?: { after?: string; limit?: number }): Promise<string[]>;
}

/** App file storage on the server, shared by everyone who uses the app. */
interface CloudFiles {
  /** File or `null`. */
  read(path: string): Promise<File | null>;
  /** Creates or replaces a file (at most 16 MiB). */
  write(path: string, data: Blob | string): Promise<void>;
  /** Removes a file. */
  delete(path: string): Promise<void>;
  /** Paths in sorted order. */
  list(): Promise<string[]>;
}

// ---------------------------------------------------------------- chart

type AxisOptions = {
  /** Label under/next to the axis. */
  label?: string;
  /** Tick text; the default is the user's number format (dates for date x values). */
  format?: (value: number) => string;
  /** Exact bounds; must contain every value. */
  domain?: [number, number];
  ticks?: number;
  scale?: "linear" | "log";
};
type ChartBase = {
  title?: string;
  subtitle?: string;
  /** Logical drawing size. Cartesian charts stretch to the container width; text keeps its pixel size. */
  width?: number;
  height?: number;
};
type ChartPoint = { x: number | Date | string /* ISO date */; y: number };
type ChartSeries = { label?: string; data: ChartPoint[] };
type ChartItem = { label: string; value: number };
type ChartOptions =
  | (ChartBase & { kind: "bar"; data: ChartItem[]; yAxis?: AxisOptions; colorByBar?: boolean; showValues?: boolean; legend?: boolean })
  | (ChartBase & {
      kind: "line";
      series: ChartSeries[];
      xAxis?: AxisOptions;
      yAxis?: AxisOptions;
      area?: boolean;
      smooth?: boolean;
      legend?: boolean;
    })
  | (ChartBase & { kind: "scatter"; series: ChartSeries[]; xAxis?: AxisOptions; yAxis?: AxisOptions; legend?: boolean })
  | (ChartBase & { kind: "pie" | "donut"; data: ChartItem[]; legend?: boolean; showLabels?: boolean })
  | (ChartBase & { kind: "histogram"; data: number[]; bins?: number; xAxis?: AxisOptions; yAxis?: AxisOptions })
  | (ChartBase & { kind: "gauge"; value: number; min?: number; max?: number; label?: string; unit?: string })
  | (ChartBase & { kind: "sparkline"; data: number[]; area?: boolean });

// ---------------------------------------------------------------- money

/** Exact money: `amount` in minor units (cents). Decimal inputs are strings, e.g. "1234.50". */
type Money = { readonly amount: number; readonly currency: string };
type Rounding = { rounding: "half-up" | "half-even" | "toward-zero" };
interface CloudMoney {
  /** "1234.5" (dot decimal, as from <input type=number>) → Money. */
  fromDecimal(value: string, options: { currency: string; rounding?: Rounding["rounding"] }): Money;
  /** Cents → Money. */
  fromMinor(amount: number, currency: string): Money;
  /** Money → "1234.50". */
  toDecimal(value: Money): string;
  /** For file data, pass its own number-format locale, not cloud.locale. User text like "1.234,56 €" → Money; `locale` defaults to cloud.locale. */
  parse(text: string, options: { currency: string; locale?: string }): Money;
  /** Money → "1.234,56 €"; `locale` defaults to cloud.locale. */
  format(value: Money, options?: { locale?: string }): string;
  add(a: Money, b: Money): Money;
  subtract(a: Money, b: Money): Money;
  sum(values: readonly Money[], options?: { currency: string }): Money;
  compare(a: Money, b: Money): -1 | 0 | 1;
  /** `factor` is a decimal string, e.g. "1.5". */
  multiply(value: Money, factor: string, options: Rounding): Money;
  divide(value: Money, divisor: string, options: Rounding): Money;
  /** `percent` is a decimal string, e.g. "19". */
  taxFromNet(net: Money, options: Rounding & { percent: string }): { net: Money; tax: Money; gross: Money };
  taxFromGross(gross: Money, options: Rounding & { percent: string }): { net: Money; tax: Money; gross: Money };
  /** Splits without losing cents. */
  allocate(total: Money, weights: readonly (number | string)[]): Money[];
}

// ---------------------------------------------------------------- pdf

type PdfPage = {
  format?: "A4" | "A3" | "A5" | "Letter" | "Legal";
  landscape?: boolean;
  margin?: { top?: number; right?: number; bottom?: number; left?: number };
};
type PdfText = {
  page: number;
  width: number;
  height: number;
  text: string;
  items: { text: string; transform: number[]; width: number; height: number; direction: string; endOfLine: boolean }[];
};

interface CloudPdf {
  /** HTML can contain <style>. headerHtml/footerHtml are separate small documents with their own style. HTML (a fragment is enough) to PDF on the server, styled by the Cloud base stylesheet like an app. With `facturX`: Factur-X PDF/A-3b. */
  render(
    options: {
      html: string | Html;
      title?: string;
      assets?: { name: string; data: Blob }[];
      headerHtml?: string;
      footerHtml?: string;
      page?: PdfPage;
      tagged?: boolean;
      facturX?: { xml: string; profile?: "MINIMUM" | "BASIC WL" | "BASIC" | "EN 16931" | "EXTENDED" };
    },
    init?: { signal?: AbortSignal },
  ): Promise<Blob>;
  /** Embeds files into an existing PDF. */
  attach(
    options: {
      document: Blob;
      attachments: { name: string; data: Blob; relationship?: "Source" | "Data" | "Alternative" | "Supplement" | "Unspecified" }[];
    },
    init?: { signal?: AbortSignal },
  ): Promise<Blob>;
  /** Reads text and positions locally (never uploaded); loads the PDF reader on first use. */
  read(file: Blob): Promise<{ pageCount: number; page(number: number): Promise<PdfText>; close(): Promise<void> }>;
}

// ---------------------------------------------------------------- sheet

type Cell = string | number | boolean | Date | null;

/** Spreadsheets and CSV; loaded on first use. */
interface CloudSheet {
  /**
   * CSV as objects keyed by the header row. Detects the delimiter and the
   * encoding (UTF-8, else Windows-1252). Dates stay text. Columns whose cells are all numbers
   * ("1.234,56", "1,234.56", "12,50 €") become numbers; codes with leading
   * zeros and unsafe integers stay text. Ambiguous columns use other unambiguous number columns,
   * then dot decimals for comma delimiters, otherwise the locale decimal mark. Header collisions
   * get unique suffixes. Malformed CSV or excess fields fail with invalid and a line number.
   * `numbers: false` keeps every cell as text.
   */
  parseCsv(
    input: Blob | string,
    options?: { delimiter?: string; encoding?: string; numbers?: boolean },
  ): Promise<Record<string, string | number>[]>;
  /** CSV text for Excel: semicolon, UTF-8 BOM, CRLF, formula-escaped cells, dot decimals for comma delimiters, otherwise the locale decimal mark. */
  toCsv(rows: Record<string, unknown>[], options?: { delimiter?: string; bom?: boolean }): Promise<string>;
  /** Reads XLSX or ODS (detected from the bytes); `rows()` defaults to the first sheet and includes the header row. */
  read(file: Blob, options?: { numbers?: "number" | "string" }): Promise<{ sheetNames: string[]; rows(name?: string): Cell[][] }>;
  /** ODS workbook. */
  toOds(sheets: { name: string; rows: (Cell | undefined)[][] }[]): Promise<Blob>;
}

// ---------------------------------------------------------------- finance

/**
 * German finance formats, loaded on first use, therefore awaited. Input shapes
 * are large; load the finance reference (finance.md, camt.md, einvoice.md) before using them.
 * Results are { ok: true, data } or { ok: false, error }.
 */
interface CloudFinance {
  datev: { validate(batch: object): Promise<unknown>; serialize(batch: object): Promise<unknown> };
  sepa: { validate(batch: object): Promise<unknown>; serialize(batch: object): Promise<unknown> };
  camt: { parse(xml: string, options?: object): Promise<unknown> };
  einvoice: {
    validate(invoice: object): Promise<unknown>;
    calculate(invoice: object): Promise<unknown>;
    serialize(invoice: object, options?: { format: string }): Promise<unknown>;
    parseXml(xml: string, options?: object): Promise<unknown>;
    parsePdf(pdf: Blob, options?: object): Promise<unknown>;
  };
}

// ---------------------------------------------------------------- cloud

interface Cloud {
  /** Locale of the viewer, e.g. "de-DE"; pass it to Intl. */
  readonly locale: string;
  /** IANA time zone of the viewer, e.g. "Europe/Berlin". */
  readonly timeZone: string;
  /** The signed-in viewer, or null in a public share. */
  readonly user: CloudUser | null;
  ai: CloudAi;
  http: CloudHttp;
  capabilities: CloudCapabilities;
  db: CloudDb;
  /** Small JSON state shared by everyone who uses the app (1,000 keys, 1 MiB per value, 16 MiB total). */
  kv: KvStore & {
    /** The same, private to the signed-in viewer, on every device. Rejects with "denied" in public shares. */
    user: KvStore;
  };
  files: CloudFiles;
  /** Hands a file to the user as a download (in script runs: an output file). Name first. */
  download(name: string, data: Blob | string): Promise<void>;
  /** Tagged template: escapes every ${value}, joins arrays, keeps nested cloud.html and cloud.chart markup. */
  html(strings: TemplateStringsArray, ...values: unknown[]): Html;
  /** Chart markup in Cloud colors for innerHTML, cloud.html or PDF HTML. */
  chart(options: ChartOptions): Html;
  money: CloudMoney;
  pdf: CloudPdf;
  sheet: CloudSheet;
  finance: CloudFinance;
}

declare const cloud: Cloud;

// ---------------------------------------------------------------- script mode

/** An input file of a script run (chat files passed with `inputPaths`). */
type RunFile = { path: string; size: number; type: string; file(): Promise<File> };

/**
 * Script mode (one-off scripts and app actions): a JS module whose default
 * export receives the JSON input and returns JSON. Logs come from `console.*`,
 * files from `cloud.download`.
 */
type Script = (
  input: Json | null,
  context: {
    /** Input files of this run; empty for app actions. */
    files: RunFile[];
    /** Aborted when the run is stopped. */
    signal: AbortSignal;
    /** Reports progress to the chat or caller. */
    progress(completed: number, total?: number, label?: string): void;
  },
) => Json | void | Promise<Json | void>;
```
