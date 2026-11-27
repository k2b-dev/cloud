import { createRenderEffect, createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js";
import { addressKey, scanAddresses } from "./addresses";
import { type ChoiceItem, useCombobox } from "./behavior/select";
import { useControlMessages } from "./control-messages";
import { useField } from "./controls";
import { Icon } from "./marks";

export type TagsInputProps = {
  /** The values, in their order. With `onChange` the caller holds them; without, the field keeps them. */
  value?: readonly string[];
  onChange?: (values: string[]) => void;
  /** Values to pick from while typing; any other text becomes a value too, on Enter. */
  suggestions?: readonly string[];
  placeholder?: string;
  /** The name the values are sent under, one entry each; the field's name by default. */
  name?: string;
  /** A name when the field stands without a Field. */
  label?: string;
  disabled?: boolean;
  /**
   * `email`: e-mail addresses, as the To of a message. A comma, a semicolon or a new line ends an address too, a
   * paste of several becomes several chips (`Name <address>` and `"Berg, Anna" <address>` as well), and a text that is
   * no address stays in the field with a sentence why, and keeps the form from being sent. A value is the address in
   * the form it was given (`Name <address>`); the same address twice, in any case, is one chip. The phone shows its
   * keyboard for addresses.
   */
  type?: "email";
  /** How many values the field takes; more are not added, and a sentence says so. With `email` 200 (one To of Mail). */
  max?: number;
};

/**
 * Several short values, such as domains or server addresses: each a chip with its remove button, typed into the field
 * after them; Enter adds the text, Backspace in an empty field takes the last chip back (the behaviour layer on the
 * ui-sdk core). The field grows by a line when the chips need one.
 */
export const TagsInput = (props: TagsInputProps) => {
  const field = useField();
  const t = useControlMessages();
  const [own, setOwn] = createSignal<string[]>([...(props.value ?? [])]);
  const values = () => (props.onChange ? [...(props.value ?? [])] : own());
  const email = () => props.type === "email";
  // the text being typed; with `email` it is held here, so a separator or a paste can turn it into chips
  const [query, setQuery] = createSignal("");
  // What the field says under its chips: a text that is no address (it keeps the form from being sent) and values it
  // left out over `max`, each a sentence of its own; and what assistive technology hears of a change.
  const [refused, setRefused] = createSignal<string>();
  const [overflow, setOverflow] = createSignal<string>();
  const [heard, setHeard] = createSignal("");
  const rejected = () => refused() !== undefined;
  const noticeId = createUniqueId();
  // a status says each change, also the same words twice: it is emptied first, so the new words are a change
  const say = (words: string) => {
    setHeard("");
    queueMicrotask(() => setHeard(words));
  };
  const max = () => props.max ?? (email() ? 200 : Number.POSITIVE_INFINITY);
  const keyOf = (value: string) => (email() ? addressKey(value) : value);
  // the values as the field holds them: trimmed, each once, at most `max` (for every kind of value)
  const commit = (next: string[]) => {
    const seen = new Set<string>();
    const clean = next
      .map((value) => value.trim())
      .filter((value) => {
        const key = keyOf(value);
        if (!value || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const kept = clean.slice(0, max());
    const left = clean.length - kept.length;
    setOverflow(left > 0 ? (email() ? t().tooManyAddresses({ max: max(), left }) : t().tooManyValues({ max: max(), left })) : undefined);
    if (email() && kept.length < values().length) say(t().addressesRemoved({ count: values().length - kept.length }));
    else if (email() && kept.length > values().length) say(t().addressesAdded({ count: kept.length - values().length }));
    setOwn(kept);
    props.onChange?.(kept);
  };
  // The addresses in a text become chips. While typing (not `final`) only entries a separator closed are taken, and
  // a text with no address yet is left as it is typed; Enter, a paste and leaving the field take the last entry too,
  // and what is no address then stays in the field with a sentence why.
  const take = (text: string, final: boolean) => {
    const { found, rest } = scanAddresses(text, { final });
    if (!found.length && !final) {
      setQuery(text);
      setRefused(undefined);
      return;
    }
    if (found.length) commit([...values(), ...found]);
    setQuery(rest);
    // cut by characters, so a long text never ends in half an emoji
    const letters = Array.from(rest);
    const shown = letters.length > 60 ? `${letters.slice(0, 59).join("")}…` : rest;
    setRefused(final && rest ? t().notAnAddress({ text: shown }) : undefined);
  };
  const items = (): ChoiceItem[] => [...new Set([...(props.suggestions ?? []), ...values()])].map((value) => ({ value, label: value }));
  // the core's input owns its id, so the field's label names it through aria-labelledby; a press on the label focuses it
  let input: HTMLInputElement | undefined;
  field?.named(() => input?.focus());
  // a refused text keeps the form from being sent, with the field's own sentence as the reason
  createRenderEffect(() => {
    // read before the input is there too, so the effect follows the sentence from the start
    const reason = refused() ?? "";
    input?.setCustomValidity(reason);
  });
  // Without `onChange` the given values are where a form's reset returns to. The values are held here for every kind
  // (core only shows them), so `max` holds for what core keeps too, and the field puts them back itself.
  const initial = [...(props.value ?? [])];
  let chips: HTMLElement | undefined;
  const ours = (event: Event) => event.target instanceof HTMLFormElement && !!chips && event.target.contains(chips);
  const onReset = (event: Event) => {
    if (props.onChange || !ours(event)) return;
    setOwn(initial);
    setQuery("");
    setRefused(undefined);
    setOverflow(undefined);
  };
  // Sending while the focus is still in the field takes the typed addresses first, as leaving it would; a text that
  // is no address then keeps the form from being sent, with its sentence.
  const onSubmit = (event: Event) => {
    if (!email() || !ours(event) || !query().trim()) return;
    take(query(), true);
    if (!rejected()) return;
    event.preventDefault();
    event.stopPropagation();
    input?.reportValidity();
  };
  // leaving the field and its suggestions takes the last entry, as Enter does (a press outside too: core keeps the text)
  const onLeave = (event: FocusEvent) => {
    const to = event.relatedTarget;
    const list = input?.getAttribute("aria-controls");
    const popup = list ? document.getElementById(list) : null;
    if (to instanceof Node && (chips?.contains(to) || popup?.contains(to))) return;
    if (query().trim()) take(query(), true);
  };
  onMount(() => {
    document.addEventListener("reset", onReset);
    document.addEventListener("submit", onSubmit, true);
    onCleanup(() => {
      document.removeEventListener("reset", onReset);
      document.removeEventListener("submit", onSubmit, true);
    });
  });
  const combo = useCombobox(() => ({
    items: items(),
    multiple: true as const,
    allowCustomValue: true,
    // the values are held here: a paste adds several at once, and `max` leaves nothing in core that does not show
    value: values(),
    // typing: a separator turns the addresses before it into chips; anything else is typed on, and the sentence of a
    // refused text goes while it is fixed
    ...(email()
      ? {
          query: query(),
          keepQuery: true,
          onQueryChange: (next: string) => {
            if (/[,;\n]/.test(next)) return take(next, false);
            setQuery(next);
            if (rejected()) setRefused(undefined);
          },
        }
      : {}),
    onValueChange: (next: string[]) => {
      if (!email()) return commit(next);
      // Enter commits the typed text: as addresses, the rest stays in the field
      const added = next.filter((value) => !values().includes(value));
      if (next.length < values().length || !added.length) return commit(next);
      take(added.join(", "), true);
    },
    disabled: props.disabled,
    required: field?.required,
    name: props.name ?? field?.name,
  }));
  return (
    <>
      <combo.Chips
        ref={(element: HTMLElement) => {
          chips = element;
          if (email()) element.addEventListener("focusout", onLeave);
        }}
        class="k2-input"
        data-k2-part="TagsInput"
        data-tags=""
        aria-labelledby={field?.label}
        data-invalid={field?.invalid ? "" : undefined}
        data-disabled={props.disabled ? "" : undefined}
      >
        <For each={values()}>
          {(value) => (
            <combo.Chip class="k2-chip" value={value}>
              {value}
              <combo.ChipRemove class="k2-chip-x" value={value} aria-label={t().removeValue({ label: value })}>
                <Icon name="x" />
              </combo.ChipRemove>
            </combo.Chip>
          )}
        </For>
        <combo.Input
          ref={(element: HTMLElement) => {
            input = element as HTMLInputElement;
          }}
          placeholder={values().length ? undefined : props.placeholder}
          aria-labelledby={field?.label}
          aria-label={field ? undefined : props.label}
          aria-invalid={field?.invalid || rejected() ? "true" : undefined}
          aria-describedby={[field?.described, refused() || overflow() ? noticeId : undefined].filter(Boolean).join(" ") || undefined}
          inputMode={email() ? "email" : undefined}
          autocomplete={email() ? "email" : undefined}
          onPaste={(event: ClipboardEvent) => {
            const text = event.clipboardData?.getData("text/plain") ?? "";
            if (!email() || !/[,;\s]/.test(text.trim()) || !input) return;
            event.preventDefault();
            // the pasted text stands where the selection was, as a plain paste would put it
            const typed = input.value;
            const from = input.selectionStart ?? typed.length;
            const to = input.selectionEnd ?? from;
            take(typed.slice(0, from) + text + typed.slice(to), true);
          }}
        />
      </combo.Chips>
      {/* why a text was not taken, under the chips; a refused text keeps the form from being sent */}
      <Show when={refused() || overflow()}>
        <span class="k2-field-message" id={noticeId} data-error={refused() ? "" : undefined}>
          {[refused(), overflow()].filter(Boolean).join(" ")}
        </span>
      </Show>
      <Show when={email()}>
        <span class="k2-hidden-text" role="status">
          {heard()}
        </span>
      </Show>
      {/* core's form input validates and resets the field; the values are sent one entry each under the name */}
      <combo.FormInput />
      <Show when={props.name ?? field?.name}>
        {(name) => <For each={values()}>{(value) => <input type="hidden" name={name()} value={value} disabled={props.disabled} />}</For>}
      </Show>
      <Show when={props.suggestions?.length}>
        <combo.Popup
          class="k2-menu"
          data-listbox=""
          sideOffset={4}
          collisionPadding={8}
          option={(item: ChoiceItem) => (
            <combo.Item class="k2-mi" value={item.value} label={item.label}>
              {item.label}
              <combo.ItemIndicator item={item.value} class="k2-mi-meta">
                <Icon name="check" />
              </combo.ItemIndicator>
            </combo.Item>
          )}
        />
      </Show>
    </>
  );
};
