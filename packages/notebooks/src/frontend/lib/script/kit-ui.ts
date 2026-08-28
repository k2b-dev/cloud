/**
 * `ui` — declarative UI builder surface for `\`\`\`script` blocks.
 *
 * Two equivalent ways to mount:
 *
 *   ui.render(ui.button("Hi", fn));   // declarative
 *   ui.button("Hi", fn).show();           // chaining sugar
 *
 * Builders are pure: they return a `KitElement` (an `HTMLElement`
 * with a `.show()` method bolted on) and do NOT auto-mount. The
 * only side-effecting calls are `ui.render(...)`, `.show()`,
 * and `ui.toast(...)` (which fires the platform toast UI, not
 * tied to the script's output container).
 *
 * Children passed to layout primitives can be `KitElement`,
 * `HTMLElement`, plain `string` (auto-wrapped in `ui.text`),
 * or falsy (`null` / `false` / `undefined` — skipped, useful for
 * inline conditionals like `cond && ui.text(...)`).
 *
 * No CSS classes are exposed to scripts on purpose. Layout is
 * composed via `row` / `col` / `card`; visual variants live behind
 * specific options (e.g. `button({ variant: "danger" })`). For
 * advanced cases scripts can drop down to `ui.html(...)`.
 */

import { charts as stdCharts } from "@k2b/stdlib";
import { toast as platformToast, prompts } from "@k2b/ui";
import { markdown } from "@valentinkolb/cloud/shared";
import { notebookWorkspaceMessages } from "../../[id]/messages";
import { renderPrettyTableHtml } from "../pretty-table";
import type {
  KitButtonOptions,
  KitChartKind,
  KitChartOptions,
  KitChild,
  KitContext,
  KitElement,
  KitFormField,
  KitFormSpec,
  KitHeadingLevel,
  KitMetricOptions,
  KitNote,
  KitPromptAPI,
  KitTableView,
  KitTodoItem,
  KitUI,
} from "./kit-types";

/** Tag a freshly-created `HTMLElement` as a `KitElement` by giving
 *  it a `.show()` method that mounts to the active output.
 *
 *  Also sets `contenteditable="false"` on every kit element. The
 *  widget root already carries this attribute, and contenteditable
 *  inherits down the tree — but `y-codemirror.next`'s mutation
 *  observer pathway has been observed to react to specific element
 *  types (notably `<p>`) inside the widget's subtree even when an
 *  ancestor is `contenteditable=false`. Setting the attribute
 *  explicitly on every kit element gives every mutation a
 *  deterministic `target.isContentEditable === false` answer and
 *  closes the door on the Y.Text → CM → re-render → ytext-edit
 *  feedback loop that froze scripts with `ui.text(\`${current
 *  .tags.length}\`).show()`. */
const brand = (el: HTMLElement, ctx: KitContext): KitElement => {
  if (!el.hasAttribute("contenteditable")) {
    el.setAttribute("contenteditable", "false");
  }
  const ke = el as KitElement;
  ke.show = () => {
    if (ctx.isActive && !ctx.isActive()) return;
    ctx.outputEl.appendChild(ke);
  };
  return ke;
};

/** Convert a `KitChild` into a `Node` we can append. Strings become
 *  text wrappers; falsy values become `null` (caller skips). */
const childToNode = (child: KitChild, ctx: KitContext): Node | null => {
  if (child === null || child === undefined || child === false) return null;
  if (typeof child === "string") return makeText(child, ctx);
  // Anything else is an HTMLElement / KitElement — append directly.
  return child;
};

const appendChildren = (parent: HTMLElement, children: KitChild[], ctx: KitContext) => {
  for (const child of children) {
    const node = childToNode(child, ctx);
    if (node) parent.appendChild(node);
  }
};

// ── Content ──────────────────────────────────────────────────────

const makeText = (content: string, ctx: KitContext): KitElement => {
  // `<div>` rather than `<p>`: contentEditable-aware DOM ops in
  // browsers / CM apply special-case handling to `<p>` elements
  // (auto-split on Enter, etc.) which has been observed to feed
  // back into the widget's mutation observer and trigger a
  // re-render loop. `<div>` is structurally equivalent for our
  // purposes and stays inert.
  const el = document.createElement("div");
  el.className = "md-script-ui-text";
  el.textContent = content;
  return brand(el, ctx);
};

