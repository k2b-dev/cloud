// Visual findings that code_check measures in a rendered document: the app
// frame at startup and after the steps, and the HTML of every PDF before it is
// printed. Plain DOM, so it runs in the app realm and in the check host alike.

/**
 * Smallest vertical offset reported. Optical nudges such as `margin-top: .2em`
 * on a checkbox stay below it; the base flow margins behind every misaligned
 * row measured so far (0.5rem, 1rem, 2rem) are well above it.
 */
export const MISALIGNED_PX = 6;
/** Findings per document and kind; one per container. */
const LIMIT = 5;

/** `key` names the container, so the same row pattern is reported once however often it repeats. */
export type LayoutFinding = { severity: "error" | "warning"; kind: string; message: string; key: string };
type Edge = "start" | "end" | "center";
type Item = { element: Element; edge: Edge; outer: number; inner: number };

const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
/** Rendered text with its line breaks. Elements of a PDF layout frame belong to that frame's realm. */
const rendered = (element: Element) => {
  const Html = element.ownerDocument.defaultView?.HTMLElement ?? HTMLElement;
  return (element instanceof Html ? element.innerText : element.textContent) ?? "";
};
const text = (element: Element) => rendered(element).trim().replace(/\s+/g, " ");

/** `tag#id` or `tag.class`. */
function nameOf(element: Element) {
  const escape = element.ownerDocument.defaultView?.CSS.escape ?? ((value: string) => value);
  if (element.id) return `${element.tagName.toLowerCase()}#${escape(element.id)}`;
  return (
    element.tagName.toLowerCase() +
    [...element.classList]
      .slice(0, 2)
      .map((name) => `.${escape(name)}`)
      .join("")
  );
}

/** The element's name, with parents until one has an id or class. */
function selectorOf(element: Element, depth = 0): string {
  const parent = element.parentElement;
  if (element.id || element.classList.length || !parent || parent === element.ownerDocument.body || depth >= 2) return nameOf(element);
  return `${selectorOf(parent, depth + 1)} > ${nameOf(element)}`;
}

const ROW = /^(?:inline-)?(?:flex|grid)$/;
/**
 * The margin reset for a row's children. The selector is pasted only when an id or class anchors it and every
 * element it matches is a row; `main > div` would also remove the spacing inside every other block of the page.
 */
