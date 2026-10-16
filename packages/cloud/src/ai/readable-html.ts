import type * as Htmlparser2 from "htmlparser2";

// sanitize-html loads this ESM-only package with require(). A static import would also place it in the static ESM
// graph, and Bun rejects that require() while the module is still linking ("require() async module"), depending
// on which importer evaluates first. A plain require() keeps one synchronous path for both, and the bundler still
// sees it and ships the package in the server bundle.
const { Parser }: typeof Htmlparser2 = require("htmlparser2");

const CHUNK_BYTES = 256 * 1024;
// Bun 1.4.2 GC heap deltas, including decoded chunks: nested/flat floods ~52/57 B/item,
// attributed images ~154 B/item. Reserve 256 B/item: 128 MiB / 256 = 524,288 items.
// This leaves 384 MiB of the 512 MiB conversion allowance for the 20 MiB input,
// up to 40 MiB of decoded text, runtime, transient allocations and rendering.
const MAX_PARSER_ITEMS = (128 * 1024 * 1024) / 256;
const TRUNCATED = "[Readable copy truncated at the file size limit.]";
const NOTICE_BYTES = Buffer.byteLength(TRUNCATED) + 3;
const headTags = new Set("title meta link style script noscript base template head".split(" "));
const droppedTags = new Set(
  "head script style noscript template svg math iframe object embed canvas video audio form button select textarea input dialog nav aside".split(
    " ",
  ),
);
const blocks = new Set(
  "p div section article main li blockquote pre table tr dl dt dd figure figcaption address details summary hr".split(" "),
);
const inlineBoundaries = new Set("br ul ol td th".split(" "));
const layoutBlocks = new Set("p div section article main ul ol li blockquote pre h1 h2 h3 h4 h5 h6 dl figure hr".split(" "));
const renderedTags = new Set([...blocks, ...inlineBoundaries, ..."a img code h1 h2 h3 h4 h5 h6 caption thead tbody tfoot".split(" ")]);
const retainedAttrs = new Map([
  ["a", ["href"]],
  ["img", ["src", "alt"]],
  ["pre", ["class"]],
  ["code", ["class"]],
  ["ol", ["start"]],
  ["td", ["colspan", "rowspan"]],
  ["th", ["colspan", "rowspan"]],
]);
const emptyAttrs: Record<string, string> = {};
const SKIP = 1;
const TITLE = 2;
const HEAD = 4;
const EMIT = 8;
const MAIN = 16;
const droppedRoles = new Set("navigation banner contentinfo complementary search dialog alertdialog".split(" "));
const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();
const escapeLabel = (text: string): string => text.replace(/[\[\]]/g, "\\$&");
const language = (classes = ""): string => {
  for (const token of classes.split(/\s+/u)) {
    if (token.length <= 100 && /^(?:language|lang)-[\w+-]+$/.test(token)) return token.slice(token.indexOf("-") + 1);
  }
  return "";
};
const hidden = (attrs: Record<string, string>): boolean => {
  if (!("hidden" in attrs || "aria-hidden" in attrs || "role" in attrs || "id" in attrs || "class" in attrs)) return false;
  if ("hidden" in attrs || attrs["aria-hidden"]?.toLowerCase() === "true") return true;
  if (
    (attrs.role ?? "")
      .toLowerCase()
      .split(/\s+/u)
      .some((role) => droppedRoles.has(role))
  )
    return true;
  for (const value of [attrs.id ?? "", attrs.class ?? ""]) {
    for (const token of value.split(/\s+/u)) {
      if (token.length > 100) continue;
      if (
        /^(cookie|cookies|consent|gdpr|cmp)([-_]?(banner|notice|bar|popup|modal|dialog|overlay|wall|layer|consent|container))?$/i.test(
          token,
        )
      )
        return true;
      if (/cookie-banner|cookie-consent|consent-banner/i.test(token)) return true;
    }
  }
  return false;
};
const charset = (value: string): string | undefined => {
  for (const parameter of value.split(";")) {
    const equals = parameter.indexOf("=");
    if (equals < 0 || parameter.slice(0, equals).trim().toLowerCase() !== "charset") continue;
    const label = parameter.slice(equals + 1).trim();
    const quote = label[0];
    return (quote === '"' || quote === "'") && label.endsWith(quote) ? label.slice(1, -1) : label;
  }
  return;
};
/** A byte order mark wins over header and meta declarations, as in the HTML encoding sniffing algorithm. */
const bomCharset = (bytes: Uint8Array): string | undefined => {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  return;
};
const decoderFor = (bytes: Uint8Array, contentType?: string): TextDecoder => {
  let label = bomCharset(bytes) ?? charset(contentType ?? "");
  if (!label) {
    const prefix = new TextDecoder("windows-1252").decode(bytes.subarray(0, 1024));
    const meta = new Parser({
      onopentag(name, attrs) {
        if (name !== "meta" || label) return;
        label = attrs.charset || (attrs["http-equiv"]?.toLowerCase() === "content-type" ? charset(attrs.content ?? "") : undefined);
      },
    });
    meta.end(prefix);
  }
  try {
    return new TextDecoder(label || "utf-8");
  } catch {
    return new TextDecoder("utf-8");
  }
};

