import { children, createContext, createEffect, createSignal, createUniqueId, For, type JSX, Show, splitProps, useContext } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Button } from "../actions/Button";
import { CopyButton } from "../actions/CopyButton";
import { useUiMessages } from "../intl/messages";
import { useSectionMessages } from "./section-messages";

/** Named after the status tokens; a tone colours the frame, the title, and the icon, never the fill. */
export type SectionTone = "neutral" | "success" | "warning" | "danger" | "info" | "ai";
/** `sm` for detail panels and other narrow columns, `md` for topics on a full page. */
export type SectionSize = "sm" | "md";
/** `line` draws the light 1 px frame; inside another frame a section always stands flat. */
export type SectionFrame = "line" | "none";
export type SectionState = "ready" | "loading" | "error";

type SectionBaseProps = Omit<JSX.HTMLAttributes<HTMLElement>, "title" | "children" | "class"> & {
  title: JSX.Element;
  icon?: string;
  size?: SectionSize;
  frame?: SectionFrame;
  tone?: SectionTone;
  /**
   * Marks a section that only some people see, such as "Only with permission": a lock and these words after the
   * title. It is part of the section's accessible name and combines with any tone.
   */
  restricted?: string;
  description?: JSX.Element;
  /** How many things the section lists, as a chip after the title; `0` reads "None yet". */
  count?: number;
  /** Short state after the title, such as "2 of 4 done". */
  meta?: JSX.Element;
  /** Commands for the whole topic, as a row of buttons at the end of the body. */
  footer?: JSX.Element;
  /** `loading` and `error` take the body's place; the heading stays where it is. */
  state?: SectionState;
  /** Says what did not load; defaults to a generic sentence. */
  errorMessage?: JSX.Element;
  /** Shows "Try again" in the error state. */
  onRetry?: () => void;
  /** Placeholder rows while loading, the number the loaded body usually shows. Defaults to 3. */
  loadingRows?: number;
  /** Heading level; defaults to 3, or 2 for `size="md"`. */
  level?: 2 | 3;
  class?: string;
};

export type SectionProps = SectionBaseProps &
  (
    | {
        children?: JSX.Element;
        /** Exactly one control at the end of the heading, such as "+" or one text button. */
        actions?: JSX.Element;
        collapsible?: false;
        summary?: never;
        defaultOpen?: never;
        open?: never;
        onOpenChange?: never;
        disabled?: never;
      }
    | {
        children: JSX.Element;
        actions?: never;
        collapsible: true;
        /** One line that says what the closed section holds, such as its newest entry; hidden while open. */
        summary?: JSX.Element;
        defaultOpen?: boolean;
        open?: boolean;
        onOpenChange?: (open: boolean) => void;
        disabled?: boolean;
      }
  );

export type SectionPartProps = {
  title: JSX.Element;
  children: JSX.Element;
  class?: string;
};

/** Props of `Field`, a shown value; input fields share `FieldProps`. */
export type FieldRowProps = {
  label: string;
  /** The value; pass `children` instead for rich content. */
  value?: JSX.Element;
  children?: JSX.Element;
  /** `true` copies a text `value`; a string copies that string, such as the full form of a shortened value. */
  copy?: boolean | string;
  /** `email` links a text value and breaks it only after the `@`. */
  kind?: "text" | "email";
  /** `row` puts the value beside its label and moves it below when it does not fit; `stack` always below. */
  layout?: "row" | "stack";
  class?: string;
};

type SectionComponent = ((props: SectionProps) => JSX.Element) & {
  Part: (props: SectionPartProps) => JSX.Element;
};

const SectionLevel = createContext<number>(2);

/**
 * The frame a section draws when it passes none. A host that frames its topics itself, such as a detail panel, sets
 * `none`; everywhere else a section is a card.
 */
export const SectionFrameDefault = createContext<SectionFrame>("line");

const classNames = (base: string, extra?: string): string => (extra ? `${base} ${extra}` : base);

/** A count chip, or "None yet" for zero. */
const SectionCount = (props: { count: number }): JSX.Element => {
  const messages = useSectionMessages();
  return (
    <Show when={props.count > 0} fallback={<span class="k2b-section__none">{messages().noneYet}</span>}>
      <span class="k2b-count-chip">{props.count}</span>
    </Show>
  );
};

const SkeletonRows = (props: { rows: number }): JSX.Element => {
  const messages = useSectionMessages();
  const widths = [
    [54, 96],
    [40, 72],
    [63, 112],
    [47, 84],
  ];
  return (
    <div role="status">
      <span class="k2b-sr-only">{messages().loading}</span>
      <For each={Array.from({ length: Math.max(1, props.rows) }, (_, index) => widths[index % widths.length])}>
        {(width) => (
          <div class="k2b-section__skeleton-row" aria-hidden="true">
            <span style={{ width: `${width?.[0] ?? 54}px` }} />
            <span style={{ width: `${width?.[1] ?? 96}px` }} />
          </div>
        )}
      </For>
    </div>
  );
};

