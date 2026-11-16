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

/**
 * Inline classic script for the page: one capture listener, before any island script, that remembers each field the
 * person typed into. The `html()` renderer emits it with the island loader.
 */
export const TYPED_INPUT_SCRIPT = `addEventListener("input",e=>{e.isTrusted&&(globalThis.${TYPED}??=new WeakSet).add(e.target)},!0)`;

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

/**
 * After the island rendered: each carried text goes to its counterpart, the field with the same identity at the same
 * place, when the new markup has as many fields of that identity and the counterpart is editable. Otherwise the text is
 * dropped, never given to another field. Returns the counterpart of the field that had focus, and where its selection
 * goes, for the caller to focus.
 */
export const restoreTypedFields = (root: Element, carried: readonly Carried[]): { field: TextField; selection: Selection } | undefined => {
  if (!carried.length) return undefined;
  const fields = textFields(root);
  let focus: { field: TextField; selection: Selection } | undefined;
  for (const { key, index, count, value, server, selection } of carried) {
    const list = fields.get(key);
    const field = list?.length === count ? list[index] : undefined;
    if (!field || field.disabled || field.readOnly) continue;
    const island = field.value;
    // An input takes the typed text. A textarea does too unless the island put other text there itself, such as a
    // restored draft: then the typed text follows it. A field the person emptied stays empty.
    const appended = field.localName === "textarea" && island !== server && island !== "" && value !== "";
    const next = appended ? `${island}\n${value}` : value;
    if (next !== island) {
      field.value = next;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      // A field that keeps its focus changes on blur, as it would have; the others are done.
      if (!selection) field.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (selection) {
      const offset = appended ? island.length + 1 : 0;
      const [start, end, direction] = selection;
      focus = { field, selection: [start === null ? null : start + offset, end === null ? null : end + offset, direction] };
    }
  }
  return focus;
};

/** Focus the counterpart of the focused field with the person's selection. */
export const focusTypedField = ({ field, selection: [start, end, direction] }: { field: TextField; selection: Selection }) => {
  field.focus();
  if (start !== null && end !== null) field.setSelectionRange(start, end, direction ?? undefined);
};