const voidTags = new Set(
  "area base basefont br col command embed frame hr img input isindex keygen link meta param source track wbr".split(" "),
);
const impliedCloses = new Map<string, Set<string>>();
for (const name of "address article aside blockquote details div dl fieldset figcaption figure footer form header hr main nav ol p pre section table ul".split(
  " ",
)) {
  impliedCloses.set(name, new Set(["p"]));
}
for (const name of "h1 h2 h3 h4 h5 h6".split(" ")) impliedCloses.set(name, new Set("h1 h2 h3 h4 h5 h6 p".split(" ")));
for (const name of "select input output button datalist textarea".split(" "))
  impliedCloses.set(name, new Set("input option optgroup select button datalist textarea".split(" ")));
for (const [name, closes] of [
  ["tr", "tr th td"],
  ["th", "th td"],
  ["td", "thead th td"],
  ["body", "head link script"],
  ["a", "a"],
  ["li", "li"],
  ["option", "option"],
  ["optgroup", "optgroup option"],
  ["dd", "dd dt"],
  ["dt", "dd dt"],
  ["rt", "rt rp"],
  ["rp", "rt rp"],
  ["tbody", "thead tbody"],
  ["tfoot", "thead tbody"],
])
  impliedCloses.set(name!, new Set(closes!.split(" ")));

/** Parser's normal HTML stack uses unshift/shift and indexOf, quadratic at hostile depths.
 * The supported void-element hook keeps that stack empty. We balance the flat events
 * ourselves with push/pop and a last-open index per tag, including HTML implied closes.
 * Raw-text handling, attributes and entity decoding still belong to htmlparser2.
 */
class FlatHtmlParser extends Parser {
  private openName = "";
  constructor(
    onOpen: (name: string, attrs: Record<string, string>) => void,
    onText: (text: string) => void,
    private readonly onCloseName: (name: string) => void,
    private readonly sourceSlice: (start: number, end: number) => string,
    private readonly xml: boolean,
  ) {
    super(
      { onopentag: onOpen, ontext: onText },
      { decodeEntities: true, xmlMode: xml, lowerCaseTags: true, lowerCaseAttributeNames: true },
    );
  }
  protected override isVoidElement(): boolean {
    return true;
  }
  override onopentagname(start: number, end: number): void {
    this.openName = this.sourceSlice(start, end).toLowerCase();
    super.onopentagname(start, end);
  }
  override onselfclosingtag(end: number): void {
    super.onselfclosingtag(end);
    // HTML ignores a slash on ordinary tags, especially <script/> and <style/>.
    // XHTML and foreign roots close immediately even though the library's own stack is empty.
    // open() already closes void tags; closing br twice would add an extra break.
    if ((this.xml || this.openName === "svg" || this.openName === "math") && !voidTags.has(this.openName)) this.onCloseName(this.openName);
  }
  override onclosetag(start: number, end: number): void {
    this.endIndex = end;
    this.onCloseName(this.sourceSlice(start, end).toLowerCase());
    this.startIndex = end + 1;
  }
}

type TagEvent = { kind: "open" | "close"; name: string; attrs: Record<string, string>; layout?: boolean };
type Event = TagEvent | { kind: "text"; text: string };
type Span = { start: number; end: number };

/** One budget for parsing, span scans and all render calls. Synchronous parsing
 * checks it between bounded input chunks; rendering checks it between events. */
class WorkBudget {
  private events = 0;
  private characters = 0;
  constructor(private readonly signal?: AbortSignal) {}
  used(characters = 0): boolean {
    this.events++;
    this.characters += characters;
    return this.events >= 4096 || this.characters >= CHUNK_BYTES;
  }
  async yield(): Promise<void> {
    this.events = 0;
    this.characters = 0;
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.signal?.throwIfAborted();
  }
}