const makeHeading = (content: string, ctx: KitContext, level: KitHeadingLevel = 2): KitElement => {
  // Clamp the level to the valid 1..6 range — defensive against
  // callers passing arbitrary numbers via JS (no TS at runtime).
  const clamped = Math.max(1, Math.min(6, Math.floor(level))) as KitHeadingLevel;
  const el = document.createElement(`h${clamped}`);
  el.className = `md-script-ui-heading md-script-ui-heading-${clamped}`;
  el.textContent = content;
  return brand(el, ctx);
};

const makeMd = (markdownSrc: string, ctx: KitContext): KitElement => {
  const el = document.createElement("div");
  el.className = "md-script-ui-md";
  // Trusted-script-only — per-notebook opt-in is the security
  // boundary, same as `ui.html`. The same `markdown.render` the
  // server uses for read-mode parses GFM + our custom extensions
  // (info blocks, task lists, etc.).
  el.innerHTML = markdown.renderSync(markdownSrc);
  return brand(el, ctx);
};

const noteHref = (ctx: KitContext, note: KitNote | string): string => {
  const shortId = typeof note === "string" ? note : note.id;
  return `/app/notebooks/${ctx.notebookId}/notes/${shortId}`;
};

const makeNoteLink = (note: KitNote | string, label: string | undefined, ctx: KitContext): KitElement => {
  const el = document.createElement("a");
  el.className =
    "md-script-ui-note-link inline-flex items-center gap-1 text-blue-700 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-200";
  el.href = noteHref(ctx, note);
  const icon = document.createElement("i");
  icon.className = "ti ti-connection text-xs";
  const text = document.createElement("span");
  text.textContent = label ?? (typeof note === "string" ? note : note.title);
  el.append(icon, text);
  return brand(el, ctx);
};

const makeNoteList = (notes: KitNote[], options: { emptyText?: string } | undefined, ctx: KitContext): KitElement => {
  if (notes.length === 0) {
    const { t } = notebookWorkspaceMessages.resolve([document.documentElement.lang || "en"]);
    return makeText(options?.emptyText ?? t.noNotes, ctx);
  }
  const list = document.createElement("ul");
  list.className = "md-script-ui-note-list";
  for (const note of notes) {
    const item = document.createElement("li");
    item.appendChild(makeNoteLink(note, undefined, ctx));
    list.appendChild(item);
  }
  return brand(list, ctx);
};

const isKitNote = (value: unknown): value is KitNote =>
  !!value && typeof value === "object" && typeof (value as KitNote).id === "string" && typeof (value as KitNote).title === "string";

const isTodoArray = (value: unknown[]): value is KitTodoItem[] =>
  value.length > 0 &&
  value.every(
    (item) =>
      !!item &&
      typeof item === "object" &&
      typeof (item as KitTodoItem).done === "boolean" &&
      typeof (item as KitTodoItem).content === "string" &&
      typeof (item as KitTodoItem).line === "number",
  );

const normalizeTableValue = (value: unknown, column?: string): string => {
  if (value === null || value === undefined) return "";
  if (isKitNote(value)) return `[${value.title}](note://${value.id})`;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) {
    if (isTodoArray(value)) {
      const done = value.filter((task) => task.done).length;
      return `=PROGRESS(${done}, ${value.length})`;
    }
    const tagColumn = column?.toLowerCase().includes("tag") ?? false;
    return value
      .map((item) => (tagColumn && typeof item === "string" ? (item.startsWith("#") ? item : `#${item}`) : normalizeTableValue(item)))
      .join(" ");
  }
  if (typeof value === "object") {
    const maybeTasks = value as { done?: unknown; total?: unknown };
    if (typeof maybeTasks.done === "number" && typeof maybeTasks.total === "number") {
      return `=PROGRESS(${maybeTasks.done}, ${maybeTasks.total})`;
    }
    return JSON.stringify(value);
  }
  return String(value);
};

const isTableView = (value: unknown): value is KitTableView =>
  !!value && typeof value === "object" && Array.isArray((value as KitTableView).columns) && Array.isArray((value as KitTableView).rows);

const isTableCellElement = (value: unknown): value is HTMLElement => typeof HTMLElement !== "undefined" && value instanceof HTMLElement;

