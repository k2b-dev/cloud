import { createEffect, createMemo, createSignal, createUniqueId, type JSX, Match, on, onCleanup, Show, Switch } from "solid-js";
import { isServer } from "solid-js/web";
import { Button } from "../actions/Button";
import { Tooltip } from "../feedback/Tooltip";
import type { FieldSuggestion } from "./field-contract";
import { resolveMaybeAccessor } from "./field-contract";
import { FieldSuggestionContext } from "./field-suggestion-slot";
import type { FieldSuggestionControl, FieldSuggestionOptions, FieldSuggestionView } from "./field-suggestion-types";
import { type SuggestionMessages, useSuggestionMessages } from "./suggestion-messages";

/** The one rule every field follows: a suggestion never replaces what someone entered. */
export function deriveSuggestionView<T>(
  suggestion: FieldSuggestion<T> | undefined,
  value: T | null | undefined,
  field: { blank: boolean; edited: boolean; same: (left: T, right: T) => boolean },
): FieldSuggestionView {
  if (!suggestion) return "none";
  if (suggestion.state !== "ready") return suggestion.state;
  if (value !== null && value !== undefined && field.same(value, suggestion.value)) return suggestion.accepted ? "accepted" : "matches";
  if (field.blank && !field.edited && !suggestion.accepted) return "open";
  return "differs";
}

type GroupEntry = {
  id: () => string | undefined;
  view: () => FieldSuggestionView;
  low: () => boolean;
  eligible: () => boolean;
  label: () => string | undefined;
};

type Group = { source: () => string | undefined; register: (entry: GroupEntry) => () => void };

/** What the shared status line needs. */
type FieldSuggestionStatusModel = {
  id: string;
  view: () => FieldSuggestionView;
  low: () => boolean;
  reason: () => string | undefined;
  source: () => string | undefined;
  text: () => string;
  label: () => string | undefined;
  locked: () => boolean;
  description: () => string;
  announcement: () => string;
  accept: () => void;
  retry: (() => void) | undefined;
};

const formatter =
  <T,>(options: FieldSuggestionOptions<T>, messages: () => SuggestionMessages) =>
  (value: T): string =>
    options.format ? options.format(value) : typeof value === "boolean" ? (value ? messages().yes : messages().no) : String(value);

/** The shared part of every field's suggestion: state, status line, announcements, and accept-all membership. */
function createFieldSuggestion<T>(options: FieldSuggestionOptions<T>, group: Group): FieldSuggestionControl<T> {
  const messages = useSuggestionMessages();
  const format = formatter(options, messages);
  const [edited, setEdited] = createSignal(false);
  const [announcement, setAnnouncement] = createSignal("");
  const same = options.same ?? Object.is;
  const suggestion = () => (options.enabled ? resolveMaybeAccessor(options.props.suggestion) : undefined);
  const ready = () => {
    const current = suggestion();
    return current?.state === "ready" ? current : undefined;
  };
  const view = createMemo(() => deriveSuggestionView(suggestion(), options.value(), { blank: options.blank(), edited: edited(), same }));
  const source = () => suggestion()?.source ?? group.source();
  const text = () => {
    const current = ready();
    return current ? (current.label ?? format(current.value)) : "";
  };
  const low = () => ready()?.confidence === "low";
  const label = () => (typeof options.props.label === "string" ? options.props.label : options.props["aria-label"]);
  const statusId = `${options.meta.controlId}-suggestion`;
  const description = () => {
    const unsure = low() ? ` ${messages().describeUnsure({ reason: ready()?.reason })}` : "";
    switch (view()) {
      case "loading":
        return messages().describeLoading({ source: source() });
      case "error":
        return messages().describeFailed;
      case "open":
        return `${messages().describeOpen({ source: source(), value: options.spokenValue ? text() : undefined })}${unsure}`;
      case "differs":
        return `${messages().describeOffered({ source: source(), value: text() })}${unsure}`;
      case "accepted":
        return messages().describeAccepted({ source: source() });
      default:
        return "";
    }
  };
  // A value the field would not take as it is (outside its limits, off its step, a disabled option) offers no Accept.
  const blocked = () => {
    const current = ready();
    return options.locked() || (current !== undefined && options.acceptable?.(current.value) === false);
  };
  const accept = () => {
    const current = ready();
    if (!current || blocked()) return;
    // The owner's callbacks may replace the suggestion, so what was accepted is read first.
    const { id, value, label: named } = current;
    const said = messages().announceAccepted({ label: label(), value: text() });
    options.props.onSuggestionAccept?.(id);
    options.apply(value, named);
    setAnnouncement(said);
    // The accept button goes away with the open suggestion, so focus continues in the field.
    if (!isServer) document.getElementById(options.meta.controlId)?.focus();
  };

  // A new suggestion for a field that holds someone's own value is said once; the value stays.
  createEffect(
    on(
      () => ready()?.id,
      (id, previous) => {
        const own = options.value();
        if (!id || id === previous || view() !== "differs" || own === null || own === undefined) return;
        setAnnouncement(messages().announceOffered({ source: source(), label: label(), value: text(), own: format(own) }));
      },
      { defer: true },
    ),
  );

  onCleanup(
    group.register({
      id: () => suggestion()?.id,
      view,
      low,
      eligible: () => view() === "open" && !low() && !blocked() && !options.invalid(),
      label,
    }),
  );

  const model: FieldSuggestionStatusModel = {
    id: statusId,
    view,
    low,
    reason: () => ready()?.reason,
    source,
    text,
    label,
    locked: blocked,
    description,
    announcement,
    accept,
    get retry() {
      const current = suggestion();
      return current?.state === "error" ? current.onRetry : undefined;
    },
  };

  return {
    enabled: true,
    view,
    value: () => ready()?.value,
    placeholder: () => (view() === "open" ? text() : undefined),
    state: () => {
      const current = view();
      if (current === "open") return low() ? "open-unsure" : "open";
      return current === "loading" && options.blank() && !edited() ? current : undefined;
    },
    describedBy: () => (description() ? statusId : undefined),
    edited: () => setEdited(true),
    inline: () => (view() === "open" ? messages().switchValue({ value: text() }) : undefined),
    status: () => <FieldSuggestionStatus model={model} />,
  };
}