const isPermalink = (text: string): boolean => text.length <= 4 && [...text].length <= 2 && !/[\p{L}\p{N}]/u.test(text);

const linkUrl = (href: string | undefined, baseUrl: URL, image = false): string | undefined => {
  if (!href || href.trim().startsWith("#")) return;
  try {
    const url = new URL(href, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:" && (image || url.protocol !== "mailto:")) return;
    return url.toString().replace(/[() ]/g, (char) => (char === "(" ? "%28" : char === ")" ? "%29" : "%20"));
  } catch {
    return;
  }
};
type BacktickRun = { longest: number; trailing: number };
const countBackticks = (text: string, run: BacktickRun): void => {
  for (const char of text) {
    run.trailing = char === "`" ? run.trailing + 1 : 0;
    run.longest = Math.max(run.longest, run.trailing);
  }
};
const backticks = (run: BacktickRun, minimum: number): string => "`".repeat(Math.max(minimum, run.longest + 1));
const cellSpan = (value: string | undefined, minimum: number, maximum: number): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) || parsed < 0 ? 1 : Math.min(maximum, Math.max(minimum, parsed));
};

/** Render one inline span once. Placeholder delimiters avoid copying nested link text. */
const renderInline = async (
  events: Event[],
  start: number,
  end: number,
  baseUrl: URL,
  budget: WorkBudget,
  maxBytes: number,
): Promise<{ markdown: string; text: string; truncated: boolean }> => {
  const parts: string[] = [];
  const plain: string[] = [];
  let pendingSpace = false;
  let characters = 0;
  let size = 0;
  let truncated = false;
  let link:
    | { index: number; url?: string; characters: number; plainIndex: number; leadingSpace: boolean; spaceBefore: boolean; size: number }
    | undefined;
  let code: { depth: number; parts: string[]; ticks: BacktickRun } | undefined;
  const fits = (bytes: number): boolean => {
    if (size + bytes > maxBytes) {
      truncated = true;
      return false;
    }
    size += bytes;
    return true;
  };
  const append = (value: string) => {
    const space = pendingSpace && parts.length && !(link && characters === link.characters);
    if (!fits(Buffer.byteLength(value) + (space ? 1 : 0))) return;
    if (pendingSpace && parts.length) {
      if (link && characters === link.characters) link.leadingSpace = true;
      else parts.push(" ");
    }
    pendingSpace = false;
    parts.push(value);
  };
  const text = (value: string, ticks?: BacktickRun) => {
    const asCode = ticks !== undefined;
    plain.push(value);
    const normalized = value.replace(/\s+/gu, " ");
    const content = normalized.trim();
    if (content) {
      if (normalized.startsWith(" ")) pendingSpace = true;
      const fence = ticks ? backticks(ticks, 1) : "";
      const pad = asCode && (content.startsWith("`") || content.endsWith("`")) ? " " : "";
      const markdown = asCode ? `${fence}${pad}${content}${pad}${fence}` : content;
      append(link?.url ? escapeLabel(markdown) : markdown);
      characters += content.length;
    }
    if (normalized.endsWith(" ")) pendingSpace = true;
  };
  for (let index = start; index < end && !truncated; index++) {
    const event = events[index]!;
    if (budget.used(event.kind === "text" ? event.text.length : 0)) await budget.yield();
    if (code) {
      if (event.kind === "text") {
        code.parts.push(event.text);
        countBackticks(event.text, code.ticks);
      } else if (event.kind === "open") code.depth++;
      else if (--code.depth === 0) {
        text(code.parts.join(""), code.ticks);
        code = undefined;
      }
      continue;
    }
    if (event.kind === "text") {
      text(event.text);
      continue;
    }
    const open = event.kind === "open";
    if (event.name === "code" && open) code = { depth: 1, parts: [], ticks: { longest: 0, trailing: 0 } };
    else if (event.name === "a") {
      if (open && !link) {
        const url = linkUrl(event.attrs.href, baseUrl);
        if (url || event.attrs.href?.trim().startsWith("#")) {
          link = {
            index: parts.length,
            url,
            characters,
            plainIndex: plain.length,
            leadingSpace: pendingSpace,
            spaceBefore: pendingSpace,
            size,
          };
          pendingSpace = false;
          parts.push("");
        }
      } else if (!open && link) {
        if (!link.url && isPermalink(collapse(plain.slice(link.plainIndex).join("")))) {
          parts.length = link.index;
          plain.length = link.plainIndex;
          characters = link.characters;
          size = link.size;
          pendingSpace = link.spaceBefore;
        } else if (characters > link.characters) {
          const prefix = (link.leadingSpace && link.index > 0 ? " " : "") + (link.url ? "[" : "");
          const suffix = link.url ? `](${link.url})` : "";
          if (fits(Buffer.byteLength(prefix) + Buffer.byteLength(suffix))) {
            parts[link.index] = prefix;
            if (suffix) parts.push(suffix);
          }
        } else pendingSpace ||= link.leadingSpace;
        link = undefined;
      }
    } else if (event.name === "img" && open) {
      const alt = collapse(event.attrs.alt ?? "");
      const url = linkUrl(event.attrs.src, baseUrl, true);
      if (alt && url) {
        append(`![${escapeLabel(alt)}](${url})`);
        plain.push(alt);
        characters += alt.length;
      }
    } else if (blocks.has(event.name) || inlineBoundaries.has(event.name)) {
      pendingSpace = true;
      plain.push(" ");
    }
  }
  return { markdown: parts.join("").trim(), text: collapse(plain.join("")), truncated };
};