const makeTable = (
  input: unknown[][] | Record<string, unknown>[] | KitTableView,
  options: { columns?: string[]; emptyText?: string } | undefined,
  ctx: KitContext,
): KitElement => {
  const rows = isTableView(input) ? input.rows : input;
  if (rows.length === 0) {
    const { t } = notebookWorkspaceMessages.resolve([document.documentElement.lang || "en"]);
    return makeText(options?.emptyText ?? t.noRows, ctx);
  }
  const columns =
    options?.columns ??
    (isTableView(input)
      ? input.columns
      : Array.isArray(rows[0])
        ? (rows[0] as unknown[]).map((_, index) => `Column ${index + 1}`)
        : Object.keys(rows[0] as Record<string, unknown>));
  const elementCells: Array<{ row: number; col: number; element: HTMLElement }> = [];
  const normalizedRows = rows.map((row, rowIndex) =>
    columns.map((column, index) => {
      const value = Array.isArray(row) ? row[index] : (row as Record<string, unknown>)[column];
      if (isTableCellElement(value)) {
        elementCells.push({ row: rowIndex, col: index, element: value });
        return "";
      }
      return normalizeTableValue(value, column);
    }),
  );
  const el = document.createElement("div");
  el.className = "md-script-ui-table";
  el.innerHTML = renderPrettyTableHtml({ headers: columns, rows: normalizedRows }, { notebookId: ctx.notebookId });

  if (elementCells.length > 0) {
    const bodyRows = Array.from(el.querySelectorAll("tbody tr"));
    for (const { row, col, element } of elementCells) {
      const tableCell = bodyRows[row]?.querySelectorAll("td")[col];
      if (!tableCell) continue;
      if (!element.hasAttribute("contenteditable")) element.setAttribute("contenteditable", "false");
      const wrapper = document.createElement("span");
      wrapper.className = "md-table-cell md-table-cell-ui";
      wrapper.appendChild(element);
      tableCell.replaceChildren(wrapper);
    }
  }

  return brand(el, ctx);
};

const isEmptyChart = (kind: KitChartKind, options: Record<string, unknown>): boolean => {
  if (kind === "line" || kind === "scatter") {
    const series = options.series as Array<{ data?: unknown[] }> | undefined;
    return !series?.length || series.every((item) => !item.data?.length);
  }
  if (kind === "bar" || kind === "donut" || kind === "pie") {
    const data = options.data as unknown[] | undefined;
    return !data?.length;
  }
  if (kind === "histogram" || kind === "sparkline") {
    const data = options.data as unknown[] | undefined;
    return !data?.length;
  }
  if (kind === "boxplot") {
    const groups = options.groups as unknown[] | undefined;
    return !groups?.length;
  }
  return false;
};

const makeChart = <K extends KitChartKind>(kind: K, options: KitChartOptions<K>, ctx: KitContext): KitElement => {
  const { height: requestedHeight, ...chartOptions } = options;
  const height = Math.max(32, Math.round(typeof requestedHeight === "number" ? requestedHeight : 240));
  const el = document.createElement("div");
  el.className = "md-script-ui-chart text-dimmed";
  el.style.height = `${height}px`;

  const render = (width: number) => {
    if (ctx.isActive && !ctx.isActive()) return;
    const normalizedWidth = Math.max(120, Math.round(width || 480));
    const opts = chartOptions as Record<string, unknown>;
    if (isEmptyChart(kind, opts)) {
      el.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "md-script-ui-chart-empty";
      empty.textContent = notebookWorkspaceMessages.resolve([document.documentElement.lang || "en"]).t.noData;
      el.appendChild(empty);
      return;
    }
    // The stdlib chart functions are a discriminated namespace. At
    // runtime they all accept one options object; the public KitUI
    // type above keeps call sites per-kind typed.
    el.innerHTML = (stdCharts[kind] as (opts: unknown) => string)({
      ...opts,
      width: normalizedWidth,
      height,
    });
  };

  render(480);

  if (typeof ResizeObserver !== "undefined") {
    let lastWidth = 0;
    const ro = new ResizeObserver((entries) => {
      if (ctx.isActive && !ctx.isActive()) {
        ro.disconnect();
        return;
      }
      const entry = entries[0];
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      if (width <= 0 || width === lastWidth) return;
      lastWidth = width;
      render(width);
    });
    ro.observe(el);

    if (typeof MutationObserver !== "undefined") {
      let hasBeenConnected = false;
      const mo = new MutationObserver(() => {
        if (ctx.outputEl.contains(el)) {
          hasBeenConnected = true;
          return;
        }
        if ((ctx.isActive && !ctx.isActive()) || hasBeenConnected) {
          ro.disconnect();
          mo.disconnect();
        }
      });
      mo.observe(ctx.outputEl, { childList: true, subtree: true });
    }
  }

  return brand(el, ctx);
};