/** The status line beside a field's label: what the suggestion is, and Accept. Its size never changes. */
function FieldSuggestionStatus(props: { model: FieldSuggestionStatusModel }): JSX.Element {
  const messages = useSuggestionMessages();
  const model = props.model;
  const offered = () => model.view() === "open" || model.view() === "differs";
  const unsureNote = () => model.view() === "open" && model.low();
  const content = () => (
    <>
      <Switch>
        <Match when={model.view() === "loading"}>
          <span class="k2b-ai-suggestion__note" aria-hidden="true">
            <i class="ti ti-sparkles" />
            <span class="k2b-ai-suggestion__text">{messages().loading({ source: model.source() })}</span>
          </span>
        </Match>
        <Match when={model.view() === "error"}>
          <span class="k2b-ai-suggestion__note" aria-hidden="true">
            <i class="ti ti-sparkles-off" />
            <span class="k2b-ai-suggestion__text">{messages().failed}</span>
          </span>
          <Show when={!model.locked() && model.retry}>
            {(retry) => (
              <Button type="button" variant="text" size="xs" class="k2b-ai-suggestion__action" onClick={() => retry()()}>
                <i class="ti ti-refresh" aria-hidden="true" />
                {messages().retry}
              </Button>
            )}
          </Show>
        </Match>
        <Match when={model.view() === "accepted"}>
          <span class="k2b-ai-suggestion__note" aria-hidden="true">
            <i class="ti ti-sparkles" />
            <span class="k2b-ai-suggestion__text">{messages().acceptedFrom({ source: model.source() })}</span>
          </span>
        </Match>
        <Match when={model.view() !== "none"}>
          <span class="k2b-ai-suggestion__note" data-tone={unsureNote() ? "warning" : undefined} aria-hidden="true">
            <i class={unsureNote() ? "ti ti-alert-triangle" : "ti ti-sparkles"} />
            {/* A long suggested value gives way to the label and Accept; pointing at it shows it whole. */}
            <span class="k2b-ai-suggestion__text" title={model.view() === "differs" ? model.text() : undefined}>
              {unsureNote()
                ? messages().unsure
                : model.view() === "differs" && !model.locked()
                  ? messages().offered({ source: model.source(), value: model.text() })
                  : messages().suggestion}
            </span>
          </span>
          <Show when={offered() && !model.locked()}>
            <Button
              type="button"
              variant="text"
              size="xs"
              class="k2b-ai-suggestion__action"
              aria-label={messages().acceptFor({ label: model.label() })}
              onClick={() => model.accept()}
            >
              <i class="ti ti-check" aria-hidden="true" />
              {messages().accept}
            </Button>
          </Show>
        </Match>
      </Switch>
    </>
  );

  return (
    <span class="k2b-ai-suggestion" data-view={model.view()} data-locked={model.locked() ? "true" : undefined}>
      <span id={model.id} class="k2b-sr-only">
        {model.description()}
      </span>
      <span class="k2b-sr-only" aria-live="polite">
        {model.announcement()}
      </span>
      {/* An uncertain value explains itself on hover and on focus of Accept; the field's description says it too. */}
      <Show when={model.low() && offered() && model.reason()} fallback={content()}>
        {(reason) => (
          <Tooltip.Anchor class="k2b-ai-suggestion__reason" content={reason()}>
            {content()}
          </Tooltip.Anchor>
        )}
      </Show>
    </span>
  );
}

