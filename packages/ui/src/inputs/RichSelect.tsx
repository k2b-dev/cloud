import { createMemo, createSignal, createUniqueId, For, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { Button } from "../actions/Button";
import { dialogCore } from "../feedback/dialog-core";
import { createFieldMeta, Field, fieldControlAria } from "../internal/field";
import { LocaleProvider, useLocale } from "../intl/locale";
import BottomSheet, { bottomSheetOptions } from "../layout/BottomSheet";
import { createChoicePopover, filterChoiceOptions, nextEnabledChoiceIndex } from "./choice";
import type { ValueFieldProps } from "./field-contract";
import { commitFieldValue, resolveMaybeAccessor } from "./field-contract";
import { type RichSelectMessages, useRichSelectMessages } from "./rich-select-messages";
import type { ChoiceAppearance } from "./Select";

/** One option: a name plus at most one short line. */
export type RichSelectItem = {
  value: string;
  /** Wraps; never truncated. */
  label: string;
  /** At most one short line that says what the choice changes. */
  description?: string;
  /** Icon class shown before the name. */
  icon?: string;
  /** Color dot shown before the name, such as a space color. Replaces `icon`. */
  color?: string;
  /** Custom visual shown before the name. Replaces `icon` and `color`. */
  visual?: JSX.Element;
  /** Makes the row unavailable. The reason replaces `description`; the arrow keys still reach the row. */
  disabledReason?: string;
  /** Section id. Headings show only from eight options; keep each section's items together. */
  section?: string;
  /** Extra search terms that are not shown. */
  keywords?: readonly string[];
};

export type RichSelectSection = { id: string; label: string };

export type RichSelectStatus = "ready" | "loading" | "error";

export type RichSelectFooter =
  | { label: string; icon?: string; onActivate: () => void }
  | { label: string; icon?: string; create: { placeholder: string; onCreate: (name: string) => void } };

export type RichSelectFact = {
  icon: string;
  text: JSX.Element;
  tone?: "default" | "warning";
};

export type RichSelectProps = ValueFieldProps<string | null> & {
  items: readonly RichSelectItem[];
  /** Labels for the `section` ids of the items. */
  sections?: readonly RichSelectSection[];
  /** Names the list: the heading of a list without preview, the phone sheet title, and the listbox label. */
  title?: string;
  placeholder?: string;
  /** Replaces the selected item's name in the trigger, such as "Name · address". */
  triggerLabel?: string;
  /** Icon class for the trigger while no item with its own visual is selected. */
  icon?: string;
  tone?: "default" | "warning";
  /** Custom content inside the shared trigger button, which keeps the combobox semantics. */
  renderTrigger?: (selected: RichSelectItem | undefined) => JSX.Element;
  /**
   * The body of the preview beside the list, for options whose consequences differ.
   * Without it the picker shows only the list. Keep it to at most three facts.
   */
  renderPreview?: (item: RichSelectItem) => JSX.Element;
  searchPlaceholder?: string;
  status?: RichSelectStatus;
  onRetry?: () => void;
  /** Shown when the list is ready and has no items. */
  empty?: JSX.Element;
  footer?: RichSelectFooter;
  appearance?: ChoiceAppearance;
  placement?: "bottom-start" | "top-start";
  /** CSS lengths for the desktop popover. */
  size?: { width?: string; height?: string };
  name?: string;
};

/** Search and section headings appear from this many options. */
export const RICH_SELECT_SEARCH_FROM = 8;
const PHONE_QUERY = "(max-width: 47.999rem)";
const PLACEHOLDER_ROWS = 4;

type Row = { kind: "heading"; id: string; label: string } | { kind: "item"; item: RichSelectItem; index: number };

const isPhone = () => typeof matchMedia === "function" && matchMedia(PHONE_QUERY).matches;

function RichSelectVisual(props: { item: RichSelectItem }): JSX.Element {
  return (
    <Switch>
      <Match when={props.item.visual}>{(visual) => <span class="k2b-rich-select__visual">{visual()}</span>}</Match>
      <Match when={props.item.color}>
        {(color) => (
          <span class="k2b-rich-select__visual" aria-hidden="true">
            <span class="k2b-rich-select__dot" style={{ "background-color": color() }} />
          </span>
        )}
      </Match>
      <Match when={props.item.icon}>
        {(icon) => (
          <span class="k2b-rich-select__visual" aria-hidden="true">
            <i class={icon()} />
          </span>
        )}
      </Match>
    </Switch>
  );
}

const hasVisual = (item: RichSelectItem) => Boolean(item.visual || item.color || item.icon);

/** Name and second line. The reason of an unavailable row replaces the description. */
function RichSelectRowText(props: { item: RichSelectItem; labelId: string; lineId: string }): JSX.Element {
  return (
    <span class="k2b-rich-select__text">
      <span id={props.labelId} class="k2b-rich-select__label">
        {props.item.label}
      </span>
      <Show when={props.item.disabledReason ?? props.item.description}>
        {(line) => (
          <span id={props.lineId} class="k2b-rich-select__line" data-reason={props.item.disabledReason ? "true" : undefined}>
            {line()}
          </span>
        )}
      </Show>
    </span>
  );
}

function RichSelectPlaceholders(props: { visual: boolean }): JSX.Element {
  return (
    <For each={Array.from({ length: PLACEHOLDER_ROWS }, (_, index) => index)}>
      {(index) => (
        <div class="k2b-rich-select__placeholder" data-visual={props.visual ? "true" : undefined} aria-hidden="true">
          <Show when={props.visual}>
            <span class="k2b-rich-select__placeholder-visual" />
          </Show>
          <span class="k2b-rich-select__placeholder-lines">
            <span style={{ width: `${[58, 46, 66, 50][index % 4]}%` }} />
            <span style={{ width: `${[34, 28, 40, 30][index % 4]}%` }} />
          </span>
        </div>
      )}
    </For>
  );
}

function RichSelectState(props: {
  status: "error" | "empty";
  messages: RichSelectMessages;
  empty?: JSX.Element;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div class="k2b-rich-select__state" data-status={props.status} role={props.status === "error" ? "alert" : "status"}>
      <span class="k2b-rich-select__state-icon" aria-hidden="true">
        <i class={props.status === "error" ? "ti ti-alert-triangle" : "ti ti-list-search"} />
      </span>
      <Show
        when={props.status === "error"}
        fallback={<div class="k2b-rich-select__state-text">{props.empty ?? props.messages.noOptions}</div>}
      >
        <div class="k2b-rich-select__state-text">{props.messages.couldNotLoad}</div>
        <Show when={props.onRetry}>
          {(retry) => (
            <Button variant="secondary" size="sm" onClick={() => retry()()}>
              <i class="ti ti-refresh" aria-hidden="true" />
              {props.messages.retry}
            </Button>
          )}
        </Show>
      </Show>
    </div>
  );
}

function RichSelectPreview(props: { item: RichSelectItem; render: (item: RichSelectItem) => JSX.Element; id?: string }): JSX.Element {
  return (
    <div id={props.id}>
      <h3 class="k2b-rich-select__preview-title">
        <RichSelectVisual item={props.item} />
        <span>{props.item.label}</span>
      </h3>
      {props.render(props.item)}
    </div>
  );
}

/** Up to three short facts for a preview, each with an icon; warnings in the warning tone. */
export function RichSelectFacts(props: { facts: readonly RichSelectFact[] }): JSX.Element {
  return (
    <ul class="k2b-rich-select__facts">
      <For each={props.facts.slice(0, 3)}>
        {(fact) => (
          <li data-tone={fact.tone === "warning" ? "warning" : undefined}>
            <i class={fact.icon} aria-hidden="true" />
            <span>{fact.text}</span>
          </li>
        )}
      </For>
    </ul>
  );
}

function RichSelectFooterControl(props: {
  footer: RichSelectFooter;
  initialName: () => string;
  messages: RichSelectMessages;
  done: (run: () => void) => void;
}): JSX.Element {
  const [creating, setCreating] = createSignal(false);
  const [name, setName] = createSignal("");
  let input: HTMLInputElement | undefined;
  let start: HTMLButtonElement | undefined;
  const create = () => {
    const footer = props.footer;
    const value = name().trim();
    if (!("create" in footer) || !value) return;
    props.done(() => footer.create.onCreate(value));
  };
  return (
    <div class="k2b-rich-select__footer">
      <Show
        when={creating() && "create" in props.footer ? props.footer.create : undefined}
        fallback={
          <button
            ref={start}
            type="button"
            class="k2b-rich-select__footer-action"
            onClick={() => {
              const footer = props.footer;
              if ("create" in footer) {
                setName(props.initialName());
                setCreating(true);
                queueMicrotask(() => input?.focus());
              } else props.done(footer.onActivate);
            }}
          >
            <span class="k2b-rich-select__visual" aria-hidden="true">
              <i class={props.footer.icon ?? "ti ti-plus"} />
            </span>
            <span class="k2b-rich-select__label">{props.footer.label}</span>
          </button>
        }
      >
        {(create_) => (
          <form
            class="k2b-rich-select__create"
            onSubmit={(event) => {
              event.preventDefault();
              create();
            }}
          >
            <input
              ref={input}
              class="k2b-rich-select__create-input"
              value={name()}
              placeholder={create_().placeholder}
              aria-label={props.footer.label}
              autocomplete="off"
              onInput={(event) => setName(event.currentTarget.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  event.preventDefault();
                  setCreating(false);
                  queueMicrotask(() => start?.focus());
                }
              }}
            />
            <Button type="submit" variant="primary" size="sm" disabled={!name().trim()}>
              {props.messages.create}
            </Button>
          </form>
        )}
      </Show>
    </div>
  );
}