// ── Layout ───────────────────────────────────────────────────────

const makeRow = (children: KitChild[], ctx: KitContext): KitElement => {
  const el = document.createElement("div");
  el.className = "md-script-ui-row";
  appendChildren(el, children, ctx);
  return brand(el, ctx);
};

const makeCol = (children: KitChild[], ctx: KitContext): KitElement => {
  const el = document.createElement("div");
  el.className = "md-script-ui-col";
  appendChildren(el, children, ctx);
  return brand(el, ctx);
};

const makeCard = (children: KitChild[], ctx: KitContext): KitElement => {
  const el = document.createElement("div");
  el.className = "md-script-ui-card";
  appendChildren(el, children, ctx);
  return brand(el, ctx);
};

const makeMetric = (label: string, value: string | number, options: KitMetricOptions | undefined, ctx: KitContext): KitElement => {
  const el = document.createElement("div");
  el.className = `md-script-ui-metric md-script-ui-metric-${options?.tone ?? "default"}`;

  const header = document.createElement("div");
  header.className = "md-script-ui-metric-header";

  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  header.appendChild(labelEl);

  const valueEl = document.createElement("div");
  valueEl.className = "md-script-ui-metric-value";
  if (options?.icon) {
    const icon = document.createElement("i");
    icon.className = options.icon;
    valueEl.appendChild(icon);
  }
  const valueText = document.createElement("span");
  valueText.textContent = String(value);
  valueEl.appendChild(valueText);

  el.append(header, valueEl);

  if (options?.hint) {
    const hint = document.createElement("div");
    hint.className = "md-script-ui-metric-hint";
    hint.textContent = options.hint;
    el.appendChild(hint);
  }

  return brand(el, ctx);
};

const makeDivider = (ctx: KitContext): KitElement => {
  const el = document.createElement("hr");
  el.className = "md-script-ui-divider";
  return brand(el, ctx);
};

// ── Interactive ──────────────────────────────────────────────────

const makeButton = (
  label: string,
  onClick: () => void | Promise<void>,
  options: KitButtonOptions | undefined,
  ctx: KitContext,
): KitElement => {
  const btn = document.createElement("button");
  btn.type = "button";
  const variant = options?.variant ?? "primary";
  btn.className = "md-script-ui-button md-script-button";
  btn.dataset.variant = variant;

  const icon = document.createElement("i");
  icon.className = options?.icon ?? "ti ti-sparkles";
  btn.appendChild(icon);

  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  btn.appendChild(labelEl);

  if (options?.disabled) btn.disabled = true;

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (btn.disabled) return;
    try {
      const result = onClick();
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((err) => {
          console.error("[ui.button] onClick threw:", err);
        });
      }
    } catch (err) {
      console.error("[ui.button] onClick threw:", err);
    }
  });

  return brand(btn, ctx);
};

// ── Escape hatch ─────────────────────────────────────────────────

const makeHtml = (rawHtml: string, ctx: KitContext): KitElement => {
  const el = document.createElement("div");
  el.className = "md-script-ui-html";
  el.innerHTML = rawHtml;
  return brand(el, ctx);
};

const normalizeLiveChildren = (value: KitChild | KitChild[]): KitChild[] => (Array.isArray(value) ? value : [value]);

const makeLive = (renderFn: () => KitChild | KitChild[], ctx: KitContext): KitElement => {
  const slot = document.createElement("div");
  slot.className = "md-script-ui-live";
  let disposed = false;
  let scheduledFrame: number | null = null;

  const render = () => {
    if (disposed || (ctx.isActive && !ctx.isActive())) return;
    try {
      const nodes = normalizeLiveChildren(renderFn())
        .map((child) => childToNode(child, ctx))
        .filter((node): node is Node => node !== null);
      slot.replaceChildren(...nodes);
    } catch (err) {
      console.error("[ui.live] render threw:", err);
      const error = document.createElement("div");
      error.className = "md-script-ui-error text-red-600 dark:text-red-400";
      error.textContent = err instanceof Error ? err.message : String(err);
      slot.replaceChildren(error);
    }
  };

  const scheduleRender = () => {
    if (disposed || scheduledFrame !== null) return;
    const run = () => {
      scheduledFrame = null;
      render();
    };
    scheduledFrame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : window.setTimeout(run, 0);
  };

  render();

  if (ctx.mode === "edit" && ctx.ytext) {
    const handler = () => scheduleRender();
    ctx.ytext.observe(handler);
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (scheduledFrame !== null) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(scheduledFrame);
        else clearTimeout(scheduledFrame);
        scheduledFrame = null;
      }
      ctx.ytext?.unobserve(handler);
    };
    ctx.registerDisposer?.(dispose);
  }

  return brand(slot, ctx);
};

