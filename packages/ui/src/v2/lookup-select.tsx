import { createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { usePopover } from "./behavior/overlays";
import { Button } from "./button";
import { useField } from "./controls";
import { useFilterMessages } from "./filter-messages";
import type { LookupItem } from "./list-query";
import { Lookup, type LookupLoad, type LookupResolve } from "./lookup";
import { Icon } from "./marks";
import { alignTo } from "./menu";
import { Dialog } from "./overlays";

type LookupSelectCommon = {
  /** The app's own search, with its own access checks; pass `signal` to `fetch` (see `Lookup`). */
  load: LookupLoad;
  /** Names codes the page does not know yet, such as a value the form starts with; runs once in the browser. */
  resolve?: LookupResolve;
  /** Names the server already knows for the value, so the first picture (server and browser alike) shows names. */
  known?: readonly LookupItem[];
  /** How many matches one search shows: 8 by default, at most 50. */
  limit?: number;
  /** Characters a search needs before it loads; 0 by default. */
  minChars?: number;
  /** The quiet words of the closed field while nothing is chosen, such as "Kunde wählen". */
  placeholder?: string;
  /** The name each chosen code is sent under in a form; the field's name by default. */
  name?: string;
  /** A name for the field when it stands without a `Field`. */
  label?: string;
  /** The value cannot be changed now. */
  disabled?: boolean;
};

export type LookupSelectProps = LookupSelectCommon &
  (
    | {
        /** One value (the default): choosing it closes the list; pressing the ticked one again clears the field. */
        multiple?: false;
        value?: string;
        onChange: (value: string | undefined) => void;
      }
    | {
        /** Several values: each press ticks or unticks, the list stays open until it is left. */
        multiple: true;
        value: readonly string[];
        onChange: (value: string[]) => void;
      }
  );

/** The phone of v2: every width below 768 px. */
const phoneQuery = "not all and (min-width: 768px)";
const isPhone = () => !isServer && matchMedia(phoneQuery).matches;

/**
 * A form field that chooses from values the app loads while the person types, such as a customer of 412 or a person:
 * closed it shows the chosen names like `Select`; open, the `Lookup` panel (search, 200 ms wait, abort, placeholders,
 * empty, failed with retry) in a popover under the field, on the phone in a sheet. In a `Field` it takes the field's
 * label, name, hint, error and `required`. The names come from `known` (resolved on the server) and from what loads,
 * so the server and the first picture in the browser agree; codes without a name are resolved once in the browser.
 */
export const LookupSelect = (props: LookupSelectProps) => {
  const field = useField();
  const t = useFilterMessages();
  const nameId = createUniqueId();
  let trigger: HTMLElement | undefined;
  field?.named(() => trigger?.focus());

  const chosen = (): readonly string[] =>
    props.multiple ? props.value : props.value === undefined || props.value === "" ? [] : [props.value];
  const [names, setNames] = createSignal<ReadonlyMap<string, LookupItem>>(new Map((props.known ?? []).map((item) => [item.value, item])));
  const remember = (items: readonly LookupItem[]) => {
    const fresh = items.filter((item) => names().get(item.value)?.label !== item.label);
    if (fresh.length === 0) return;
    setNames((before) => new Map([...before, ...fresh.map((item) => [item.value, item] as const)]));
  };
  const labels = createMemo(() => chosen().map((code) => names().get(code)?.label ?? code));
  const text = () => labels().join(", ");

  // Codes the page could not name: asked for once, after the first picture, so the server and the browser agree on it.
  onMount(() => {
    const resolve = props.resolve;
    const unknown = chosen().filter((code) => !names().has(code));
    if (!resolve || unknown.length === 0) return;
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    resolve(unknown, { signal: controller.signal }).then(
      (found) => !controller.signal.aborted && remember(found),
      () => undefined,
    );
  });

  const choose = (next: string[]) => {
    if (props.multiple) props.onChange(next);
    else {
      props.onChange(next.at(-1));
      close();
    }
  };

  const [open, setOpen] = createSignal(false);
  const [sheet, setSheet] = createSignal(false);
  const [align, setAlign] = createSignal<"start" | "end">("start");
  const close = () => {
    setOpen(false);
    setSheet(false);
  };
  const popover = usePopover(() => ({
    open: open(),
    onOpenChange: (next: boolean) => {
      if (next && isPhone()) return;
      if (next) setAlign(alignTo(trigger));
      setOpen(next);
    },
  }));
  // The search takes the focus when the panel opens; on the phone the sheet keeps the keyboard down until a tap.
  const focusSearch = (root: HTMLElement) =>
    setTimeout(() => {
      if (!root.isConnected) return;
      root.querySelector<HTMLElement>(".k2-lookup-search input")?.focus({ preventScroll: true });
    });

  const panel = () => (
    <Lookup
      label={field?.text ?? props.label ?? ""}
      value={chosen()}
      multiple={props.multiple === true}
      known={[...names().values()]}
      load={async (query, context) => {
        const result = await props.load(query, context);
        remember(result.items);
        return result;
      }}
      resolve={
        props.resolve &&
        (async (values, context) => {
          const found = await (props.resolve as LookupResolve)(values, context);
          remember(found);
          return found;
        })
      }
      limit={props.limit}
      minChars={props.minChars}
      onChange={choose}
    />
  );

  return (
    <>
      <popover.Trigger
        ref={(element: HTMLElement) => {
          trigger = element;
        }}
        type="button"
        class="k2-input"
        data-k2-part="LookupSelect"
        data-select=""
        data-invalid={field?.invalid ? "" : undefined}
        disabled={props.disabled}
        role="combobox"
        aria-haspopup="dialog"
        aria-labelledby={field?.label ?? nameId}
        aria-describedby={field?.described}
        aria-invalid={field?.invalid ? "true" : undefined}
        aria-required={field?.required ? "true" : undefined}
        title={labels().length > 1 ? text() : undefined}
        // On the phone the sheet opens after the whole tap (its click), so no part of the tap lands on the sheet.
        onPointerDown={(event: PointerEvent) => isPhone() && event.preventDefault()}
        onClick={(event: MouseEvent) => {
          if (!isPhone()) return;
          event.preventDefault();
          setTimeout(() => setSheet(true));
        }}
        onKeyDown={(event: KeyboardEvent) => {
          // Arrow down opens the list, as it does a selection; on the phone Enter and Space open the sheet
          const phone = isPhone();
          if (event.key !== "ArrowDown" && !(phone && (event.key === "Enter" || event.key === " "))) return;
          event.preventDefault();
          if (phone) setSheet(true);
          else {
            setAlign(alignTo(trigger));
            setOpen(true);
          }
        }}
      >
        <Show when={!field}>
          <span class="k2-hidden-text" id={nameId}>
            {props.label}
          </span>
        </Show>
        <span class="k2-input-value" data-placeholder={labels().length === 0 ? "" : undefined}>
          {labels().length > 0 ? text() : (props.placeholder ?? "")}
        </span>
        <Icon name="chevron-down" />
      </popover.Trigger>
      {/* what a form sends: one entry per code under the field's name; `required` blocks a submit while empty */}
      <Show when={props.name ?? field?.name}>
        {(name) => <For each={[...chosen()]}>{(code) => <input type="hidden" name={name()} value={code} />}</For>}
      </Show>
      <Show when={field?.required && chosen().length === 0}>
        <input
          class="k2-hidden-text"
          tabindex="-1"
          aria-hidden="true"
          required
          value=""
          onInvalid={() => trigger?.focus()}
        />
      </Show>
      <popover.Popup class="k2-pop k2-lpop" data-k2-part="Popover" side="bottom" align={align()} sideOffset={4} collisionPadding={8}>
        <div class="k2-lpop-body" ref={focusSearch}>
          {panel()}
        </div>
      </popover.Popup>
      <Dialog
        title={field?.text ?? props.label ?? ""}
        open={sheet()}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        foot={
          <Button variant="primary" onClick={close}>
            {t().done}
          </Button>
        }
      >
        <div class="k2-fsheet" data-k2-part="LookupSheet">
          {panel()}
        </div>
      </Dialog>
    </>
  );
};