/**
 * A dropdown whose rows explain each choice: a name plus one short line, an
 * unavailable row with its reason, and an optional preview of what a choice
 * changes. Desktop opens a popover beside the trigger; a phone opens a bottom
 * sheet whose info buttons show the preview as a second level.
 */
export function RichSelect(props: RichSelectProps): JSX.Element {
  const messages = useRichSelectMessages();
  const locale = useLocale();
  const meta = createFieldMeta(props.id);
  const listboxId = `${meta.controlId}-listbox`;
  const previewId = `${meta.controlId}-preview`;
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(-1);
  const [height, setHeight] = createSignal<string>();
  const [sheetOpen, setSheetOpen] = createSignal(false);
  let searchRef: HTMLInputElement | undefined;
  let closeSheet: (() => void) | undefined;
  const value = () => resolveMaybeAccessor(props.value) ?? null;
  const error = () => resolveMaybeAccessor(props.error);
  const status = () => props.status ?? "ready";
  const withPreview = () => Boolean(props.renderPreview);
  const title = () =>
    props.title ?? (typeof props.label === "string" ? props.label : (props["aria-label"] ?? props.placeholder ?? messages().chooseOption));
  const searchable = () => status() === "ready" && props.items.length >= RICH_SELECT_SEARCH_FROM;
  const visible = createMemo(() => (searchable() ? filterChoiceOptions(props.items, query()) : props.items));
  const anyVisual = createMemo(() => props.items.some(hasVisual));
  const rows = createMemo<Row[]>(() => {
    const headings = props.items.length >= RICH_SELECT_SEARCH_FROM && props.sections ? props.sections : undefined;
    const result: Row[] = [];
    let section: string | undefined;
    visible().forEach((item, index) => {
      if (headings && item.section && item.section !== section) {
        const heading = headings.find((candidate) => candidate.id === item.section);
        if (heading) result.push({ kind: "heading", id: heading.id, label: heading.label });
      }
      section = item.section;
      result.push({ kind: "item", item, index });
    });
    return result;
  });
  const selected = createMemo(() => {
    const current = value();
    return current === null ? undefined : props.items.find((item) => item.value === current);
  });
  const activeItem = () => (status() === "ready" ? visible()[active()] : undefined);
  const optionId = (index: number) => `${listboxId}-${index}`;
  const popover = createChoicePopover(
    () => Boolean(props.disabled),
    () => ({ width: "own", side: props.placement === "top-start" ? "above" : "below" }),
  );
  const expanded = () => popover.open() || sheetOpen();

  const scrollToActive = () => {
    const element = document.getElementById(optionId(active()));
    element?.scrollIntoView({ block: "nearest" });
  };
  const move = (next: number) => {
    if (next < 0) return;
    setActive(next);
    queueMicrotask(scrollToActive);
  };
  const startIndex = () => {
    const index = visible().findIndex((item) => item.value === value());
    return index >= 0 ? index : visible().length > 0 ? 0 : -1;
  };

  const openPopover = () => {
    setQuery("");
    setActive(startIndex());
    // The preview popover keeps one height while it is open, so moving
    // through rows, filtering, or the end of loading never resizes it.
    const rowsTall = status() === "ready" ? props.items.length : RICH_SELECT_SEARCH_FROM;
    const rem = Math.min(27.5, Math.max(18.75, rowsTall * 3.625 + 1.5));
    setHeight(props.size?.height ?? (withPreview() ? `${rem}rem` : undefined));
    popover.show();
    if (searchable()) queueMicrotask(() => searchRef?.focus());
    queueMicrotask(scrollToActive);
  };
  const open = () => {
    if (props.disabled) return;
    if (isPhone()) openSheet();
    else openPopover();
  };
  const close = (restoreFocus = false) => {
    popover.hide(restoreFocus);
    setQuery("");
    setActive(-1);
  };
  const choose = (item: RichSelectItem | undefined) => {
    if (!item || item.disabledReason) return;
    // Hide first: the old list must never stay visible with the next value.
    close(true);
    commitFieldValue(props, item.value);
  };
  const runFooter = (run: () => void) => {
    close(true);
    run();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" && (event.target as HTMLElement | null)?.closest?.(".k2b-rich-select__footer")) return;
    const isOpen = popover.open();
    const count = visible().length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen) open();
      else if (status() === "ready") move(nextEnabledChoiceIndex(visible(), active(), event.key === "ArrowDown" ? 1 : -1));
    } else if ((event.key === "Home" || event.key === "End") && isOpen) {
      event.preventDefault();
      if (status() === "ready" && count > 0) move(event.key === "Home" ? 0 : count - 1);
    } else if ((event.key === "Enter" || event.key === " ") && !isOpen && event.target === popover.trigger()) {
      event.preventDefault();
      open();
    } else if (event.key === "Enter" && isOpen) {
      // Enter on an unavailable row does nothing; the list stays open.
      event.preventDefault();
      choose(activeItem());
    } else if (event.key === "Escape" && isOpen) {
      // A closed picker lets Escape reach an enclosing dialog.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (
      isOpen &&
      searchable() &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.target !== searchRef
    ) {
      // Typing anywhere in the open picker goes to the search field.
      event.preventDefault();
      setQuery(query() + event.key);
      setActive(visible().length > 0 ? 0 : -1);
      searchRef?.focus();
    }
  };
  const onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget;
    if (!popover.open() || !(next instanceof Node)) return;
    if (popover.trigger()?.contains(next) || popoverElement?.contains(next)) return;
    close();
  };

  let popoverElement: HTMLDivElement | undefined;

  const openSheet = () => {
    const current = locale();
    let after: (() => void) | undefined;
    setSheetOpen(true);
    void dialogCore
      .open<void>(
        (closeDialog, context) => {
          closeSheet = () => closeDialog();
          return (
            <LocaleProvider locale={current}>
              <BottomSheet onDismiss={context.requestDismiss}>
                <RichSelectSheet
                  props={props}
                  title={title()}
                  value={value}
                  dialog={context.dialog}
                  close={() => closeDialog()}
                  done={(run) => {
                    after = run;
                    closeDialog();
                  }}
                />
              </BottomSheet>
            </LocaleProvider>
          );
        },
        {
          ...bottomSheetOptions,
          ariaLabel: title(),
          history: true,
          // A phone keyboard must not cover the list as it opens: focus starts on the sheet.
          initialFocus: (dialog) => {
            dialog.tabIndex = -1;
            return dialog;
          },
        },
      )
      .then(() => after?.())
      .finally(() => {
        closeSheet = undefined;
        setSheetOpen(false);
      });
  };
  onCleanup(() => closeSheet?.());

  const triggerText = () => props.triggerLabel ?? selected()?.label ?? props.placeholder ?? messages().chooseOption;

  return (
    <Field
      class={props.class}
      label={props.label}
      description={props.description}
      error={error()}
      meta={meta}
      required={props.required}
      disabled={props.disabled}
    >
      <div
        class="k2b-choice-control k2b-rich-select"
        data-appearance={props.appearance ?? "field"}
        data-invalid={error() ? "true" : undefined}
        onFocusOut={onFocusOut}
      >
        <button
          ref={popover.setTrigger}
          id={meta.controlId}
          type="button"
          class="k2b-choice-trigger k2b-rich-select__trigger"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={expanded()}
          aria-controls={listboxId}
          aria-activedescendant={popover.open() && activeItem() ? optionId(active()) : undefined}
          data-tone={props.tone === "warning" ? "warning" : undefined}
          {...fieldControlAria(meta, {
            ...props,
            "aria-label": props["aria-label"] ?? (typeof props.label === "string" ? undefined : title()),
          })}
          disabled={props.disabled}
          onClick={() => (popover.open() ? close() : open())}
          onKeyDown={onKeyDown}
        >
          <Show
            when={props.renderTrigger}
            fallback={
              <>
                <Show
                  when={selected() && hasVisual(selected()!) ? selected() : undefined}
                  fallback={<Show when={props.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>}
                >
                  {(item) => <RichSelectVisual item={item()} />}
                </Show>
                <span class="k2b-choice-trigger__value" data-placeholder={selected() || props.triggerLabel ? undefined : "true"}>
                  {triggerText()}
                </span>
                <i class="ti ti-selector k2b-choice-trigger__chevron" aria-hidden="true" />
              </>
            }
          >
            {(render) => render()(selected())}
          </Show>
        </button>
        <Show when={props.name}>{(name) => <input type="hidden" name={name()} value={value() ?? ""} />}</Show>
        <div
          ref={(element) => {
            popoverElement = element;
            popover.setPopover(element);
          }}
          popover="manual"
          class="k2b-choice-popover k2b-rich-select__popover"
          role="group"
          aria-label={title()}
          data-preview={withPreview() ? "true" : undefined}
          data-status={status()}
          style={{ width: props.size?.width, height: height() }}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            // Keep focus on the trigger or search field, so the keys keep working after a click on the preview.
            if (!(event.target as Element).closest("input, button, textarea, a")) event.preventDefault();
          }}
        >
          <Show when={!withPreview()}>
            <div class="k2b-rich-select__title" aria-hidden="true">
              {title()}
            </div>
          </Show>
          <Switch>
            <Match when={status() === "error"}>
              <RichSelectState status="error" messages={messages()} onRetry={props.onRetry} />
            </Match>
            <Match when={status() === "ready" && props.items.length === 0}>
              <RichSelectState status="empty" messages={messages()} empty={props.empty} />
            </Match>
            <Match when>
              <div class="k2b-rich-select__body">
                <div class="k2b-rich-select__column">
                  <Show when={searchable()}>
                    <div class="k2b-choice-search k2b-rich-select__search">
                      <i class="ti ti-search" aria-hidden="true" />
                      <input
                        ref={searchRef}
                        type="search"
                        value={query()}
                        placeholder={props.searchPlaceholder ?? messages().search}
                        aria-label={props.searchPlaceholder ?? messages().search}
                        aria-controls={listboxId}
                        aria-activedescendant={activeItem() ? optionId(active()) : undefined}
                        autocomplete="off"
                        onInput={(event) => {
                          setQuery(event.currentTarget.value);
                          setActive(visible().length > 0 ? 0 : -1);
                        }}
                      />
                    </div>
                  </Show>
                  <div
                    id={listboxId}
                    class="k2b-rich-select__list"
                    role="listbox"
                    aria-label={title()}
                    aria-busy={status() === "loading" ? "true" : undefined}
                    data-visual={anyVisual() ? "true" : undefined}
                    data-choice-scroll
                  >
                    <Show when={status() === "loading"}>
                      <span class="k2b-sr-only">{messages().loading}</span>
                      <RichSelectPlaceholders visual={anyVisual() || props.items.length === 0} />
                    </Show>
                    <Show when={status() === "ready"}>
                      <For each={rows()} fallback={<div class="k2b-rich-select__no-results">{messages().noResults}</div>}>
                        {(row) =>
                          row.kind === "heading" ? (
                            <div class="k2b-rich-select__heading" role="presentation">
                              {row.label}
                            </div>
                          ) : (
                            // biome-ignore lint/a11y/useKeyWithClickEvents: the trigger or search field handles the keys through aria-activedescendant.
                            <div
                              id={optionId(row.index)}
                              class="k2b-rich-select__option"
                              role="option"
                              aria-selected={row.item.value === value()}
                              aria-disabled={row.item.disabledReason ? "true" : undefined}
                              aria-labelledby={`${optionId(row.index)}-label`}
                              aria-describedby={
                                [
                                  row.item.disabledReason || row.item.description ? `${optionId(row.index)}-line` : "",
                                  withPreview() && row.index === active() ? previewId : "",
                                ]
                                  .filter(Boolean)
                                  .join(" ") || undefined
                              }
                              data-active={row.index === active() ? "true" : undefined}
                              onPointerMove={() => {
                                if (active() !== row.index) setActive(row.index);
                              }}
                              onClick={() => choose(row.item)}
                            >
                              <Show when={anyVisual()}>
                                <Show when={hasVisual(row.item)} fallback={<span class="k2b-rich-select__visual" />}>
                                  <RichSelectVisual item={row.item} />
                                </Show>
                              </Show>
                              <RichSelectRowText
                                item={row.item}
                                labelId={`${optionId(row.index)}-label`}
                                lineId={`${optionId(row.index)}-line`}
                              />
                              <i class="ti ti-check k2b-rich-select__check" aria-hidden="true" />
                            </div>
                          )
                        }
                      </For>
                    </Show>
                  </div>
                  <Show when={props.footer && status() === "ready"}>
                    <RichSelectFooterControl footer={props.footer!} initialName={query} messages={messages()} done={runFooter} />
                  </Show>
                </div>
                <Show when={props.renderPreview}>
                  {(render) => (
                    <div class="k2b-rich-select__preview" data-choice-scroll>
                      <Show when={status() === "loading"}>
                        <div class="k2b-rich-select__preview-placeholder" aria-hidden="true">
                          <span />
                          <span style={{ width: "86%" }} />
                          <span style={{ width: "72%" }} />
                          <span style={{ width: "80%" }} />
                        </div>
                      </Show>
                      <Show when={activeItem()}>{(item) => <RichSelectPreview id={previewId} item={item()} render={render()} />}</Show>
                    </div>
                  )}
                </Show>
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </Field>
  );
}