/** A flat stream of parser events; no DOM, recursive rendering, or ancestor walks. */
export const htmlToReadableMarkdown = async (
  bytes: Uint8Array,
  /** `maxBytes` caps the Markdown; `maxInputBytes` (default `maxBytes`) caps the HTML that is read. */
  options: { baseUrl: URL; contentType?: string; maxBytes: number; maxInputBytes?: number; signal?: AbortSignal },
): Promise<string> => {
  options.signal?.throwIfAborted();
  const events: Event[] = [];
  const budget = new WorkBudget(options.signal);
  let baseUrl = options.baseUrl;
  let hasBaseHref = false;
  type Table = { event: TagEvent; cells: number };
  const tables: Table[] = [];
  // Flags and a shared table slot avoid separate optional fields on every element.
  type Frame = { name: string; previous: number | undefined; flags: number; table: Table | undefined };
  const stack: Frame[] = [];
  const lastOpen = new Map<string, number>();
  // Tag-name offsets increase monotonically. Keep decoded chunks without repeatedly
  // concatenating them; even an oversized tag name spanning chunks is copied only once.
  const chunks: { start: number; text: string }[] = [];
  let decodedLength = 0;
  let closeChunk = 0;
  const sourceSlice = (start: number, end: number): string => {
    while (closeChunk < chunks.length && chunks[closeChunk]!.start + chunks[closeChunk]!.text.length <= start) closeChunk++;
    const parts: string[] = [];
    for (let index = closeChunk; index < chunks.length && chunks[index]!.start < end; index++) {
      const chunk = chunks[index]!;
      parts.push(chunk.text.slice(Math.max(0, start - chunk.start), end - chunk.start));
    }
    return parts.join("");
  };
  const titleParts: string[] = [];
  let skipDepth = 0;
  let regionDepth = 0;
  let mainDepth = 0;
  let titleDepth = 0;
  let main: Span | undefined;
  let articles: Span | undefined;
  let stateTruncated = false;
  const retain = (count: number): boolean => {
    if (events.length + stack.length + titleParts.length + count <= MAX_PARSER_ITEMS) return true;
    stateTruncated = true;
    parser.pause();
    return false;
  };
  const closeTop = () => {
    const frame = stack.pop();
    if (!frame) return;
    if (frame.previous === undefined) lastOpen.delete(frame.name);
    else lastOpen.set(frame.name, frame.previous);
    if (!(frame.flags & SKIP)) {
      if (frame.table) {
        if (frame.name === "table") tables.pop();
        else frame.table.cells--;
      }
      if (frame.flags & EMIT) events.push({ kind: "close", name: frame.name, attrs: emptyAttrs });
      if (frame.flags & MAIN && main) main.end = events.length;
      if (frame.name === "article" && articles) articles.end = events.length;
      if (frame.name === "main") mainDepth--;
      if (frame.name === "main" || frame.name === "article") regionDepth--;
    }
    if (frame.flags & TITLE) titleDepth--;
    if (frame.flags & SKIP) skipDepth--;
  };
  const closeHead = () => {
    const index = lastOpen.get("head");
    if (index !== undefined) while (stack.length > index) closeTop();
  };
  const open = (name: string, attrs: Record<string, string>) => {
    if (!headTags.has(name)) closeHead();
    if (name === "base" && attrs.href !== undefined && !hasBaseHref) {
      hasBaseHref = true;
      try {
        const resolved = new URL(attrs.href, options.baseUrl);
        if (resolved.protocol === "http:" || resolved.protocol === "https:") baseUrl = resolved;
      } catch {
        // Ignore malformed document base URLs.
      }
    }
    if (name === "form" && lastOpen.has(name)) return;
    const closes = impliedCloses.get(name);
    while (stack.length && closes?.has(stack.at(-1)!.name)) closeTop();
    const isHidden = hidden(attrs);
    const title =
      name === "title" &&
      titleDepth === 0 &&
      titleParts.length === 0 &&
      !isHidden &&
      (skipDepth === 0 || (((stack.at(-1)?.flags ?? 0) & HEAD) !== 0 && skipDepth === 1));
    const skip =
      skipDepth > 0 ||
      name === "title" ||
      droppedTags.has(name) ||
      isHidden ||
      ((name === "header" || name === "footer") && regionDepth === 0);
    const region = !skip && (name === "main" || name === "article");
    const emit = !skip && renderedTags.has(name);
    if (!retain(emit ? 2 : 1)) return;
    const frame: Frame = {
      name,
      previous: lastOpen.get(name),
      flags: (skip ? SKIP : 0) | (title ? TITLE : 0) | (name === "head" && skipDepth === 0 && !isHidden ? HEAD : 0) | (emit ? EMIT : 0),
      table: undefined,
    };
    if (title) titleDepth++;
    if (skip) skipDepth++;
    if (region) regionDepth++;
    if (!skip) {
      if (name === "main") {
        if (!main && mainDepth === 0) {
          frame.flags |= MAIN;
          main = { start: events.length, end: events.length };
        }
        mainDepth++;
      }
      if (name === "article") {
        const span = { start: events.length, end: events.length };
        articles ??= span;
      }
      const table = tables.at(-1);
      if (table?.cells && (name === "table" || layoutBlocks.has(name))) table.event.layout = true;
      if (emit) {
        let eventAttrs = emptyAttrs;
        for (const key of retainedAttrs.get(name) ?? []) {
          if (attrs[key] === undefined) continue;
          if (eventAttrs === emptyAttrs) eventAttrs = {};
          eventAttrs[key] = attrs[key];
        }
        const event: TagEvent = { kind: "open", name, attrs: eventAttrs };
        if (name === "table") {
          frame.table = { event, cells: 0 };
          tables.push(frame.table);
        } else if (table && (name === "td" || name === "th")) {
          frame.table = table;
          table.cells++;
        }
        events.push(event);
      }
    }
    lastOpen.set(name, stack.length);
    stack.push(frame);
    if (voidTags.has(name)) closeTop();
  };
  const parser = new FlatHtmlParser(
    open,
    (text) => {
      if (stack.at(-1)?.name === "head" && /\S/u.test(text)) closeHead();
      if (titleDepth && retain(1)) titleParts.push(text);
      else if (!skipDepth && retain(1)) events.push({ kind: "text", text });
    },
    (name) => {
      const index = lastOpen.get(name);
      if (index !== undefined) while (stack.length > index) closeTop();
      else if (name === "br") open("br", emptyAttrs);
      else if (name === "p") {
        open("p", emptyAttrs);
        closeTop();
      }
    },
    sourceSlice,
    options.contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/xhtml+xml",
  );
  const feed = (text: string) => {
    chunks.push({ start: decodedLength, text });
    decodedLength += text.length;
    parser.write(text);
  };
  const length = Math.min(bytes.byteLength, options.maxInputBytes ?? options.maxBytes);
  const decoder = decoderFor(bytes.subarray(0, length), options.contentType);
  for (let offset = 0; offset < length && !stateTruncated; offset += CHUNK_BYTES) {
    options.signal?.throwIfAborted();
    feed(decoder.decode(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, length)), { stream: true }));
    if (budget.used(Math.min(CHUNK_BYTES, length - offset))) await budget.yield();
  }
  options.signal?.throwIfAborted();
  if (!stateTruncated) {
    feed(decoder.decode());
    parser.end();
  }
  // Closing a frame replaces it with at most one event, so finishing cannot exceed the budget.
  while (stack.length) closeTop();
  const hasText = async (span: Span): Promise<boolean> => {
    for (let index = span.start; index < span.end; index++) {
      const event = events[index]!;
      if (budget.used(event.kind === "text" ? event.text.length : 0)) await budget.yield();
      if (event.kind === "text" && /\S/u.test(event.text)) return true;
      if (event.kind === "open" && event.name === "img" && collapse(event.attrs.alt ?? "") && linkUrl(event.attrs.src, baseUrl, true))
        return true;
    }
    return false;
  };
  const whole = { start: 0, end: events.length };
  const selected = main && (await hasText(main)) ? main : articles && (await hasText(articles)) ? articles : whole;
  if (!(await hasText(selected))) return "";
  const title = collapse(titleParts.join(""));
  const heading = title && !(await hasRenderedH1(events, selected, baseUrl, budget)) ? title : "";
  return render(events, selected, heading, { ...options, baseUrl, inputTruncated: stateTruncated || bytes.byteLength > length }, budget);
};

