export type DescribeV2Options = {
  /**
   * The page is laid out (a real browser): parts without a box are reported as hidden at this width instead of being
   * described, and a table names the columns it dropped. Leave it off for markup without layout, such as a DOM built
   * from server-rendered HTML.
   */
  layout?: boolean;
};

/**
 * A short text outline of a v2 screen, read from the `data-k2-part` marks of the primitives: which parts stand where,
 * what they say, how many rows a list or table has, and the problems a person would see (an element no primitive
 * owns, loose text, a group in a group, two primary buttons). It costs a few hundred tokens and needs no picture, so
 * an agent reads it after every change and asks for a screenshot only when the outline leaves a doubt.
 *
 * The function is self-contained (no imports, no outer names), so a test can also run it inside a browser page:
 * `await page.evaluate(\`(${describeV2})(document.body, { layout: true })\`)`.
 */
export function describeV2(root: Element, options: DescribeV2Options = {}): string {
  // Parts that always get their own line; the others are words in the line of the part around them.
  const blocks = new Set([
    "Workspace",
    "Pane",
    "Pane.Split",
    "Back",
    "Bar",
    "StatusRow",
    "FilterBar",
    "Nav",
    "Band",
    "Cells",
    "Tiles",
    "Section",
    "Group",
    "List",
    "Digest",
    "Digest.Entry",
    "Row",
    "Table",
    "Facts",
    "Notice",
    "Prose",
    "Canvas",
    "Field.Row",
    "Field",
    "Disclosure",
    "Toast",
    "Empty",
    "Loading",
    "Failed",
  ]);
  // Parts that get their own line when they stand in the flow of a column, and are words inside a bar or a row.
  const flowBlocks = new Set(["Text", "Inline", "Tabs", "Check", "Choice", "Progress", "Button", "Steps", "Path"]);
  const flow = new Set(["Pane", "Band", "Section", "Group", "Workspace"]);
  // Containers whose children must be primitives (rule 3: fixed places instead of free children).
  const containers: Record<string, string> = {
    "k2-scroll": "Pane",
    "k2-ws-main": "Workspace",
    "k2-split": "Pane.Split",
    "k2-list": "List",
    "k2-group": "Group",
    "k2-group-body": "Group",
    "k2-disc-body": "Disclosure",
    "k2-sec": "Section",
    "k2-band": "Band",
  };
  const ownedChild = (child: Element) =>
    child.hasAttribute("data-k2-part") ||
    child.hasAttribute("data-slot") ||
    [...child.classList].some((name) => name.startsWith("k2-")) ||
    /^(?:SCRIPT|TEMPLATE)$/.test(child.tagName);

  const lines: string[] = [];
  const problems: string[] = [];
  const clip = (text: string, max = 60) => {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  };
  const quote = (text: string | null | undefined, max?: number) => (text && text.trim() ? `"${clip(text, max)}"` : "");
  const part = (element: Element | null) => element?.getAttribute("data-k2-part") ?? "";
  const partOf = (element: Element): Element | null => element.parentElement?.closest("[data-k2-part]") ?? null;
  const hidden = (element: Element) => options.layout === true && element.getClientRects().length === 0;
  const textOf = (element: Element | null | undefined) => clip(element?.textContent ?? "");
  /** Stands directly in the flow of a column, not in a head, a bar or a row. */
  const inFlow = (element: Element) => {
    const parent = element.parentElement;
    if (!parent) return false;
    if (parent.classList.contains("k2-scroll") || parent.classList.contains("k2-ws-main") || parent.hasAttribute("data-slot")) return true;
    // the content of an open folded group, and of an open disclosure, stands in their flow
    if (parent.classList.contains("k2-group-body") || parent.classList.contains("k2-disc-body")) return true;
    return flow.has(part(parent));
  };
  const isLine = (element: Element) => {
    const name = part(element);
    if (blocks.has(name)) return true;
    return flowBlocks.has(name) && inFlow(element);
  };
  /** The text of an element without the quiet extras inside it (a hint, a count). */
  const mainText = (element: Element | null | undefined, skip = "small, .k2-tab-count, .k2-sec-link-meta") => {
    if (!element) return "";
    let text = "";
    for (const node of element.childNodes) {
      if (node.nodeType === 1 && (node as Element).matches(skip)) continue;
      text += node.textContent ?? "";
    }
    return clip(text);
  };
  const flags = (element: Element, names: readonly string[]) =>
    names.filter((name) => element.hasAttribute(`data-${name}`)).map((name) => name);

  /** The words a part contributes to the line of the part around it. */
  const word = (element: Element): string => {
    const name = part(element);
    if (name === "Button") {
      // The label only: an avatar's initials in the button are no part of its name.
      const label = element.getAttribute("aria-label") ?? textOf(element.querySelector(".k2-btn-label") ?? element);
      const variant = element.getAttribute("data-variant");
      const busy = element.getAttribute("aria-busy") === "true";
      const disabled = element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
      return `[${quote(label, 40)}${variant ? ` ${variant}` : ""}${element.hasAttribute("data-menu") ? " menu" : ""}${element.tagName === "A" ? " link" : ""}${busy ? " busy" : disabled ? " disabled" : ""}${element.getAttribute("aria-pressed") === "true" ? " pressed" : ""}]`;
    }
    if (name === "Chip") {
      const kind = element.getAttribute("data-status") ?? element.getAttribute("data-kind");
      return `(${clip(element.textContent ?? "", 30)}${kind && kind !== "plain" ? ` · ${kind}` : ""})`;
    }
    if (name === "Avatar") return `@${element.getAttribute("aria-label") ?? ""}${element.hasAttribute("data-image") ? " picture" : ""}`;
    if (name === "Icon") return element.getAttribute("aria-label") ? `icon ${quote(element.getAttribute("aria-label"))}` : "";
    if (name === "Text") {
      const type = element.getAttribute("data-type");
      const tone = element.getAttribute("data-tone");
      return `${quote(element.textContent, 50)}${type && type !== "row" ? ` ${type}` : ""}${tone ? ` ${tone}` : ""}`;
    }
    if (name === "Tabs") {
      const tabs = [...element.querySelectorAll(".k2-tab")].map((tab) => {
        const count = tab.querySelector(".k2-tab-count")?.textContent;
        return `${mainText(tab)}${count ? ` (${count})` : ""}${tab.getAttribute("aria-current") ? " ✓" : ""}`;
      });
      return `Tabs ${quote(element.getAttribute("aria-label"))}: ${tabs.join(", ")}`;
    }
    if (name === "RecordHead") {
      // The identifiers stand beside the name, in the same place (its kinds are chips and name themselves).
      const ids = [...(element.parentElement?.querySelectorAll(":scope > .k2-record-id") ?? [])].map((id) =>
        clip(id.textContent ?? "", 30),
      );
      return `RecordHead ${quote(element.textContent)}${ids.length ? ` ids: ${ids.join(" · ")}` : ""}`;
    }
    if (name === "Path")
      return `Path: ${[...element.querySelectorAll("a, b")].map((step) => clip(step.textContent ?? "", 24)).join(" › ")}`;
    if (name === "Steps")
      return `Steps ${quote(element.getAttribute("aria-label"))}: ${[...element.querySelectorAll(".k2-step")]
        .map((step) => `${clip(step.querySelector(".k2-step-label")?.textContent ?? "", 20)} ${step.getAttribute("data-state")}`)
        .join(" → ")}`;
    if (name === "Toast") return `Toast ${quote(element.textContent)}`;
    if (name === "Input" || name === "Select" || name === "DateInput") {
      const control = element.querySelector("input, textarea, select");
      // A select without a choice shows its placeholder in the value's place, marked `data-placeholder`.
      const shownValue = element.querySelector(".k2-input-value");
      const value =
        name === "Select"
          ? shownValue?.hasAttribute("data-placeholder")
            ? ""
            : shownValue?.textContent
          : ((control as HTMLInputElement | null)?.value ?? control?.getAttribute("value"));
      const placeholder = name === "Select" ? shownValue?.textContent : control?.getAttribute("placeholder");
      return `${name}${value ? ` ${quote(value, 40)}` : placeholder ? ` placeholder ${quote(placeholder, 40)}` : " empty"}${element.hasAttribute("data-invalid") ? " invalid" : ""}${element.hasAttribute("data-disabled") ? " disabled" : ""}`;
    }
    if (name === "CodeInput") {
      const control = element.querySelector("input") as HTMLInputElement | null;
      const value = control?.value ?? control?.getAttribute("value") ?? "";
      return `CodeInput ${value.length}/${control?.getAttribute("maxlength") ?? "?"}${element.hasAttribute("data-invalid") ? " invalid" : ""}${element.hasAttribute("data-disabled") ? " disabled" : ""}`;
    }
    if (name === "TagsInput") {
      const tags = [...element.querySelectorAll(":scope > .k2-chip")].map((chip) => clip(chip.textContent ?? "", 24));
      const placeholder = element.querySelector("input")?.getAttribute("placeholder");
      return `TagsInput${tags.length ? `: ${tags.join(", ")}` : placeholder ? ` placeholder ${quote(placeholder, 40)}` : " empty"}${element.hasAttribute("data-invalid") ? " invalid" : ""}${element.hasAttribute("data-disabled") ? " disabled" : ""}`;
    }
    if (name === "Slider") {
      const value =
        element.querySelector(".k2-slider-value")?.textContent ||
        (element.querySelector("input[type=range]") as HTMLInputElement | null)?.value;
      return `Slider ${quote(value ?? "", 20)}${element.hasAttribute("data-disabled") ? " disabled" : ""}`;
    }
    if (name === "ColorInput") {
      const code = element.querySelector(".k2-color-head input") as HTMLInputElement | null;
      const swatches = element.querySelectorAll(".k2-color-preset").length;
      return `ColorInput ${quote(code?.value ?? code?.getAttribute("value") ?? "", 20)}${swatches ? ` · ${swatches} swatches` : ""}${element.hasAttribute("data-disabled") ? " disabled" : ""}`;
    }
    if (name === "ImageInput") {
      const button = element.querySelector(".k2-image-end > .k2-btn .k2-btn-label");
      return `ImageInput ${element.querySelector(".k2-image-preview > img") ? "picture" : "empty"} [${clip(button?.textContent ?? "", 30)}]`;
    }
    if (name === "Progress")
      return `Progress ${element.getAttribute("aria-valuenow")}/${element.getAttribute("aria-valuemax")}${element.getAttribute("aria-label") ? ` ${quote(element.getAttribute("aria-label"))}` : ""}`;
    if (name === "Check") {
      const input = element.querySelector("input");
      // Mixed is the input's `indeterminate` in a browser; in server markup only the mark's minus says so.
      const mixed =
        input?.getAttribute("aria-checked") === "mixed" ||
        (input as HTMLInputElement | null)?.indeterminate === true ||
        !!element.querySelector("[data-k2-mark] [data-name='minus']");
      const state = mixed ? "mixed" : (input as HTMLInputElement | null)?.checked || input?.hasAttribute("checked") ? "on" : "off";
      return `${element.hasAttribute("data-switch") ? "Switch" : "Check"} ${quote(element.textContent)} ${state}${element.hasAttribute("data-disabled") ? " disabled" : ""}`;
    }
    if (name === "Choice") {
      const options = [...element.querySelectorAll("label")].map((label) => {
        const input = label.querySelector("input") as HTMLInputElement | null;
        return `${clip(label.textContent ?? "", 20)}${input?.checked || input?.hasAttribute("checked") ? " ✓" : ""}`;
      });
      // A choice in a field is named by the field's label; alone it names itself.
      const label = element.getAttribute("aria-label");
      const disabled = element.getAttribute("aria-disabled") === "true" ? " disabled" : "";
      return `Choice${label ? ` ${quote(label)}` : ""}${disabled}: ${options.join(", ")}`;
    }
    if (name === "Inline") return words(element).join(" ");
    if (name === "Nav.Item" || name === "Digest.Entry" || name === "Cells.Cell") return quote(element.textContent);
    return name;
  };

  /** The words of the parts inside `element` that have no line of their own. */
  const words = (element: Element): string[] => {
    const found: string[] = [];
    const walk = (node: Element) => {
      for (const child of node.children) {
        if (child.hasAttribute("data-k2-part")) {
          if (isLine(child) || hidden(child)) continue;
          const text = word(child);
          if (text) found.push(text);
          // A word sums up its own content.
          continue;
        }
        walk(child);
      }
    };
    walk(element);
    return found;
  };

  /** The one line of a block part. */
  const describe = (element: Element): string => {
    const name = part(element);
    const label = element.getAttribute("aria-label");
    const rest = () => words(element);
    switch (name) {
      case "Workspace": {
        const slots = [
          element.querySelector(":scope > .k2-ws-side") ? "sidebar" : "",
          element.querySelector(":scope > .k2-ws-main > [data-slot=head]") ? "head" : "",
        ].filter(Boolean);
        const fab = element.querySelector(":scope > .k2-fab");
        return `Workspace${slots.length ? ` (${slots.join(", ")})` : ""}${fab ? ` primary ${quote(fab.textContent)}` : ""}`;
      }
      case "Pane": {
        const width = (element as HTMLElement).style?.getPropertyValue?.("--k2-pane-w");
        const min = (element as HTMLElement).style?.getPropertyValue?.("--k2-pane-min");
        return `Pane${label ? ` ${quote(label)}` : ""}${flags(element, ["detail", "side"])
          .map((flag) => ` ${flag}`)
          .join("")}${width ? ` width ${min || "?"}–${width}` : ""}`;
      }
      case "Back": {
        // the way back of a detail on the phone: its words, and whether it leads by its address
        const button = element.querySelector("[data-k2-part='Button']");
        return `Back ${quote(button?.getAttribute("aria-label") ?? button?.textContent)}${button?.tagName === "A" ? " link" : ""}`;
      }
      case "FilterBar": {
        // the statements as they read, whether the state differs from its view, and whether views can be saved
        const statements = [...element.querySelectorAll(".k2-fbar-flow [data-k2-part='Statement'] > .k2-stmt-b")].map((words) =>
          quote(words.textContent, 50),
        );
        const reset = element.querySelector(".k2-fbar-reset") ? " · reset" : "";
        const views = element.querySelector(".k2-fbar-end") ? " | view menu" : "";
        return `FilterBar: ${statements.join(" and ") || "no filters"}${reset}${views}`;
      }
      case "Bar":
      case "StatusRow": {
        const start = element.querySelector(":scope > .k2-bar-start");
        const end = element.querySelector(":scope > .k2-bar-end");
        if (name === "StatusRow") {
          const lead = element.querySelector(".k2-status-lead")?.textContent;
          const facts = [...element.querySelectorAll(".k2-fact")].map((fact) => clip(fact.textContent ?? "", 30));
          const select = element.querySelector(".k2-mark, [data-k2-mark]") ? " select-all" : "";
          if (element.hasAttribute("data-selecting")) return `StatusRow selecting ${quote(lead)}: ${start ? words(start).join(" ") : ""}`;
          return `StatusRow ${quote(lead)}${facts.length ? ` · ${facts.join(" · ")}` : ""}${select}${end ? ` | ${words(end).join(" ")}` : ""}`;
        }
        const startWords = start ? words(start) : [];
        const endWords = end ? words(end) : [];
        return `Bar: ${startWords.join(" ") || "–"}${endWords.length ? ` | ${endWords.join(" ")}` : ""}`;
      }
      case "Nav": {
        const items = [...element.querySelectorAll("[data-k2-part='Nav.Item']")];
        const current = items.find((item) => item.getAttribute("aria-current"));
        return `Nav ${quote(label)}: ${items.length} entries${current ? `, current ${quote(current.querySelector(".k2-ni-name")?.textContent)}` : ""}`;
      }
      case "Band": {
        const tone = element.getAttribute("data-tone");
        return `Band${tone ? ` ${tone}` : ""}${label ? ` ${quote(label)}` : ""}${rest().length ? `: ${rest().join(" ")}` : ""}`;
      }
      case "Cells": {
        const cells = [...element.querySelectorAll("[data-k2-part='Cells.Cell']")].map(
          (cell) =>
            `${clip(cell.querySelector(".k2-cell-label")?.textContent ?? "", 24)} = ${clip(cell.querySelector(".k2-cell-value")?.textContent ?? "", 24)}`,
        );
        return `Cells: ${cells.join(" · ")}`;
      }
      case "Tiles": {
        const tiles = [...element.querySelectorAll(".k2-tile-title")].map((tile) => clip(tile.textContent ?? "", 30));
        return `Tiles ${tiles.length}: ${tiles.join(", ")}${rest().length ? ` ${rest().join(" ")}` : ""}`;
      }
      case "Section":
      case "Group": {
        const head = element.querySelector(name === "Section" ? ":scope > .k2-sh" : ":scope > .k2-gh");
        const title = head?.querySelector(name === "Section" ? "h3" : ".k2-gh-title")?.childNodes[0]?.textContent;
        const count = head?.querySelector(".k2-sh-count, .k2-gh-count")?.textContent;
        const meta = head?.querySelector(".k2-gh-meta")?.textContent;
        const summary = element.querySelector(":scope > .k2-sec-summary")?.textContent;
        const more = mainText(element.querySelector(":scope > .k2-sec-link"));
        const headWords = head ? words(head) : [];
        return `${name} ${quote(title)}${count ? ` (${count})` : ""}${element.hasAttribute("data-folded") ? " folded" : ""}${meta ? ` · ${clip(meta, 40)}` : ""}${headWords.length ? ` ${headWords.join(" ")}` : ""}${summary ? ` — ${quote(summary)}` : ""}${more ? ` → ${quote(more, 40)}` : ""}`;
      }
      case "List":
      case "Digest":
        return `${name}${label ? ` ${quote(label)}` : ""}: ${element.querySelectorAll(name === "List" ? ":scope > [data-k2-part='Row']" : ":scope > [data-k2-part]").length} entries`;
      case "Row": {
        const lineTexts = [".k2-row-title", ".k2-row-l2", ".k2-row-l3"]
          .map((selector) => element.querySelector(`:scope > .k2-row-l1 > ${selector}, :scope > ${selector}`)?.textContent)
          .filter((text): text is string => !!text?.trim())
          .map((text) => quote(text, 44));
        const time = element.querySelector(":scope > .k2-row-time")?.textContent;
        const meta = element.querySelector(".k2-row-meta")?.textContent;
        const lead = element.querySelector(":scope > .k2-row-lead [data-k2-part]");
        const leadWord = lead && part(lead) === "Avatar" ? ` @${lead.getAttribute("aria-label")}` : "";
        const state = flags(element, ["unread", "current", "selected", "yours", "strong"]);
        const opens = element.tagName === "A" ? " opens link" : element.tagName === "BUTTON" ? " opens" : "";
        const tail = [...element.querySelectorAll(":scope > .k2-row-end, :scope > .k2-row-marks")].flatMap(words);
        return `Row${leadWord} ${lineTexts.join(" / ")}${meta ? ` (${clip(meta, 20)})` : ""}${time ? ` · ${clip(time, 20)}` : ""}${state.length ? ` [${state.join(", ")}]` : ""}${opens}${tail.length ? ` ${tail.join(" ")}` : ""}`;
      }
      case "Table": {
        const table = element.querySelector("table");
        const heads = [...element.querySelectorAll("thead th:not([data-select])")];
        const groups = element.querySelectorAll("tbody > tr[data-group]").length;
        const extras = [
          element.querySelector("thead th[data-select]") ? "select" : "",
          groups ? `${groups} groups` : "",
          element.querySelector("[data-sticky]") ? "sticky" : "",
          element.nextElementSibling?.classList.contains("k2-table-phone") ? "phone rows" : "",
        ].filter(Boolean);
        const columns = heads.map((th) => {
          const sorted = th.getAttribute("aria-sort");
          const notes = [
            th.getAttribute("data-align") === "end" ? "end" : "",
            th.hasAttribute("data-drop") ? "drops on phone" : "",
            sorted ? `sorted ${sorted}` : th.querySelector(".k2-th-sort") ? "sorts" : "",
          ].filter(Boolean);
          return `${clip(th.textContent ?? "", 20)}${notes.length ? ` (${notes.join(", ")})` : ""}`;
        });
        const dropped =
          options.layout && !(table && hidden(table)) ? heads.filter((th) => hidden(th)).map((th) => clip(th.textContent ?? "", 20)) : [];
        // While it loads, placeholder rows hold the place of the rows: they are counted apart.
        const rows = element.querySelectorAll("tbody > tr:not([data-group]):not([data-loading])").length;
        const placeholders = element.querySelectorAll("tbody > tr[data-loading]").length;
        const loading = table?.getAttribute("aria-busy") === "true" ? ` loading (${placeholders} placeholder rows)` : "";
        const wrap = element.querySelector("[data-wrap]") ? " wrap" : "";
        return `Table ${quote(table?.getAttribute("aria-label"))} ${heads.length} columns × ${rows} rows${loading}${wrap}${extras.length ? ` (${extras.join(", ")})` : ""}: ${columns.join(", ")}${dropped.length ? ` — hidden at this width: ${dropped.join(", ")}` : ""}`;
      }
      case "Facts": {
        const labels = [...element.querySelectorAll("dt")].map(
          (dt) => `${clip(dt.textContent ?? "", 20)}: ${clip(mainText(dt.nextElementSibling), 28)}`,
        );
        const end = element.querySelector(":scope > .k2-facts-end");
        return `Facts${element.hasAttribute("data-inline") ? " inline" : ""}: ${labels.join(" · ")}${element.querySelector(":scope > .k2-btn") ? " (copy)" : ""}${end ? ` ${words(end).join(" ")}` : ""}`;
      }
      case "Notice": {
        const title = element.querySelector(".k2-notice-title")?.textContent;
        const text = element.querySelector(".k2-notice-text")?.textContent;
        const end = element.querySelector(".k2-notice-end");
        return `Notice ${element.getAttribute("data-tone")}${title ? ` ${quote(title, 40)}` : ""}: ${quote(text)}${end ? ` ${words(end).join(" ")}` : ""}`;
      }
      case "Prose": {
        const paragraphs = [...element.querySelectorAll("p, li, h1, h2, h3, h4")];
        const text = paragraphs.length ? paragraphs.map((paragraph) => paragraph.textContent ?? "").join(" ") : element.textContent;
        return `Prose ${quote(text, 50)}${paragraphs.length > 1 ? ` (${paragraphs.length} blocks)` : ""}`;
      }
      case "Canvas": {
        const height = (element as HTMLElement).style?.getPropertyValue?.("--k2-canvas-h");
        return `Canvas ${quote(label)}${height ? ` ${height}` : ""} (free drawing, not measured)`;
      }
      case "Field": {
        const fieldLabel = element.querySelector(":scope > .k2-field-label")?.childNodes[0]?.textContent;
        const message = element.querySelector(":scope > .k2-field-message");
        const control = words(element).join(" ");
        return `Field ${quote(fieldLabel)}: ${control || "no control"}${message ? ` — ${message.hasAttribute("data-error") ? "error" : "hint"} ${quote(message.textContent)}` : ""}`;
      }
      case "Field.Row":
        return "Field.Row";
      case "Disclosure": {
        const head = element.querySelector(":scope > .k2-disc-head");
        return `Disclosure ${quote(head?.textContent)} ${head?.getAttribute("aria-expanded") === "true" ? "open" : "closed"}`;
      }
      // The three states of a place that shows data, where the data will stand.
      case "Empty":
      case "Failed": {
        const text = element.querySelector(".k2-state-text")?.textContent;
        const button = element.querySelector("[data-k2-part='Button']");
        return `${name} ${quote(text)}${button ? ` ${word(button)}` : ""}`;
      }
      case "Loading": {
        const rows = element.querySelectorAll(":scope > .k2-row");
        return `Loading ${rows.length} placeholder rows of ${rows[0]?.getAttribute("data-lines") ?? "1"} lines`;
      }
      case "Digest.Entry": {
        const text = (selector: string) => clip(element.querySelector(selector)?.textContent ?? "", 50);
        return `Entry ${text(".k2-digest-date")} ${quote(text(".k2-row-l1"))} (${text(".k2-digest-state")}): ${quote(text(".k2-digest-text"))}${element.tagName === "A" ? " opens link" : ""}`;
      }
      default:
        return word(element);
    }
  };

  const checkChildren = (element: Element) => {
    // A digest is drawn as a list; name it as what it is.
    const owner = element.classList.contains("k2-digest") ? "Digest" : [...element.classList].map((name) => containers[name]).find(Boolean);
    if (!owner) return;
    const where =
      owner === "Pane" ? `Pane ${quote(element.closest("[data-k2-part='Pane']")?.getAttribute("aria-label")) || ""}`.trim() : owner;
    for (const node of element.childNodes) {
      if (node.nodeType === 3 && node.textContent?.trim() && owner !== "Band")
        problems.push(`loose text ${quote(node.textContent, 30)} in ${where}: put it in <Text> or <Notice>`);
      if (node.nodeType === 3 && node.textContent?.trim() && owner === "Band")
        problems.push(`loose text ${quote(node.textContent, 30)} in Band: put it in <Text>`);
      if (node.nodeType !== 1) continue;
      const child = node as Element;
      if (ownedChild(child)) continue;
      problems.push(
        `plain <${child.tagName.toLowerCase()}> in ${where} ${quote(child.textContent, 30)}: no primitive owns it; use Band, Section, Group, List, Table, Notice or Text`,
      );
    }
  };

  const visit = (element: Element, depth: number) => {
    // A table's phone form and the table never show together; the one out of sight is no part of this width.
    // Without layout the phone form is only named in the table's line.
    if (element.classList.contains("k2-table-phone") && (!options.layout || hidden(element))) return;
    if (options.layout && part(element) === "Table" && hidden(element)) return;
    checkChildren(element);
    let next = depth;
    if (element.hasAttribute("data-k2-part") && isLine(element)) {
      const name = part(element);
      const slot = element.parentElement?.getAttribute("data-slot");
      if (hidden(element)) {
        lines.push(`${"  ".repeat(depth)}${slot ? `${slot}: ` : ""}${name} (hidden at this width)`);
        return;
      }
      lines.push(`${"  ".repeat(depth)}${slot ? `${slot}: ` : ""}${describe(element)}`);
      next = depth + 1;
      if (name === "Group" && element.parentElement?.closest("[data-k2-part='Group']"))
        problems.push(`Group ${quote(element.getAttribute("aria-label"))} stands in another Group: groups are never nested`);
      else if (name === "Group" && part(partOf(element)) === "Band")
        problems.push(
          `Group ${quote(element.getAttribute("aria-label"))} stands in a Band: put groups in a Section or directly in the Pane`,
        );
      // A table that is wider than its column cuts columns off at the edge; only a large table scrolls sideways.
      if (name === "Table" && options.layout && !element.hasAttribute("data-grid")) {
        const cut = element.scrollWidth - element.clientWidth;
        if (cut > 1)
          problems.push(
            `Table ${quote(element.querySelector("table")?.getAttribute("aria-label"))} is ${Math.round(cut)} px wider than its column at this width, so its last columns are cut off: give it \`phone(row)\`, \`drop\` more columns, or narrow the widths`,
          );
      }
      if (name === "Button")
        problems.push(
          `Button ${quote(element.getAttribute("aria-label") ?? element.textContent, 30)} stands alone in ${part(partOf(element))} and takes its full width: put actions in a Bar end, a Row action, Section/Group actions or Notice actions`,
        );
      // Rows of a long list: the first three, then a count.
      if (name === "List" || name === "Digest") {
        const entries = [...element.children].filter((child) => child.hasAttribute("data-k2-part"));
        entries.slice(0, 3).forEach((entry) => visit(entry, next));
        if (entries.length > 3) lines.push(`${"  ".repeat(next)}… ${entries.length - 3} more`);
        for (const child of element.children) if (!child.hasAttribute("data-k2-part")) visit(child, next);
        return;
      }
      // "Erneut versuchen" stands only in place of data that failed to load once; a connection that retries on its
      // own says so in the status row without a button, and what a person must fix is a Notice that names the deed.
      if (name === "Failed" && element.closest("[data-k2-part='StatusRow'], [data-k2-part='Bar']"))
        problems.push(
          `Failed ${quote(element.querySelector(".k2-state-text")?.textContent, 30)} stands in a bar: Failed replaces the data that did not load; a connection that retries on its own says so in the StatusRow without a button`,
        );
      if (
        name === "Canvas" ||
        name === "Table" ||
        name === "Prose" ||
        name === "Nav" ||
        name === "Facts" ||
        name === "Tiles" ||
        name === "Empty" ||
        name === "Failed" ||
        name === "Loading"
      )
        return;
    }
    for (const child of element.children) visit(child, next);
  };

  for (const child of root.matches("[data-k2-part]") ? [root] : [...root.children]) visit(child, 0);

  // One primary action per surface: the page, and each open dialog or sheet above it, which has its own (such as
  // "Erstellen" in a dialog over a page whose head creates the thing).
  const surfaces = "dialog, [role='dialog'], [role='alertdialog'], [data-k2-part='Dialog']";
  const surfaceOf = (element: Element) => {
    const surface = element.closest(surfaces);
    return surface && root.contains(surface) ? surface : root;
  };
  const surfaceName = (surface: Element) => {
    const labelledBy = surface.getAttribute("aria-labelledby");
    const title =
      surface.getAttribute("aria-label") ??
      (labelledBy ? surface.ownerDocument.getElementById(labelledBy)?.textContent : undefined) ??
      surface.querySelector(".k2-dialog-title")?.textContent;
    return `dialog${title ? ` ${quote(title, 30)}` : ""}`;
  };
  const allPrimaries = [...root.querySelectorAll("[data-k2-part='Button'][data-variant='primary'], .k2-fab")];
  const shownPrimaries = allPrimaries.filter((button) => (options.layout ? !hidden(button) : !button.classList.contains("k2-fab")));
  const bySurface = new Map<Element, Element[]>([[root, []]]);
  for (const button of shownPrimaries) {
    const surface = surfaceOf(button);
    bySurface.set(surface, [...(bySurface.get(surface) ?? []), button]);
  }
  if (
    options.layout &&
    !bySurface.get(root)!.length &&
    allPrimaries.some((button) => surfaceOf(button) === root && !button.classList.contains("k2-fab"))
  )
    problems.push("the primary action is hidden at this width: give Workspace a `primary` action so the phone shows it");
  for (const [surface, primaries] of bySurface)
    if (primaries.length > 1)
      problems.push(
        `${primaries.length} primary buttons ${surface === root ? "" : `in ${surfaceName(surface)} `}(${primaries.map((button) => quote(button.textContent, 24)).join(", ")}): one primary action per ${surface === root ? "page" : "dialog"}; make the others secondary`,
      );
  // Cut text a person sees: a control's label that does not fit its control, a line of a three-line row that wraps.
  if (options.layout) {
    for (const control of root.querySelectorAll(".k2-btn, .k2-chip, .k2-tab")) {
      if (hidden(control)) continue;
      const box = control.getBoundingClientRect();
      const label = control.querySelector(".k2-btn-label") ?? control;
      if (label.scrollWidth > label.clientWidth + 1 || label.getBoundingClientRect().right > box.right + 0.5)
        problems.push(
          `${part(control) || "control"} ${quote(control.getAttribute("aria-label") ?? control.textContent, 30)} cuts its label: give it the room of its whole label`,
        );
    }
    for (const line of root.querySelectorAll(".k2-row[data-lines='3'] > :is(.k2-row-l1, .k2-row-l2, .k2-row-l3)")) {
      if (hidden(line)) continue;
      const height = Number.parseFloat(getComputedStyle(line).lineHeight);
      if (height > 0 && line.getBoundingClientRect().height > height * 1.5)
        problems.push(`a line of a three-line Row wraps: ${quote(line.textContent, 30)}; each line stays on one line and ends with "…"`);
    }
  }
  // The floating main action of the phone must not cover a control at the end of the page.
  const fab = options.layout ? [...root.querySelectorAll(".k2-fab")].find((button) => !hidden(button)) : undefined;
  if (fab) {
    const box = fab.getBoundingClientRect();
    // Fields and the buttons of a bar in the content (a form's footer): rows and their buttons slide under it while the
    // list scrolls, which is fine.
    const covered = [...root.querySelectorAll(".k2-btn, input:not(.k2-mark-input), select, textarea")].filter((control) => {
      if (control === fab || fab.contains(control) || hidden(control)) return false;
      const bar = control.closest("[data-k2-part='Bar'], [data-k2-part='Field']");
      if (control.classList.contains("k2-btn") && (part(bar) !== "Bar" || bar?.parentElement?.hasAttribute("data-slot"))) return false;
      const other = control.getBoundingClientRect();
      return other.right > box.left && other.left < box.right && other.bottom > box.top && other.top < box.bottom;
    });
    if (covered.length)
      problems.push(
        `the floating main action ${quote(fab.textContent, 24)} covers ${covered.map((control) => quote(control.getAttribute("aria-label") ?? control.textContent, 24) || `<${control.tagName.toLowerCase()}>`).join(", ")} at this width: a form or dialog belongs on its own page (route) on the phone`,
      );
  }
  if (!lines.length) problems.push("no v2 part found: render the screen inside an element with the class k2-ui");
  if (problems.length) lines.push("", `Problems (${problems.length}):`, ...problems.map((problem) => `- ${problem}`));
  return lines.join("\n");
}