/**
 * The phone presentation: a bottom sheet with the list. With a preview, an
 * info button beside each row, unavailable rows included, opens the preview as
 * a second level with Back and Choose.
 */
function RichSelectSheet(sheet: {
  props: RichSelectProps;
  title: string;
  value: () => string | null;
  dialog: HTMLDialogElement;
  close: () => void;
  done: (run: () => void) => void;
}): JSX.Element {
  const messages = useRichSelectMessages();
  const props = sheet.props;
  const uid = createUniqueId();
  const [query, setQuery] = createSignal("");
  const [detail, setDetail] = createSignal<RichSelectItem>();
  let back: HTMLButtonElement | undefined;
  let returnTo: string | undefined;
  const status = () => props.status ?? "ready";
  const searchable = () => status() === "ready" && props.items.length >= RICH_SELECT_SEARCH_FROM;
  const visible = createMemo(() => (searchable() ? filterChoiceOptions(props.items, query()) : props.items));
  const anyVisual = createMemo(() => props.items.some(hasVisual));
  const headings = () => (props.items.length >= RICH_SELECT_SEARCH_FROM && props.sections ? props.sections : undefined);
  const headingBefore = (index: number) => {
    const item = visible()[index];
    const list = headings();
    if (!list || !item?.section || visible()[index - 1]?.section === item.section) return undefined;
    return list.find((candidate) => candidate.id === item.section)?.label;
  };
  const choose = (item: RichSelectItem) => {
    if (item.disabledReason) return;
    sheet.done(() => commitFieldValue(props, item.value));
  };
  const rowId = (index: number) => `k2b-rich-select-sheet-${uid}-${index}`;
  const showDetail = (item: RichSelectItem, index: number) => {
    returnTo = `${rowId(index)}-info`;
    // The second level keeps the sheet's height, so Back and Choose stay where they are.
    sheet.dialog.style.minHeight = `${sheet.dialog.getBoundingClientRect().height}px`;
    setDetail(item);
    queueMicrotask(() => back?.focus());
  };
  const leaveDetail = () => {
    sheet.dialog.style.minHeight = "";
    setDetail(undefined);
    const target = returnTo;
    queueMicrotask(() => (target ? document.getElementById(target)?.focus() : undefined));
  };
  // Escape on the second level goes back to the list instead of closing the sheet.
  const onEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !detail()) return;
    event.preventDefault();
    event.stopPropagation();
    leaveDetail();
  };
  onMount(() => {
    sheet.dialog.addEventListener("keydown", onEscape, true);
    onCleanup(() => {
      sheet.dialog.removeEventListener("keydown", onEscape, true);
      // dialogCore may reuse the dialog element for the next dialog.
      sheet.dialog.style.minHeight = "";
    });
  });

  return (
    <>
      <header class="k2b-panel-dialog__header" data-has-subtitle="false">
        <Show when={detail()}>
          <button
            ref={back}
            type="button"
            class="k2b-dialog__close k2b-rich-select__back"
            aria-label={messages().back}
            onClick={leaveDetail}
          >
            <i class="ti ti-chevron-left" aria-hidden="true" />
          </button>
        </Show>
        <div class="k2b-panel-dialog__heading">
          <h2>{detail()?.label ?? sheet.title}</h2>
        </div>
        <button type="button" class="k2b-dialog__close" aria-label={messages().close} onClick={sheet.close}>
          <i class="ti ti-x" aria-hidden="true" />
        </button>
      </header>
      <Show
        when={detail()}
        fallback={
          <BottomSheet.Body>
            <Switch>
              <Match when={status() === "error"}>
                <RichSelectState status="error" messages={messages()} onRetry={props.onRetry} />
              </Match>
              <Match when={status() === "ready" && props.items.length === 0}>
                <RichSelectState status="empty" messages={messages()} empty={props.empty} />
              </Match>
              <Match when>
                <Show when={searchable()}>
                  <div class="k2b-choice-search k2b-rich-select__search">
                    <i class="ti ti-search" aria-hidden="true" />
                    <input
                      type="search"
                      value={query()}
                      placeholder={props.searchPlaceholder ?? messages().search}
                      aria-label={props.searchPlaceholder ?? messages().search}
                      autocomplete="off"
                      onInput={(event) => setQuery(event.currentTarget.value)}
                    />
                  </div>
                </Show>
                <div
                  class="k2b-rich-select__list"
                  role="list"
                  aria-label={sheet.title}
                  aria-busy={status() === "loading" ? "true" : undefined}
                  data-visual={anyVisual() ? "true" : undefined}
                >
                  <Show when={status() === "loading"}>
                    <span class="k2b-sr-only">{messages().loading}</span>
                    <RichSelectPlaceholders visual={anyVisual() || props.items.length === 0} />
                  </Show>
                  <Show when={status() === "ready"}>
                    <For each={visible()} fallback={<div class="k2b-rich-select__no-results">{messages().noResults}</div>}>
                      {(item, index) => (
                        <>
                          <Show when={headingBefore(index())}>{(label) => <div class="k2b-rich-select__heading">{label()}</div>}</Show>
                          <div class="k2b-rich-select__sheet-row" role="listitem" data-info={props.renderPreview ? "true" : undefined}>
                            <button
                              id={rowId(index())}
                              type="button"
                              class="k2b-rich-select__option"
                              aria-current={item.value === sheet.value() ? "true" : undefined}
                              aria-disabled={item.disabledReason ? "true" : undefined}
                              aria-labelledby={`${rowId(index())}-label`}
                              aria-describedby={item.disabledReason || item.description ? `${rowId(index())}-line` : undefined}
                              onClick={() => choose(item)}
                            >
                              <Show when={anyVisual()}>
                                <Show when={hasVisual(item)} fallback={<span class="k2b-rich-select__visual" />}>
                                  <RichSelectVisual item={item} />
                                </Show>
                              </Show>
                              <RichSelectRowText item={item} labelId={`${rowId(index())}-label`} lineId={`${rowId(index())}-line`} />
                              <i class="ti ti-check k2b-rich-select__check" aria-hidden="true" />
                            </button>
                            <Show when={props.renderPreview}>
                              <button
                                id={`${rowId(index())}-info`}
                                type="button"
                                class="k2b-rich-select__info"
                                aria-label={messages().detailsFor({ name: item.label })}
                                onClick={() => showDetail(item, index())}
                              >
                                <i class="ti ti-info-circle" aria-hidden="true" />
                              </button>
                            </Show>
                          </div>
                        </>
                      )}
                    </For>
                  </Show>
                </div>
                <Show when={props.footer && status() === "ready"}>
                  <RichSelectFooterControl footer={props.footer!} initialName={query} messages={messages()} done={sheet.done} />
                </Show>
              </Match>
            </Switch>
          </BottomSheet.Body>
        }
      >
        {(item) => (
          <>
            <BottomSheet.Body>
              <div class="k2b-rich-select__preview" data-level="detail">
                <RichSelectPreview item={item()} render={props.renderPreview!} />
              </div>
            </BottomSheet.Body>
            <BottomSheet.Footer>
              <Button
                variant="primary"
                class="k2b-rich-select__choose"
                disabled={Boolean(item().disabledReason)}
                onClick={() => choose(item())}
              >
                <i class="ti ti-check" aria-hidden="true" />
                {messages().choose}
              </Button>
            </BottomSheet.Footer>
          </>
        )}
      </Show>
    </>
  );
}

export default RichSelect;