function resetHint(selector: string, root: Element, view: Window) {
  let rows = false;
  try {
    rows =
      /[#.]/.test(selector) &&
      [...root.ownerDocument.querySelectorAll(selector)].every((element) => ROW.test(view.getComputedStyle(element).display));
  } catch {}
  return rows ? `add \`${selector} > * { margin: 0 }\`` : "give the row its own class and add `.that-class > * { margin: 0 }`";
}

/** An item of a named row: its own name and visible text. */
function describe(element: Element) {
  const label = clip(text(element), 40);
  return `${nameOf(element)}${label ? ` ${JSON.stringify(label)}` : ""}`;
}

function edgeOf(container: CSSStyleDeclaration, item: CSSStyleDeclaration): Edge | null {
  const value = (item.alignSelf === "auto" ? container.alignItems : item.alignSelf).replace(/^(?:safe|unsafe) /, "");
  if (/^(?:normal|stretch|start|flex-start|self-start)$/.test(value)) return "start";
  if (/^(?:end|flex-end|self-end)$/.test(value)) return "end";
  if (value === "center") return "center";
  // Baseline alignment offsets boxes on purpose.
  return null;
}

/** An auto margin places an item on purpose; computed styles report it only as pixels. */
function autoMargin(element: Element) {
  if (!("computedStyleMap" in element)) return false;
  try {
    const styles = element.computedStyleMap();
    return ["margin-top", "margin-bottom"].some((name) => String(styles.get(name)) === "auto");
  } catch {
    return false;
  }
}

/** Items of a flex row or grid that share an alignment line, clustered by the outer edge of their margin box. */
function rows(container: Element, style: CSSStyleDeclaration, view: Window): Item[][] {
  const items: Item[] = [];
  for (const element of container.children) {
    const own = view.getComputedStyle(element);
    if (own.position === "absolute" || own.position === "fixed" || own.display === "contents" || own.visibility !== "visible") continue;
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const edge = edgeOf(style, own);
    if (!edge || autoMargin(element)) continue;
    const top = Number.parseFloat(own.marginTop) || 0,
      bottom = Number.parseFloat(own.marginBottom) || 0;
    const outer = edge === "start" ? box.top - top : edge === "end" ? box.bottom + bottom : (box.top - top + box.bottom + bottom) / 2;
    const inner = edge === "start" ? box.top : edge === "end" ? box.bottom : (box.top + box.bottom) / 2;
    items.push({ element, edge, outer, inner });
  }
  const groups: Item[][] = [];
  for (const edge of ["start", "end", "center"] as const) {
    const sorted = items.filter((item) => item.edge === edge).sort((a, b) => a.outer - b.outer);
    let group: Item[] = [];
    for (const item of sorted) {
      if (group.length && item.outer - group[group.length - 1]!.outer > 1) {
        groups.push(group);
        group = [];
      }
      group.push(item);
    }
    if (group.length) groups.push(group);
  }
  return groups.filter((group) => group.length > 1);
}

const FIELD = "input:not([type=checkbox],[type=radio],[type=hidden]),select,textarea";
const CONTROL = `${FIELD},button`;

/**
 * The caption over a field or value in a cell: the top of its first rendered line and the bottom of its last one,
 * the line right above the field. Null when nothing sits below the first line.
 */
function captionOf(cell: Element, view: Window): { top: number; bottom: number } | null {
  const document = cell.ownerDocument;
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes: Node[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  const lines = (node: Node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    return [...range.getClientRects()].filter((line) => line.height > 0);
  };
  for (const [index, node] of nodes.entries()) {
    const line = lines(node)[0];
    if (!line) continue;
    const below = [...cell.querySelectorAll("*")].filter((element) => {
      if (element.contains(node)) return false;
      const box = element.getBoundingClientRect();
      return box.height > 0 && box.top >= line.bottom - 1 && view.getComputedStyle(element).visibility === "visible";
    });
    if (!below.length) return null;
    // The caption ends above the field, or above the first content below its first line.
    const field = cell.querySelector(FIELD);
    const end = field ? field.getBoundingClientRect().top : Math.min(...below.map((element) => element.getBoundingClientRect().top));
    let bottom = line.bottom;
    for (const later of nodes.slice(index))
      for (const rect of lines(later)) if (rect.bottom <= end + 1) bottom = Math.max(bottom, rect.bottom);
    return { top: line.top, bottom };
  }
  return null;
}

/** A margin that lines an item up with a field or button in another item of its row is placed on purpose. */
function linedUp(moved: Item, group: Item[]) {
  const edge = (box: DOMRect) => (moved.edge === "start" ? box.top : moved.edge === "end" ? box.bottom : (box.top + box.bottom) / 2);
  return group.some(
    ({ element }) =>
      element !== moved.element &&
      [element, ...element.querySelectorAll(CONTROL)].some(
        (control) => control.matches(CONTROL) && Math.abs(edge(control.getBoundingClientRect()) - moved.inner) <= 1,
      ),
  );
}

/**
 * Siblings in one flex row or grid row whose boxes are offset vertically, and
 * field captions in one row that do not line up. Both are what a person sees as
 * "slightly off": a flow margin on the second child of a flex `div`, or a
 * caption cell built differently from its neighbours.
 */
export function misalignedRows(root: Element): LayoutFinding[] {
  const view = root.ownerDocument.defaultView;
  if (!view) return [];
  const offsets = new Map<string, LayoutFinding & { more: number }>(),
    captions = new Map<string, LayoutFinding & { more: number }>();
  const note = (found: typeof offsets, key: string, message: () => string) => {
    const known = found.get(key);
    if (known) known.more++;
    else if (found.size < LIMIT) found.set(key, { severity: "warning", kind: "misaligned", key, message: message(), more: 0 });
  };
  for (const container of [root, ...root.querySelectorAll("*")]) {
    const style = view.getComputedStyle(container);
    const flex = /^(?:inline-)?flex$/.test(style.display) && style.flexDirection.startsWith("row") && style.flexWrap !== "wrap-reverse";
    const grid = /^(?:inline-)?grid$/.test(style.display);
    if ((!flex && !grid) || style.writingMode !== "horizontal-tb" || !container.getClientRects().length) continue;
    const selector = selectorOf(container);
    const name = `${selector} (${flex ? "flex" : "grid"})`;
    let worst: { offset: number; moved: Item; other: Item } | undefined;
    let caption: { offset: number; cell: Element; higher: boolean; edge: Edge } | undefined;
    for (const group of rows(container, style, view)) {
      const lowest = group.reduce((a, b) => (b.inner - b.outer > a.inner - a.outer ? b : a));
      const highest = group.reduce((a, b) => (b.inner - b.outer < a.inner - a.outer ? b : a));
      const offset = Math.abs(lowest.inner - lowest.outer - (highest.inner - highest.outer));
      if (offset >= MISALIGNED_PX && offset > (worst?.offset ?? 0)) {
        // The item with the larger margin on the aligned side is the one that moved.
        const moved = Math.abs(lowest.inner - lowest.outer) >= Math.abs(highest.inner - highest.outer) ? lowest : highest;
        if (!linedUp(moved, group)) worst = { offset, moved, other: moved === lowest ? highest : lowest };
      }
      // Captions: at least two fields agree on where their caption sits; another captioned cell does not.
      if (group.filter(({ element }) => element.matches(FIELD) || element.querySelector(FIELD)).length < 2) continue;
      // A row aligned at the end lines up the last caption line above each field, so a wrapped caption starts higher.
      const edge = group[0]!.edge;
      const cells = group.flatMap(({ element }) => {
        const found = captionOf(element, view);
        if (!found) return [];
        return [
          { element, at: edge === "end" ? found.bottom : found.top, field: element.matches(FIELD) || !!element.querySelector(FIELD) },
        ];
      });
      const fields = cells.filter((cell) => cell.field);
      const reference = fields.find((cell) => fields.filter((other) => Math.abs(other.at - cell.at) <= 1).length >= 2);
      if (!reference) continue;
      for (const cell of cells) {
        const offset = Math.abs(cell.at - reference.at);
        if (offset >= MISALIGNED_PX && offset > (caption?.offset ?? 0))
          caption = { offset, cell: cell.element, higher: cell.at < reference.at, edge };
      }
    }
    if (worst) {
      const { moved, other, offset } = worst;
      note(
        offsets,
        `offset ${selector}`,
        () =>
          `${describe(moved.element)} sits ${Math.round(offset)}px ${moved.inner > other.inner ? "lower" : "higher"} than ${describe(other.element)} in one row of ${name}. A margin moves it, usually the flow spacing between siblings; ${resetHint(selector, root, view)}.`,
      );
    }
    // A moved sibling also moves its caption; the margin finding already names the cause.
    if (caption && !worst) {
      const { cell, offset, higher, edge } = caption;
      note(
        captions,
        `caption ${selector}`,
        () =>
          `The caption of ${describe(cell)} sits ${Math.round(offset)}px ${higher ? "higher" : "lower"} than the field captions beside it in one row of ${name}. Give every cell the same caption-over-value structure${edge === "start" ? "" : ", or align the row at the start (`align-items: start`)"}.`,
      );
    }
  }
  return [...offsets.values(), ...captions.values()].map(({ more, ...finding }) => ({
    ...finding,
    message: more ? `${finding.message} The same in ${more} more ${more === 1 ? "row" : "rows"}.` : finding.message,
  }));
}

/** Messages a JavaScript engine writes for a bug in the code, never text a person should read (Chromium, WebKit, Firefox). */
const CODE_ERRORS = [
  /Cannot (?:read|set) propert(?:y|ies) of (?:null|undefined)/,
  /\b(?:null|undefined) is not an object\b/,
  /can't access property ["']/,
  /Can't find variable: /,
  /Cannot access '[^']+' before initialization/,
  /Maximum call stack size exceeded/,
  /Assignment to constant variable/,
  /\b[\w$]+(?:\??\.[\w$]+)+ is not (?:a function|iterable)\b/,
];
/** Any engine error turned into text, such as `String(error)` of a failed `JSON.parse` in an import. */
const ERROR_NAME = /\b(?:TypeError|ReferenceError|SyntaxError|RangeError): /;
/** Values that only appear when code formats something that is missing. */
const BROKEN_VALUES = /\[object Object\]|Invalid Date|(?<![\p{L}\p{N}_])(?:undefined|NaN)(?![\p{L}\p{N}_])/u;
/** Where an app shows its own messages; a log or table that quotes an error is content. */
const MESSAGES = "[role=alert],[role=status],[aria-live]:not([aria-live=off]),output";