const SectionRoot = (props: SectionProps): JSX.Element => {
  const [local, rest] = splitProps(props, [
    "title",
    "icon",
    "size",
    "frame",
    "tone",
    "restricted",
    "description",
    "count",
    "meta",
    "footer",
    "state",
    "errorMessage",
    "onRetry",
    "loadingRows",
    "level",
    "class",
    "children",
    "actions",
    "collapsible",
    "summary",
    "defaultOpen",
    "open",
    "onOpenChange",
    "disabled",
  ]);
  const ui = useUiMessages();
  const messages = useSectionMessages();
  const frameDefault = useContext(SectionFrameDefault);
  const id = `k2b-section-${createUniqueId()}`;
  const titleId = `${id}-title`;
  const restrictedId = `${id}-restricted`;
  const bodyId = `${id}-body`;
  const level = () => local.level ?? (local.size === "md" ? 2 : 3);
  const state = () => local.state ?? "ready";
  const [internalOpen, setInternalOpen] = createSignal(local.defaultOpen ?? false);
  const open = () => !local.collapsible || (local.open ?? internalOpen());
  let toggleButton: HTMLButtonElement | undefined;
  let body: HTMLDivElement | undefined;

  const toggle = () => {
    if (local.disabled) return;
    const next = !open();
    if (local.open === undefined) setInternalOpen(next);
    local.onOpenChange?.(next);
  };
  // A parent may close the section while focus is inside it; focus then returns to the toggle instead of the page.
  createEffect(() => {
    if (open()) return;
    queueMicrotask(() => {
      const active = body?.ownerDocument.activeElement;
      if (!open() && active && body?.contains(active)) toggleButton?.focus();
    });
  });

  // Resolve once and only while ready: reading `children` twice would build the body twice.
  const resolved = children(() => (state() === "ready" ? local.children : undefined));
  const hasBody = () => local.collapsible || state() !== "ready" || Boolean(resolved.toArray().length) || Boolean(local.footer);
  const tone = () => (local.tone && local.tone !== "neutral" ? local.tone : undefined);

  const icon = () => (
    <Show when={local.icon}>
      {(name) => (
        <span class="k2b-section__icon" aria-hidden="true">
          <i class={name()} />
        </span>
      )}
    </Show>
  );
  const titleMeta = () => (
    <>
      <Show when={local.count !== undefined}>
        <SectionCount count={local.count ?? 0} />
      </Show>
      <Show when={local.meta}>
        <span class="k2b-section__meta">{local.meta}</span>
      </Show>
      <Show when={local.restricted}>
        <span class="k2b-section__restricted" id={restrictedId}>
          <i class="ti ti-lock" aria-hidden="true" />
          {local.restricted}
        </span>
      </Show>
    </>
  );
  const description = () => (
    <Show when={local.description}>
      <span class="k2b-section__description">{local.description}</span>
    </Show>
  );

  return (
    <section
      {...rest}
      class={classNames("k2b-section", local.class)}
      data-size={local.size ?? "sm"}
      data-frame={local.frame ?? frameDefault}
      data-tone={tone()}
      data-icon={local.icon ? "true" : undefined}
      data-collapsible={local.collapsible ? "true" : undefined}
      data-open={local.collapsible ? String(open()) : undefined}
      data-summary={local.collapsible && local.summary ? "true" : undefined}
      aria-labelledby={local.restricted ? `${titleId} ${restrictedId}` : titleId}
      aria-busy={state() === "loading" ? "true" : undefined}
    >
      <Show
        when={local.collapsible}
        fallback={
          <header class="k2b-section__header">
            {icon()}
            <span class="k2b-section__copy">
              <span class="k2b-section__heading">
                <Dynamic component={`h${level()}`} id={titleId} class="k2b-section__title">
                  {local.title}
                </Dynamic>
                {titleMeta()}
              </span>
              {description()}
            </span>
            <Show when={local.actions}>
              <div class="k2b-section__actions">{local.actions}</div>
            </Show>
          </header>
        }
      >
        {/* The whole heading row is one disclosure button inside the heading, so the region keeps its name. */}
        <Dynamic component={`h${level()}`} class="k2b-section__header">
          <button
            ref={toggleButton}
            type="button"
            class="k2b-section__toggle"
            aria-expanded={open()}
            aria-controls={bodyId}
            disabled={local.disabled}
            // A native listener, not Solid's delegated `onClick`: delegation is registered once per document when
            // this module loads, so a section rendered into a later document (a test harness, an iframe) would
            // never toggle. The shared Button registers its delegation at render time and has no such gap.
            on:click={toggle}
          >
            {icon()}
            <span class="k2b-section__copy">
              <span class="k2b-section__heading">
                <span id={titleId} class="k2b-section__title">
                  {local.title}
                </span>
                {titleMeta()}
                <Show when={local.summary}>
                  <span class="k2b-section__summary k2b-truncate-fade">{local.summary}</span>
                </Show>
              </span>
              {description()}
            </span>
            <span class="k2b-section__chevron" aria-hidden="true">
              <i class="ti ti-chevron-down" />
            </span>
          </button>
        </Dynamic>
      </Show>
      <Show when={hasBody()}>
        <div ref={body} id={bodyId} class="k2b-section__body" hidden={!open()}>
          <Show when={state() === "loading"}>
            <SkeletonRows rows={local.loadingRows ?? 3} />
          </Show>
          <Show when={state() === "error"}>
            <div class="k2b-section__error" role="alert">
              <i class="ti ti-alert-circle" aria-hidden="true" />
              <span>{local.errorMessage ?? messages().couldNotLoad}</span>
            </div>
            <Show when={local.onRetry}>
              {(retry) => (
                <div class="k2b-section__footer">
                  <Button type="button" size="sm" variant="secondary" onClick={() => retry()()}>
                    <i class="ti ti-refresh" aria-hidden="true" />
                    {ui().retry}
                  </Button>
                </div>
              )}
            </Show>
          </Show>
          {resolved()}
          <Show when={state() === "ready" && local.footer}>
            <div class="k2b-section__footer">{local.footer}</div>
          </Show>
        </div>
      </Show>
    </section>
  );
};

