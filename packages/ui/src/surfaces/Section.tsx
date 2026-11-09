import { children, createContext, createEffect, createSignal, createUniqueId, For, type JSX, Show, splitProps, useContext } from "solid-js";
import { Dynamic } from "solid-js/web";
import { Button } from "../actions/Button";
import { useUiMessages } from "../intl/messages";
import { useDetailPanelMessages } from "../layout/detail-panel-messages";

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

type SectionComponent = ((props: SectionProps) => JSX.Element) & {
  Part: (props: SectionPartProps) => JSX.Element;
};

const SectionLevel = createContext<number>(2);

/**
 * The frame a section draws when it passes none. A host that frames its topics itself, such as a detail panel, sets
 * `none`; everywhere else a section is a card.
 */
export const SectionFrameDefault = createContext<SectionFrame>("line");

const Heading = (props: { level: number; id?: string; class: string; children: JSX.Element }): JSX.Element => (
  <Dynamic component={`h${props.level}`} id={props.id} class={props.class}>
    {props.children}
  </Dynamic>
);

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
  const counts = useDetailPanelMessages();
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

  /** Icon, then the title with its count, state, and restricted marker in one row, then the description. */
  const headingRow = (title: JSX.Element, summary?: JSX.Element) => (
    <>
      <Show when={local.icon}>
        {(name) => (
          <span class="k2b-section__icon" aria-hidden="true">
            <i class={name()} />
          </span>
        )}
      </Show>
      <span class="k2b-section__copy">
        <span class="k2b-section__heading">
          {title}
          <Show when={local.count !== undefined}>
            <Show when={local.count! > 0} fallback={<span class="k2b-section__none">{counts().noneYet}</span>}>
              <span class="k2b-count-chip">{local.count}</span>
            </Show>
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
          {summary}
        </span>
        <Show when={local.description}>
          <span class="k2b-section__description">{local.description}</span>
        </Show>
      </span>
    </>
  );

  return (
    <section
      {...rest}
      class={local.class ? `k2b-section ${local.class}` : "k2b-section"}
      data-size={local.size ?? "sm"}
      data-frame={local.frame ?? frameDefault}
      data-tone={local.tone && local.tone !== "neutral" ? local.tone : undefined}
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
            {headingRow(
              <Heading level={level()} id={titleId} class="k2b-section__title">
                {local.title}
              </Heading>,
            )}
            <Show when={local.actions}>
              <div class="k2b-section__actions">{local.actions}</div>
            </Show>
          </header>
        }
      >
        {/* The whole heading row is one disclosure button inside the heading, so the region keeps its name. */}
        <Heading level={level()} class="k2b-section__header">
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
            {headingRow(
              <span id={titleId} class="k2b-section__title">
                {local.title}
              </span>,
              <Show when={local.summary}>
                <span class="k2b-section__summary k2b-truncate-fade">{local.summary}</span>
              </Show>,
            )}
            <span class="k2b-section__chevron" aria-hidden="true">
              <i class="ti ti-chevron-down" />
            </span>
          </button>
        </Heading>
      </Show>
      <Show when={hasBody()}>
        <div ref={body} id={bodyId} class="k2b-section__body" hidden={!open()}>
          <Show when={state() === "loading"}>
            {/* Placeholder rows at the height of loaded rows; their widths vary in CSS. */}
            <div role="status">
              <span class="k2b-sr-only">{ui().loading}</span>
              <For each={Array.from({ length: Math.max(1, local.loadingRows ?? 3) })}>
                {() => (
                  <div class="k2b-section__skeleton-row" aria-hidden="true">
                    <span />
                    <span />
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={state() === "error"}>
            <div class="k2b-section__error" role="alert">
              <i class="ti ti-alert-circle" aria-hidden="true" />
              <span>{local.errorMessage ?? ui().couldNotLoadData}</span>
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
    <div class={props.class ? `k2b-section__part ${props.class}` : "k2b-section__part"} role="group" aria-labelledby={id}>
      <Heading level={Math.min(level + 1, 6)} id={id} class="k2b-section__part-title">
        {props.title}
      </Heading>
      {props.children}
    </div>
  );
};

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