/** The visible text of a document, and of its alert and status regions. */
export function shownText(root: Element) {
  return { page: rendered(root), messages: [...root.querySelectorAll(MESSAGES)].map(rendered).join("\n") };
}

const linesOf = (text: string) => [...new Set(text.split("\n").map((line) => line.trim().replace(/\s+/g, " ")))].filter(Boolean);

/**
 * A caught exception or a broken value that reached the visible page. A code-bug message in an alert or status
 * region fails: the app caught an exception and showed it. Elsewhere, or as a bare error name, it may be content
 * or an input error the app reports on purpose, so it warns.
 */
export function shownProblems(shown: { page: string; messages: string }, where = "The page"): LayoutFinding[] {
  const lines = linesOf(shown.page);
  // Hidden regions report their text as well; only what the page shows counts.
  const messages = new Set(linesOf(shown.messages).filter((line) => lines.includes(line)));
  const findings: LayoutFinding[] = [];
  const bug = (line: string) => CODE_ERRORS.some((pattern) => pattern.test(line));
  const engine = (line: string) => bug(line) || ERROR_NAME.test(line);
  const caught = lines.find((line) => messages.has(line) && bug(line));
  // The app's own messages first: a log table that quotes an error must not hide an input error shown later.
  const quoted = caught ? undefined : (lines.find((line) => messages.has(line) && engine(line)) ?? lines.find(engine));
  if (caught)
    findings.push({
      severity: "error",
      kind: "shown-error",
      key: `shown-error ${caught}`,
      message: `${where} shows a JavaScript error: ${JSON.stringify(clip(caught, 200))}. The app caught an exception and showed its message; fix the cause.`,
    });
  else if (quoted)
    findings.push({
      severity: "warning",
      kind: "shown-error",
      key: `shown-quoted ${quoted}`,
      message: `${where} shows text that reads like a JavaScript error: ${JSON.stringify(clip(quoted, 200))}. If the app caught an exception, fix the cause or tell the person what went wrong in their words; content such as a log entry may stay.`,
    });
  const value = lines.find((line) => !engine(line) && BROKEN_VALUES.test(line));
  if (value)
    findings.push({
      severity: "warning",
      kind: "shown-value",
      key: `shown-value ${value}`,
      message: `${where} shows a broken value: ${JSON.stringify(clip(value, 200))}. Format or leave out missing values.`,
    });
  return findings;
}