/** A sub-topic inside a section, such as "Contact" or "Address": a small heading, no frame of its own. */
const SectionPart = (props: SectionPartProps): JSX.Element => {
  const level = useContext(SectionLevel);
  const id = `k2b-section-part-${createUniqueId()}`;
  return (
    <div class={classNames("k2b-section__part", props.class)} role="group" aria-labelledby={id}>
      <Dynamic component={`h${Math.min(level + 1, 6)}`} id={id} class="k2b-section__part-title">
        {props.title}
      </Dynamic>
      {props.children}
    </div>
  );
};

/** Splits an address after its `@`, so it only breaks there. */
const emailParts = (address: string): JSX.Element => {
  const at = address.indexOf("@");
  if (at < 0) return address;
  return (
    <>
      <span class="k2b-field-row__nowrap">{address.slice(0, at + 1)}</span>
      <wbr />
      <span class="k2b-field-row__nowrap">{address.slice(at + 1)}</span>
    </>
  );
};

/** A label on the left and its value on the right, with an optional copy button that always keeps its place. */
export function Field(props: FieldRowProps): JSX.Element {
  const messages = useSectionMessages();
  const text = () => (typeof props.value === "string" ? props.value : undefined);
  const copyValue = () => (typeof props.copy === "string" ? props.copy : props.copy ? text() : undefined);
  const content = () => {
    const value = text();
    if (props.kind === "email" && value) return <a href={`mailto:${value}`}>{emailParts(value)}</a>;
    return props.value ?? props.children;
  };
  return (
    <div class={classNames("k2b-field-row", props.class)} data-layout={props.layout ?? "row"} data-kind={props.kind}>
      <span class="k2b-field-row__label">{props.label}</span>
      <span class="k2b-field-row__value">
        <span
          class="k2b-field-row__text"
          title={props.layout !== "stack" ? (typeof props.copy === "string" ? props.copy : text()) : undefined}
        >
          {content()}
        </span>
        {/* Without a copy button the slot stays, so every value of a section ends on one edge. */}
        <Show when={copyValue()} fallback={<span class="k2b-field-row__slot" aria-hidden="true" />}>
          {(value) => (
            <CopyButton
              class="k2b-field-row__copy"
              value={value()}
              size="xs"
              iconOnly
              label={messages().copyField({ label: props.label })}
            />
          )}
        </Show>
      </span>
    </div>
  );
}

/**
 * One topic, in a detail panel or on a page: an icon, a title with its count, at most one control, and its
 * content. On a page a section is a card with the light 1 px frame; inside another frame, and in a detail panel, it
 * stands flat, so cards never nest.
 */
const SectionWithLevel = (props: SectionProps): JSX.Element => (
  // The level is provided before the body is built, so a part's heading sits one level below this section's.
  <SectionLevel.Provider value={props.level ?? (props.size === "md" ? 2 : 3)}>
    <SectionRoot {...props} />
  </SectionLevel.Provider>
);

export const Section = SectionWithLevel as SectionComponent;
Section.Part = SectionPart;

export default Section;