/** Scan the selected span once, following the render captures. An h1 inside
 * code, a link or a data cell is inline content, not a rendered heading. */
const hasRenderedH1 = async (events: Event[], span: Span, baseUrl: URL, budget: WorkBudget): Promise<boolean> => {
  let headingDepth = 0;
  let skipDepth = 0;
  let codeDepth = 0;
  let fragment: { depth: number; parts: string[] } | undefined;
  for (let index = span.start; index < span.end; index++) {
    const event = events[index]!;
    if (budget.used(event.kind === "text" ? event.text.length : 0)) await budget.yield();
    if (skipDepth) {
      if (event.kind === "open") skipDepth++;
      else if (event.kind === "close") skipDepth--;
      continue;
    }
    if (headingDepth) {
      if (event.kind === "open") headingDepth++;
      else if (event.kind === "close") headingDepth--;
      if (!codeDepth && event.kind === "open" && event.name === "a" && event.attrs.href?.trim().startsWith("#")) {
        fragment = { depth: headingDepth, parts: [] };
        continue;
      }
      let value = "";
      if (event.kind === "text") value = event.text;
      else if (codeDepth) codeDepth += event.kind === "open" ? 1 : -1;
      else if (event.kind === "open" && event.name === "code") codeDepth = 1;
      else if (event.kind === "open" && event.name === "img" && linkUrl(event.attrs.src, baseUrl, true)) value = event.attrs.alt ?? "";
      else if (blocks.has(event.name) || inlineBoundaries.has(event.name)) value = " ";
      if (fragment) {
        if (value) fragment.parts.push(value);
        if (headingDepth < fragment.depth) {
          const label = collapse(fragment.parts.join(""));
          if (label && !isPermalink(label)) return true;
          fragment = undefined;
        }
      } else if (/\S/u.test(value)) return true;
    } else if (event.kind === "open") {
      if (event.name === "h1") headingDepth = 1;
      else if (
        event.name === "pre" ||
        event.name === "code" ||
        event.name === "a" ||
        /^h[2-6]$/.test(event.name) ||
        (event.name === "table" && !event.layout)
      )
        skipDepth = 1;
    }
  }
  return false;
};

