/**
 * Text a person typed into an island's server markup before the island rendered over it.
 *
 * Islands re-render instead of hydrating, so the browser element the person typed into is replaced. The page records
 * every field that received a trusted `input` event (TYPED_INPUT_SCRIPT, inline before the island loader), and the
 * mount runtime carries only those fields' text to the same field of the new markup. Values the browser restored by
 * itself (form restoration, autofill without an input event) are not the person's typing and stay out.
 */

/** Key of the page's set of fields that received the person's input. */
const TYPED = "__k2bSsrTyped";
/** Key of the field with an input method composition in progress, if any. */
const COMPOSING = "__k2bSsrComposing";

/**
 * Inline classic script that `html()` writes at the start of `<body>`, before any island markup: capture listeners
 * that remember each field the person typed into, and the field with an input method composition in progress.
 */
export const TYPED_INPUT_SCRIPT = `addEventListener("input",e=>{e.isTrusted&&(globalThis.${TYPED}??=new WeakSet).add(e.target)},!0);addEventListener("compositionstart",e=>{globalThis.${COMPOSING}=e.target},!0);addEventListener("compositionend",()=>{globalThis.${COMPOSING}=null},!0)`;

/**
 * Whether a composition (an input method building a character, say for Japanese) runs inside `root`. Rendering over it
 * would cancel the person's unfinished character, so the island waits for `compositionend`.
 */
export const composingIn = (root: Element): boolean => {
  const target = (globalThis as { [COMPOSING]?: unknown })[COMPOSING];
  return target instanceof Node && root.contains(target);
};

type TextField = HTMLInputElement | HTMLTextAreaElement;
type Selection = [start: number | null, end: number | null, direction: TextField["selectionDirection"]];
/** One field's typed text, found by its identity and its place among fields of the same identity. */
type Carried = { key: string; index: number; count: number; value: string; server: string; selection?: Selection };

const TEXT_TYPES = ["text", "search", "email", "url", "tel"];

/** Text fields by identity: tag, type, `name` and `aria-label`, in document order. Password and file fields never take part. */
const textFields = (root: Element): Map<string, TextField[]> => {
  const fields = new Map<string, TextField[]>();
  for (const field of root.querySelectorAll<TextField>("textarea,input")) {
    if (field.localName !== "textarea" && !TEXT_TYPES.includes(field.type)) continue;
    const key = [field.localName, field.type, field.name, field.getAttribute("aria-label") ?? ""].join("\u0000");
    const list = fields.get(key);
    if (list) list.push(field);
    else fields.set(key, [field]);
  }
  return fields;
};

/** Before the island renders: the text typed into its server fields, and the selection of the focused one. */
export const captureTypedFields = (root: Element): Carried[] => {
  const typed = (globalThis as { [TYPED]?: WeakSet<EventTarget> })[TYPED];
  if (!typed) return [];
  const carried: Carried[] = [];
  for (const [key, list] of textFields(root))
    list.forEach((field, index) => {
      if (!typed.has(field) || field.value === field.defaultValue) return;
      carried.push({
        key,
        index,
        count: list.length,
        value: field.value,
        server: field.defaultValue,
        ...(field === document.activeElement
          ? { selection: [field.selectionStart, field.selectionEnd, field.selectionDirection] satisfies Selection }
          : {}),
      });
    });
  return carried;
};

type Focus = { field: TextField; selection: Selection; restored?: string };

/** The text a field gets: the typed value, or for a textarea with text the island put there itself, that text first. */
const merge = (field: TextField, island: string, server: string, value: string): string => {
  if (field.localName !== "textarea" || island === server || island === "") return value;
  // A restored draft stays. What the person added to the server's text follows it on a new line.
  const added = (value.startsWith(server) ? value.slice(server.length) : value).trimStart();
  return added ? `${island}\n${added}` : island;
};

/**
 * After the island rendered: each carried text goes to its counterpart, the field with the same identity at the same
 * place, when the new markup has as many fields of that identity and the counterpart is editable. Otherwise the text is
 * dropped, never given to another field. Returns the counterpart of the field that had focus, where its selection goes,
 * and the text it got, for the caller to focus.
 */
export const restoreTypedFields = (root: Element, carried: readonly Carried[]): Focus | undefined => {
  if (!carried.length) return undefined;
  const fields = textFields(root);
  let focus: Focus | undefined;
  for (const { key, index, count, value, server, selection } of carried) {
    const list = fields.get(key);
    const field = list?.length === count ? list[index] : undefined;
    if (!field || field.disabled || field.readOnly) continue;
    const island = field.value;
    const next = merge(field, island, server, value);
    const changed = next !== island;
    if (changed) {
      field.value = next;
      // Like a browser's own replacement of the text, so handlers that read `inputType` work.
      field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }));
      // A field without focus is done, as if the person had left it.
      if (!selection) field.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (selection) {
      // The selection keeps its distance to the end of the typed text, which stays at the end of the field.
      const [start, end, direction] = selection;
      const place = (at: number | null) => (at === null ? null : Math.max(0, next.length - (value.length - at)));
      focus = { field, selection: [place(start), place(end), direction], ...(changed ? { restored: next } : {}) };
    }
  }
  return focus;
};

/**
 * Focus the counterpart of the focused field with the person's selection. Its value was set before the focus, so the
 * browser would not report a change on leaving it: if the person leaves it unchanged, `change` follows then.
 */
export const focusTypedField = ({ field, selection: [start, end, direction], restored }: Focus) => {
  field.focus();
  if (start !== null && end !== null) field.setSelectionRange(start, end, direction ?? undefined);
  if (restored !== undefined)
    field.addEventListener(
      "blur",
      () => {
        if (field.value === restored) field.dispatchEvent(new Event("change", { bubbles: true }));
      },
      { once: true },
    );
};