// =============================================================================
// Factory
// =============================================================================

export const createKitUI = (ctx: KitContext): KitUI => ({
  // Layout
  row: (...children) => makeRow(children, ctx),
  col: (...children) => makeCol(children, ctx),
  card: (...children) => makeCard(children, ctx),
  metric: (label, value, options) => makeMetric(label, value, options, ctx),
  divider: () => makeDivider(ctx),

  // Content
  text: (content) => makeText(content, ctx),
  heading: (content, level) => makeHeading(content, ctx, level),
  md: (mdSrc) => makeMd(mdSrc, ctx),
  noteLink: (note, label) => makeNoteLink(note, label, ctx),
  noteList: (notes, options) => makeNoteList(notes, options, ctx),
  table: (rows, options) => makeTable(rows, options, ctx),
  chart: (kind, options) => makeChart(kind, options, ctx),

  // Interactive
  button: (label, onClick, options) => makeButton(label, onClick, options, ctx),

  // Escape hatch
  html: (rawHtml) => makeHtml(rawHtml, ctx),

  // Mount
  live: (renderFn) => makeLive(renderFn, ctx),
  render: (...elements) => {
    if (ctx.isActive && !ctx.isActive()) return;
    for (const child of elements) {
      const node = childToNode(child, ctx);
      if (node) ctx.outputEl.appendChild(node);
    }
  },

  // Side effect
  toast: (description, options) => {
    if (ctx.isActive && !ctx.isActive()) return;
    platformToast(description, options);
  },
  prompt: createPromptAPI(ctx),
});

// ── Modal prompts — pass-through to the platform `prompts.*` API
// =============================================================================

const createPromptAPI = (ctx: KitContext): KitPromptAPI => ({
  alert: async (message, options) => {
    if (ctx.isActive && !ctx.isActive()) return;
    await prompts.alert(message, { title: options?.title, icon: options?.icon });
  },
  confirm: async (message, options) => {
    if (ctx.isActive && !ctx.isActive()) return false;
    return (await prompts.confirm(message, { title: options?.title, icon: options?.icon })) ?? false;
  },
  text: async (message, defaultValue, options) => {
    if (ctx.isActive && !ctx.isActive()) return null;
    const result = await prompts.form({
      title: options?.title,
      fields: {
        message: {
          type: "info",
          content: message,
        },
        value: {
          type: "text",
          label: false,
          default: defaultValue ?? "",
          placeholder: options?.placeholder,
        },
      },
    });
    return result?.value ?? null;
  },
  form: async (spec: KitFormSpec) => {
    if (ctx.isActive && !ctx.isActive()) return null;
    // Platform `prompts.form` accepts a richer field-type set —
    // we pass our subset through verbatim. The platform handles
    // validation and returns the collected values keyed by the
    // field name (or null if the user cancelled).
    const result = await prompts.form({
      title: spec.title,
      icon: spec.icon,
      confirmText: spec.submitText,
      cancelText: spec.cancelText,
      fields: normalizeFormFields(spec.fields) as never,
    });
    return result as Record<string, unknown> | null;
  },
});

const normalizeFormFields = (fields: Record<string, KitFormField>): Record<string, KitFormField> => {
  const normalized: Record<string, KitFormField> = {};
  for (const [key, field] of Object.entries(fields)) {
    if (field.type === "textarea") {
      normalized[key] = {
        type: "text",
        label: field.label,
        placeholder: field.placeholder,
        required: field.required,
        default: field.default,
        multiline: true,
        lines: field.rows ?? field.lines,
      };
    } else {
      normalized[key] = field;
    }
  }
  return normalized;
};