const render = async (
  events: Event[],
  span: Span,
  title: string,
  options: { baseUrl: URL; maxBytes: number; signal?: AbortSignal; inputTruncated: boolean },
  budget: WorkBudget,
): Promise<string> => {
  const parts: string[] = [];
  let size = 0;
  let truncated = false;
  let limited = false;
  let pendingBreak = 0;
  let pendingSpace = false;
  let lineStart = true;
  let quoteDepth = 0;
  let readable = false;
  const lists: { ordered: boolean; next: number }[] = [];
  const items: { marker: string; indent: string }[] = [];
  let capture:
    | { name: string; depth: number; parts: string[]; lang: string; firstCode: boolean; start: number; ticks: BacktickRun }
    | undefined;
  const tables: boolean[] = [];
  let row: { cells: string[]; size: number; lastReserved: number } | undefined;
  // Expiration row indexes avoid allocating or counting down one entry per spanned row.
  const rowspans = new Map<number, number>();
  let cellStart: number | undefined;
  let colspan = 1;
  let rowspan = 1;
  let captionStart: number | undefined;
  let tableRows = 0;
  let tableHeader = false;
  const remaining = () => Math.max(0, options.maxBytes - size - NOTICE_BYTES);
  const append = (text: string) => {
    if (!text || truncated) return;
    const next = Buffer.byteLength(text);
    if (size + next > options.maxBytes) {
      // Retain at most one extra bounded piece; final byte clipping also reserves the notice.
      const remaining = Math.max(0, options.maxBytes - size);
      parts.push(text.slice(0, remaining));
      truncated = true;
      return;
    }
    parts.push(text);
    size += next;
  };
  const boundary = (count = 2) => {
    pendingBreak = Math.max(pendingBreak, count);
    pendingSpace = false;
  };
  const write = (text: string, verbatim = false) => {
    if (!text) return;
    if (pendingBreak && parts.length) {
      append("\n".repeat(pendingBreak));
      lineStart = true;
    }
    pendingBreak = 0;
    if (lineStart) {
      const item = items.at(-1);
      append("> ".repeat(Math.min(quoteDepth, 6)) + (item ? item.marker || item.indent : ""));
      if (item) item.marker = "";
    } else if (pendingSpace) append(" ");
    pendingSpace = false;
    const continuation = "> ".repeat(Math.min(quoteDepth, 6)) + (items.at(-1)?.indent ?? "");
    append(
      continuation && text.includes("\n")
        ? text
            .split("\n")
            .map((line, index) => (index && line ? continuation + line : line))
            .join("\n")
        : text,
    );
    lineStart = verbatim ? text.endsWith("\n") : false;
  };
  const text = (value: string) => {
    const normalized = value.replace(/\s+/gu, " ");
    const trimmed = normalized.trim();
    if (trimmed) {
      if (normalized.startsWith(" ") && !lineStart && !pendingBreak) pendingSpace = true;
      write(trimmed);
      readable = true;
    }
    if (normalized.endsWith(" ")) pendingSpace = true;
  };
  const addCell = (markdown: string): boolean => {
    if (!row) return false;
    const bytes = Buffer.byteLength(markdown) + 3;
    if (row.size + bytes > remaining()) {
      limited = true;
      return false;
    }
    row.cells.push(markdown);
    row.size += bytes;
    return true;
  };
  const finishRow = () => {
    if (!row) return;
    while (!limited && row.cells.length <= row.lastReserved) addCell("");
    if (row.cells.length) {
      write(`| ${row.cells.join(" | ")} |`);
      boundary(1);
      if (!tableHeader) {
        write(`| ${row.cells.map(() => "---").join(" | ")} |`);
        boundary(1);
        tableHeader = true;
      }
    }
    tableRows++;
    row = undefined;
  };
  if (title) {
    write(`# ${title}`);
    boundary();
  }
  for (let index = span.start; index < span.end && !truncated && !limited; index++) {
    const event = events[index]!;
    if (budget.used(event.kind === "text" ? event.text.length : 0)) await budget.yield();
    if (capture) {
      if (event.kind === "text") {
        capture.parts.push(event.text);
        if (capture.name === "pre" || capture.name === "code") countBackticks(event.text, capture.ticks);
      } else if (event.kind === "open") {
        capture.depth++;
        if (capture.name === "pre" && event.name === "code" && !capture.firstCode) {
          capture.lang ||= language(event.attrs.class);
          capture.firstCode = true;
        }
        if (capture.name !== "pre" && (blocks.has(event.name) || event.name === "br")) {
          capture.parts.push(" ");
          capture.ticks.trailing = 0;
        }
      } else if (--capture.depth === 0) {
        const raw = capture.parts.join("");
        const value = capture.name === "pre" || capture.name === "code" ? collapse(raw) : "";
        if (capture.name === "pre") {
          const fence = backticks(capture.ticks, 3);
          boundary();
          write(`${fence}${capture.lang}\n${raw}${raw.endsWith("\n") ? "" : "\n"}${fence}`, true);
          boundary();
        } else if (capture.name === "code") {
          const fence = backticks(capture.ticks, 1);
          const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
          if (value) write(`${fence}${pad}${value}${pad}${fence}`);
        } else {
          const inline = await renderInline(
            events,
            capture.name === "a" ? capture.start : capture.start + 1,
            capture.name === "a" ? index + 1 : index,
            options.baseUrl,
            budget,
            Math.max(0, remaining() - (capture.name === "a" ? 0 : Number(capture.name[1]) + 1)),
          );
          if (inline.text) {
            if (capture.name === "a" && /^\s/u.test(raw)) pendingSpace = true;
            if (capture.name !== "a") boundary();
            write(capture.name === "a" ? inline.markdown : `${"#".repeat(Number(capture.name[1]))} ${inline.markdown}`);
            if (capture.name !== "a") boundary();
          }
          if (inline.text) readable = true;
          if (capture.name === "a" && /\s$/u.test(raw)) pendingSpace = true;
          limited ||= inline.truncated;
        }
        if (value && (capture.name === "pre" || capture.name === "code")) readable = true;
        capture = undefined;
      }
      continue;
    }
    if (event.kind === "text") {
      if (tables.at(-1) !== false) text(event.text);
      continue;
    }
    const { name, attrs } = event;
    const open = event.kind === "open";
    if (name === "table") {
      boundary();
      if (open) {
        tables.push(event.layout ?? false);
        if (!event.layout) {
          tableRows = 0;
          tableHeader = false;
          rowspans.clear();
          row = undefined;
          cellStart = undefined;
        }
      } else tables.pop();
      continue;
    }
    if (tables.at(-1) === false) {
      if (name === "thead" || name === "tbody" || name === "tfoot") rowspans.clear();
      else if (name === "caption") {
        if (open) captionStart = index + 1;
        else {
          const inline = await renderInline(events, captionStart ?? index, index, options.baseUrl, budget, remaining());
          if (inline.text) {
            boundary();
            write(inline.markdown);
            boundary();
            readable = true;
          }
          captionStart = undefined;
          limited ||= inline.truncated;
        }
      } else if (name === "tr") {
        if (open) {
          row = { cells: [], size: 1, lastReserved: -1 };
          for (const [column, until] of rowspans) {
            if (until <= tableRows) rowspans.delete(column);
            else row.lastReserved = Math.max(row.lastReserved, column);
          }
        } else finishRow();
      } else if (name === "td" || name === "th") {
        if (open) {
          cellStart = index + 1;
          colspan = cellSpan(attrs.colspan, 1, 1000);
          rowspan = cellSpan(attrs.rowspan, 0, 65534);
        } else if (row) {
          while (rowspans.has(row.cells.length) && !limited) addCell("");
          if (limited) {
            finishRow();
            continue;
          }
          const inline = await renderInline(
            events,
            cellStart ?? index,
            index,
            options.baseUrl,
            budget,
            Math.max(0, remaining() - row.size - 3),
          );
          for (let offset = 0; offset < colspan; offset++) {
            const column = row.cells.length;
            if (!addCell(offset === 0 ? inline.markdown.replace(/\|/g, "\\|") : "")) break;
            if (rowspan !== 1) rowspans.set(column, rowspan === 0 ? Infinity : tableRows + rowspan);
          }
          if (inline.text) readable = true;
          cellStart = undefined;
          limited ||= inline.truncated;
          if (limited) finishRow();
        }
      }
      continue;
    }
    if (open && (name === "pre" || name === "code" || name === "a" || /^h[1-6]$/.test(name))) {
      capture = {
        name,
        depth: 1,
        parts: [],
        lang: name === "pre" ? language(attrs.class) : "",
        firstCode: false,
        start: index,
        ticks: { longest: 0, trailing: 0 },
      };
      continue;
    }
    if (name === "img" && open) {
      const alt = collapse(attrs.alt ?? "");
      const url = linkUrl(attrs.src, options.baseUrl, true);
      if (alt && url) {
        write(`![${escapeLabel(alt)}](${url})`);
        readable = true;
      }
    } else if (name === "ul" || name === "ol") {
      boundary(1);
      if (open) {
        const start = attrs.start ?? "";
        lists.push({ ordered: name === "ol", next: /^-?\d{1,6}$/.test(start) ? Number(start) : 1 });
      } else lists.pop();
    } else if (name === "li") {
      boundary(1);
      if (open) {
        const list = lists.at(-1);
        const indent = items[Math.min(items.length, 6) - 1]?.indent ?? "";
        const marker = list?.ordered ? `${list.next++}. ` : "- ";
        items.push({ marker: indent + marker, indent: indent + " ".repeat(marker.length) });
      } else items.pop();
    } else if (name === "blockquote") {
      boundary();
      quoteDepth = Math.max(0, quoteDepth + (open ? 1 : -1));
    } else if (name === "br" && open) {
      pendingBreak = Math.min(2, pendingBreak + 1);
      pendingSpace = false;
    } else if (name === "hr" && open) {
      boundary();
      write("---");
      boundary();
    } else if (blocks.has(name) || name === "td" || name === "th") boundary();
  }
  options.signal?.throwIfAborted();
  truncated ||= limited;
  if (!readable && !truncated) return "";
  const result = parts.join("").trim();
  if (!truncated && !options.inputTruncated && Buffer.byteLength(result) + 1 <= options.maxBytes) return `${result}\n`;
  // The notice itself is the minimum possible result when maxBytes is smaller than it.
  const outputBudget = Math.max(0, options.maxBytes - NOTICE_BYTES);
  const prefix = new TextDecoder().decode(Buffer.from(result).subarray(0, outputBudget), { stream: true }).trimEnd();
  return `${prefix ? `${prefix}\n\n` : ""}${TRUNCATED}\n`;
};