export type SuggestionGroupProps = {
  /**
   * The line above the fields, such as "Gustav read 8 fields from RE-4471.pdf", or what is still loading. Screen
   * readers hear it when it changes. Defaults to "Suggestions from {source}".
   */
  title?: JSX.Element;
  /** Who proposes the values; fields without their own `source` use it. */
  source?: string;
  /** Called once with every open, certain suggestion of an enabled, valid field. Apply them as one form change. */
  onAcceptAll: (ids: string[]) => void;
  /** Shown while a field's suggestion failed. */
  onRetryAll?: () => void;
  class?: string;
  children: JSX.Element;
};

/** Groups fields with suggestions under one line: counts and "Accept all" for the certain ones. */
export function SuggestionGroup(props: SuggestionGroupProps): JSX.Element {
  const messages = useSuggestionMessages();
  const titleId = `k2b-suggestion-group-${createUniqueId()}`;
  const [entries, setEntries] = createSignal<readonly GroupEntry[]>([]);
  const [announcement, setAnnouncement] = createSignal("");
  const register = (entry: GroupEntry) => {
    setEntries((list) => [...list, entry]);
    return () => setEntries((list) => list.filter((item) => item !== entry));
  };
  // The fields register while they render, so render them before the line that counts them; server and browser agree.
  const group: Group = { source: () => props.source, register };
  const fields = (
    <FieldSuggestionContext.Provider value={(options) => createFieldSuggestion(options, group)}>
      {props.children}
    </FieldSuggestionContext.Provider>
  );
  const tally = createMemo(() => {
    let accepted = 0;
    let open = 0;
    let unsure = 0;
    let loading = false;
    let failed = false;
    for (const entry of entries()) {
      const view = entry.view();
      if (view === "accepted") accepted++;
      else if (view === "open") entry.low() ? unsure++ : open++;
      else if (view === "loading") loading = true;
      else if (view === "error") failed = true;
    }
    return { accepted, open, unsure, loading, failed };
  });
  const eligible = () => entries().filter((entry) => entry.eligible());
  const counts = () =>
    [
      tally().accepted ? messages().countAccepted({ count: tally().accepted }) : "",
      tally().open ? messages().countOpen({ count: tally().open }) : "",
      tally().unsure ? messages().countUnsure({ count: tally().unsure }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  const acceptAll = () => {
    const ids = eligible()
      .map((entry) => entry.id())
      .filter((id): id is string => Boolean(id));
    if (!ids.length) return;
    const unsure = entries()
      .filter((entry) => entry.view() === "open" && entry.low())
      .map((entry) => entry.label() ?? "")
      .filter(Boolean);
    props.onAcceptAll(ids);
    setAnnouncement(messages().announceAcceptedAll({ count: ids.length, unsure }));
  };

  return (
    <div
      class={`k2b-ai-suggestion-group ${props.class ?? ""}`}
      role="group"
      aria-labelledby={titleId}
      aria-busy={tally().loading ? "true" : undefined}
    >
      <div class="k2b-ai-suggestion-group__bar">
        <i class="ti ti-sparkles k2b-ai-suggestion-group__icon" aria-hidden="true" />
        <p class="k2b-ai-suggestion-group__summary">
          <span id={titleId} class="k2b-ai-suggestion-group__title" aria-live="polite">
            {props.title ?? messages().groupTitle({ source: props.source })}
          </span>
          <span class="k2b-ai-suggestion-group__counts">{counts()}</span>
        </p>
        <Show when={tally().failed && props.onRetryAll}>
          {(retry) => (
            // On a phone the line keeps its title; Retry shows only its icon there and keeps its name.
            <Button
              type="button"
              variant="text"
              size="xs"
              class="k2b-ai-suggestion__action"
              aria-label={messages().retryAll}
              onClick={() => retry()()}
            >
              <i class="ti ti-refresh" aria-hidden="true" />
              <span class="k2b-ai-suggestion-group__retry-label">{messages().retryAll}</span>
            </Button>
          )}
        </Show>
        {/* aria-disabled keeps focus on the button after it accepted everything it could. */}
        <Button
          type="button"
          variant="ai"
          size="sm"
          class="k2b-ai-suggestion-group__accept"
          aria-disabled={eligible().length ? undefined : "true"}
          onClick={acceptAll}
        >
          <i class="ti ti-checks" aria-hidden="true" />
          {messages().acceptAll({ count: eligible().length })}
        </Button>
      </div>
      <span class="k2b-sr-only" aria-live="polite">
        {announcement()}
      </span>
      {fields}
    </div>
  );
}
