import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities";
import { type GeoAddress, GeoErrorDetailsSchema, geoContract, geoRouteContract } from "@k2b/cloud/contracts";
import {
  GEO_DOCUMENT_MAX_PINS,
  type GeoDocument,
  GeoDocumentLinkSchema,
  type GeoDocumentPin,
  GeoDocumentSchema,
} from "@k2b/cloud/geo/document";
import { CloudMap } from "@k2b/cloud/geo/ui";
import { Button, Dropdown, LocaleProvider, Select, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal, createUniqueId, For, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import { apiClient } from "../../api/client";
import {
  mapBlocked,
  mapLinkHref,
  mapMarkers,
  mapStateMessage,
  type NotebookMapState,
  routeMetrics,
  routeSummary,
} from "../../lib/map-blocks";
import { notebookMapMessages } from "../../lib/map-messages";
import { openNoteLinkPrompt } from "../[id]/_components/search/openNoteSearchPrompt";

type Edit = (document: GeoDocument) => boolean;
type Props = { document: GeoDocument; state: NotebookMapState; notebookId: string; mode: string; onChange?: Edit };

type GeoFailure = { code: string; details?: unknown };
function failureState(error: GeoFailure, state: NotebookMapState): NotebookMapState {
  if (error.code === "GEO_NOT_CONFIGURED")
    return {
      ...state,
      availability: {
        configured: false,
        cloud: { exhausted: false, resetsAt: "1970-01-01T00:00:00Z" },
        person: { exhausted: false, resetsAt: "1970-01-01T00:00:00Z" },
      },
    };
  const details = GeoErrorDetailsSchema.safeParse({
    ...(typeof error.details === "object" && error.details !== null ? error.details : {}),
    code: error.code,
  });
  if (error.code === "GEO_BUDGET_EXHAUSTED" && details.success && details.data.code === "GEO_BUDGET_EXHAUSTED") {
    const { scope, resetsAt } = details.data;
    const available = state.availability ?? {
      configured: true,
      cloud: { exhausted: false, resetsAt },
      person: { exhausted: false, resetsAt },
    };
    return { ...state, availability: { ...available, [scope]: { exhausted: true, resetsAt } } };
  }
  return { ...state, failed: true };
}

/** Interaction lives in this app; the tile renderer and its failure recovery remain public CloudMap behavior. */
export function NotebookMap(props: Props) {
  const locale = useLocale();
  const t = () => notebookMapMessages.resolve([locale()]).t;
  const [document, setDocument] = createSignal(props.document);
  const [state, setState] = createSignal(props.state);
  const [availabilityPending, setAvailabilityPending] = createSignal(!props.state.availability);
  const [selected, setSelected] = createSignal(props.document.pins[0]?.id);
  const [listMode, setListMode] = createSignal(false);
  const [search, setSearch] = createSignal("");
  const [suggestions, setSuggestions] = createSignal<GeoAddress[] | undefined>();
  const [searching, setSearching] = createSignal(false);
  const [searchIndex, setSearchIndex] = createSignal(0);
  const [error, setError] = createSignal("");
  const [retryAction, setRetryAction] = createSignal<"search" | "route" | "availability">("search");
  const [draft, setDraft] = createSignal<{ pin: GeoDocumentPin; adding: boolean }>();
  const [linkType, setLinkType] = createSignal("url");
  const [linkLabel, setLinkLabel] = createSignal("");
  const [url, setUrl] = createSignal("");
  const [note, setNote] = createSignal<{ id: string; title: string }>();
  const [headings, setHeadings] = createSignal<{ id: string; label: string }[]>([]);
  const [heading, setHeading] = createSignal<string | null>(null);
  const [linkLoading, setLinkLoading] = createSignal(false);
  const [routeEditor, setRouteEditor] = createSignal(false);
  const [calculating, setCalculating] = createSignal(false);
  const [mode, setMode] = createSignal("car");
  const id = createUniqueId();
  const routeOnly = () => !!document().route && !document().pins.length;
  const blocked = () => mapBlocked(state());
  const showMap = () => !blocked() && !listMode();
  const active = createMemo(() => document().pins.find((pin) => pin.id === selected()));
  let list!: HTMLDivElement;
  let body!: HTMLDivElement;
  const [compact, setCompact] = createSignal(false);
  onMount(() => {
    const measure = () => setCompact(body.clientWidth <= 600);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    onCleanup(() => observer.disconnect());
  });
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchAbort: AbortController | undefined;
  let routeAbort: AbortController | undefined;
  let headingAbort: AbortController | undefined;
  const lifetime = new AbortController();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    lifetime.abort();
    headingAbort?.abort();
    searchAbort?.abort();
    routeAbort?.abort();
    clearTimeout(searchTimer);
  });

  const refreshAvailability = async () => {
    setAvailabilityPending(true);
    setRetryAction("availability");
    const result = await invokeCapabilityWithDataSchema(
      { kind: "query", appId: "core", capabilityId: geoContract.availability.id, input: {}, signal: lifetime.signal },
      geoContract.availability.data,
    );
    if (disposed) return;
    setAvailabilityPending(false);
    if (result.ok) {
      setState((previous) => ({ ...previous, availability: result.data.data, failed: false }));
      setError("");
    } else {
      setState((previous) => failureState(result.error, previous));
      setError(t().failed);
    }
  };
  onMount(() => {
    if (!props.state.availability) void refreshAvailability();
  });
  const commit = (next: GeoDocument) => {
    next = { ...next, savedAt: new Date().toISOString() };
    const validated = GeoDocumentSchema.safeParse(next);
    if (!validated.success) {
      setError(t().invalid);
      return false;
    }
    if (!props.onChange?.(validated.data)) {
      setError(t().conflict);
      return false;
    }
    setDocument(next);
    return true;
  };
  const runSearch = async () => {
    searchAbort?.abort();
    const text = search().trim();
    if (text.length < 3) {
      setSuggestions(undefined);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    searchAbort = controller;
    setSearching(true);
    setError("");
    setRetryAction("search");
    setSuggestions(undefined);
    const result = await invokeCapabilityWithDataSchema(
      {
        kind: "query",
        appId: "core",
        capabilityId: geoContract.autocomplete.id,
        input: { text, limit: 5, bias: document().pins[0]?.point },
        signal: controller.signal,
      },
      geoContract.autocomplete.data,
    );
    if (controller.signal.aborted || disposed) return;
    setSearching(false);
    if (result.ok) {
      setSuggestions(result.data.data.suggestions);
      setSearchIndex(0);
    } else {
      if (result.error.code === "GEO_NOT_CONFIGURED" || result.error.code === "GEO_BUDGET_EXHAUSTED")
        setState((previous) => failureState(result.error, previous));
      setError(result.error.code === "GEO_FORBIDDEN" ? t().forbidden : t().failed);
    }
  };
  const updateSearch = (value: string) => {
    setSearch(value);
    searchAbort?.abort();
    clearTimeout(searchTimer);
    setSuggestions(undefined);
    setSearching(value.trim().length >= 3);
    if (value.trim().length >= 3) searchTimer = setTimeout(() => void runSearch(), 300);
  };
  const beginLink = (pin: GeoDocumentPin, adding: boolean) => {
    const link = pin.link;
    setDraft({ pin, adding });
    setLinkType(link?.type ?? "url");
    setLinkLabel(link?.label ?? pin.label);
    setUrl(link?.type === "url" ? link.url : "");
    setNote(link && link.type !== "url" ? { id: link.noteId, title: link.label } : undefined);
    setHeading(link?.type === "heading" ? link.heading : null);
    setHeadings([]);
    setError("");
    setSuggestions(undefined);
    searchAbort?.abort();
    setSearching(false);
    if (link?.type === "heading") void loadHeadings(link.noteId);
  };
  const choose = (address: GeoAddress) => {
    if (document().pins.length >= GEO_DOCUMENT_MAX_PINS) {
      setError(t().maxPins);
      return;
    }
    beginLink(
      {
        id: crypto.randomUUID(),
        label: (address.line1 || address.formatted).slice(0, 300),
        point: address.point,
        provenance: address.provenance,
      },
      true,
    );
  };
  const loadHeadings = async (noteId: string) => {
    headingAbort?.abort();
    const controller = new AbortController();
    headingAbort = controller;
    setLinkLoading(true);
    try {
      const response = await apiClient[":id"].notes[":noteId"]["block-preview"].$post(
        { param: { id: props.notebookId, noteId }, json: {} },
        { init: { signal: AbortSignal.any([lifetime.signal, controller.signal]) } },
      );
      if (!response.ok) throw new Error();
      const payload = await response.json();
      if (disposed || controller.signal.aborted || note()?.id !== noteId) return;
      setHeadings(payload.headings.map((entry) => ({ id: entry.id, label: entry.id.replace(/^heading-/, "").replaceAll("-", " ") })));
    } catch {
      if (!disposed && !controller.signal.aborted) setError(t().failed);
    } finally {
      if (!disposed && headingAbort === controller) setLinkLoading(false);
    }
  };
  const pickNote = async () => {
    const picked = await openNoteLinkPrompt(props.notebookId, locale());
    if (!picked || disposed) return;
    setNote(picked);
    setHeading(null);
    setLinkLabel(picked.title);
    await loadHeadings(picked.id);
  };
  const savePin = () => {
    const current = draft();
    if (!current) return;
    const kind = linkType();
    const candidate =
      kind === "url"
        ? { type: kind, url: url().trim(), label: linkLabel().trim() }
        : kind === "heading"
          ? { type: kind, noteId: note()?.id, heading: heading(), label: linkLabel().trim() }
          : { type: kind, noteId: note()?.id, label: linkLabel().trim() };
    const parsed = kind === "none" ? undefined : GeoDocumentLinkSchema.safeParse(candidate);
    if (parsed && !parsed.success) {
      setError(t().linkInvalid);
      return;
    }
    const { link: _old, ...pin } = current.pin;
    const nextPin = { ...pin, ...(parsed?.success ? { link: parsed.data } : {}) };
    const pins = current.adding ? [...document().pins, nextPin] : document().pins.map((pin) => (pin.id === nextPin.id ? nextPin : pin));
    if (commit({ ...document(), pins })) {
      setSelected(nextPin.id);
      setDraft(undefined);
      setSearch("");
    }
  };
  const calculate = async () => {
    if (document().pins.length < 2 || calculating()) return;
    const controller = new AbortController();
    routeAbort = controller;
    setCalculating(true);
    setError("");
    setRetryAction("route");
    const result = await invokeCapabilityWithDataSchema(
      {
        kind: "query",
        appId: "core",
        capabilityId: geoRouteContract.calculateRoute.id,
        input: {
          plan: {
            stops: document().pins.map((pin, index) => ({ id: `pin-${index + 1}`, point: pin.point, label: pin.label })),
            options: { mode: mode() },
          },
        },
        signal: AbortSignal.any([lifetime.signal, controller.signal]),
      },
      geoRouteContract.calculateRoute.data,
    );
    if (disposed || controller.signal.aborted) return;
    routeAbort = undefined;
    setCalculating(false);
    if (result.ok) commit({ ...document(), route: result.data.data.route });
    else {
      if (result.error.code === "GEO_NOT_CONFIGURED" || result.error.code === "GEO_BUDGET_EXHAUSTED")
        setState((previous) => failureState(result.error, previous));
      setError(t().failed);
    }
  };
  const selectKey = (event: KeyboardEvent) => {
    const pins = document().pins;
    let index = Math.max(
      0,
      pins.findIndex((pin) => pin.id === selected()),
    );
    if (event.key === "ArrowDown" || event.key === "ArrowRight") index = Math.min(pins.length - 1, index + 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") index = Math.max(0, index - 1);
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = pins.length - 1;
    else return;
    event.preventDefault();
    setSelected(pins[index]?.id);
    list.querySelectorAll<HTMLElement>("[data-pin-id]")[index]?.scrollIntoView({ block: "nearest" });
  };
  return (
    <>
      <figcaption class="notebook-map__header">
        <i class={`ti ti-${routeOnly() ? "route" : "map-2"}`} aria-hidden="true" />
        <strong>{document().title}</strong>
        <Show when={routeOnly()}>
          <span class="notebook-map__summary">{routeMetrics(document(), locale())}</span>
        </Show>
        <Dropdown.Root
          label={t().more}
          align="end"
          phone="sheet"
          items={[
            ...(!blocked()
              ? [{ label: listMode() ? t().showMap : t().showList, icon: "ti ti-map-2", action: () => setListMode((value) => !value) }]
              : []),
            ...(props.onChange && active()
              ? [
                  { label: t().editLink, icon: "ti ti-link", action: () => beginLink(active()!, false) },
                  {
                    label: t().remove,
                    icon: "ti ti-trash",
                    action: () => {
                      const next = { ...document(), pins: document().pins.filter((candidate) => candidate.id !== active()?.id) };
                      if (commit(next)) setSelected(next.pins[0]?.id);
                    },
                  },
                ]
              : []),
            ...(props.onChange && document().pins.length >= 2 && !blocked()
              ? [{ label: t().calculate, icon: "ti ti-route", action: () => setRouteEditor(true) }]
              : []),
          ]}
        >
          <Dropdown.Trigger iconOnly label={t().more} size="xs" variant="ghost">
            <i class="ti ti-dots" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </figcaption>
      <div ref={body} class="notebook-map__body">
        <Show when={props.onChange && !blocked() && !routeOnly()}>
          <div class="notebook-map__search">
            <TextInput
              aria-label={t().searchLabel}
              placeholder={t().search}
              icon="ti ti-search"
              value={search()}
              maxLength={300}
              onValueChange={updateSearch}
              disabled={document().pins.length >= GEO_DOCUMENT_MAX_PINS || !!draft()}
              role="combobox"
              aria-expanded={suggestions() !== undefined || searching()}
              aria-controls={`${id}-suggestions`}
              aria-activedescendant={suggestions()?.length ? `${id}-suggestion-${searchIndex()}` : undefined}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  searchAbort?.abort();
                  clearTimeout(searchTimer);
                  setSuggestions(undefined);
                  setSearching(false);
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSearchIndex((index) => Math.min((suggestions()?.length ?? 1) - 1, index + 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSearchIndex((index) => Math.max(0, index - 1));
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const suggestion = suggestions()?.[searchIndex()];
                  if (suggestion) choose(suggestion);
                  else void runSearch();
                }
              }}
            />
            <Show when={searching() || suggestions() !== undefined}>
              <div class="notebook-map__suggestions" id={`${id}-suggestions`} role="listbox" aria-label={t().searchLabel}>
                <Show when={searching()}>
                  <p role="status">{t().searching}</p>
                </Show>
                <Show when={suggestions()?.length === 0}>
                  <p role="status">{t().noMatches}</p>
                </Show>
                <For each={suggestions()}>
                  {(address, index) => (
                    <div role="option" id={`${id}-suggestion-${index()}`} aria-selected={index() === searchIndex()}>
                      <Button variant="ghost" onClick={() => choose(address)}>
                        <i class="ti ti-map-pin" aria-hidden="true" />
                        <span>
                          <strong>{address.line1 || address.formatted}</strong>
                          <small>{address.formatted}</small>
                        </span>
                      </Button>
                    </div>
                  )}
                </For>
                <p class="notebook-map__source">{t().source}</p>
              </div>
            </Show>
          </div>
        </Show>
        <Show when={mapStateMessage(state(), locale())}>
          <div class="notebook-map__notice" role="status">
            {mapStateMessage(state(), locale())}{" "}
            <Show when={state().canAdmin}>
              <a href="/admin/settings?tab=places">{state().availability?.configured ? t().changeLimit : t().configure}</a>
            </Show>
            <Button size="xs" variant="text" disabled={availabilityPending()} onClick={() => void refreshAvailability()}>
              {t().retry}
            </Button>
          </div>
        </Show>
        <Show when={showMap()}>
          <div class="notebook-map__viewport">
            <CloudMap
              height={routeOnly() ? (compact() ? 200 : 240) : compact() ? 230 : 320}
              markers={mapMarkers(document())}
              lines={document().route ? [{ id: "route", polyline6: document().route!.polyline6 }] : []}
              selectedId={selected()}
              onSelect={setSelected}
              availability={state().availability}
              empty={t().empty}
            />
          </div>
        </Show>
        <Show when={draft()}>
          {(current) => (
            <div class="notebook-map__link-editor" role="group" aria-label={t().linkTitle}>
              <strong>{current().pin.label}</strong>
              <Select
                label={t().linkType}
                value={linkType()}
                onValueChange={(value) => setLinkType(value ?? "none")}
                options={[
                  { id: "note", label: t().note },
                  { id: "heading", label: t().heading },
                  { id: "url", label: t().url },
                  { id: "none", label: t().noLink },
                ]}
              />
              <Show when={linkType() === "url"}>
                <TextInput label={t().urlLabel} type="url" value={url()} onValueChange={setUrl} />
              </Show>
              <Show when={linkType() === "note" || linkType() === "heading"}>
                <Button variant="secondary" onClick={() => void pickNote()}>
                  {note()?.title ?? t().chooseNote}
                </Button>
              </Show>
              <Show when={linkType() === "heading"}>
                <Select
                  label={t().heading}
                  placeholder={t().chooseHeading}
                  value={heading()}
                  onValueChange={setHeading}
                  options={headings()}
                  disabled={!note() || linkLoading()}
                />
              </Show>
              <Show when={linkType() !== "none"}>
                <TextInput label={t().linkLabel} value={linkLabel()} onValueChange={setLinkLabel} maxLength={300} />
              </Show>
              <div class="notebook-map__actions">
                <Button variant="primary" disabled={linkLoading()} onClick={savePin}>
                  {current().adding ? t().add : t().save}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    headingAbort?.abort();
                    setLinkLoading(false);
                    setDraft(undefined);
                    setError("");
                  }}
                >
                  {t().cancel}
                </Button>
              </div>
            </div>
          )}
        </Show>
        <Show
          when={document().pins.length}
          fallback={
            <Show when={!routeOnly()}>
              <div class="notebook-map__empty">
                <strong>{t().empty}</strong>
                <p>{t().emptyDetail}</p>
              </div>
            </Show>
          }
        >
          <div
            ref={list}
            class="notebook-map__pins"
            role="listbox"
            tabindex="0"
            aria-label={t().pins}
            aria-activedescendant={selected() ? `${id}-pin-${selected()}` : undefined}
            onKeyDown={selectKey}
          >
            <For each={document().pins}>
              {(pin, index) => (
                <div
                  class="notebook-map__pin"
                  data-pin-id={pin.id}
                  id={`${id}-pin-${pin.id}`}
                  role="option"
                  aria-selected={pin.id === selected()}
                  onClick={() => setSelected(pin.id)}
                  onKeyDown={(event) => {
                    if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      setSelected(pin.id);
                    }
                  }}
                >
                  <span class="notebook-map__number">{index() + 1}</span>
                  <span class="notebook-map__name">{pin.label}</span>
                  <Show when={pin.link}>
                    {(link) => (
                      <a
                        class="notebook-map__link"
                        data-reference={link().type === "url" ? "page" : link().type}
                        href={mapLinkHref(link(), props.notebookId, props.mode)}
                      >
                        <i
                          class={`ti ti-${link().type === "url" ? "link" : link().type === "heading" ? "heading" : "file-text"}`}
                          aria-hidden="true"
                        />
                        <span>{link().label}</span>
                      </a>
                    )}
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={document().route && !routeOnly()}>
          <p class="notebook-map__route-summary">{routeSummary(document(), locale())}</p>
        </Show>
        <Show when={props.onChange && routeEditor() && document().pins.length >= 2 && !blocked()}>
          <p class="notebook-map__route-summary">{t().routeHint}</p>
          <div class="notebook-map__actions">
            <Select
              label={t().mode}
              disabled={calculating()}
              value={mode()}
              onValueChange={(value) => setMode(value ?? "car")}
              options={[
                { id: "car", label: t().car },
                { id: "bike", label: t().bike },
                { id: "walk", label: t().walk },
              ]}
            />
            <Button size="xs" variant="ghost" disabled={calculating()} onClick={() => void calculate()}>
              {calculating() ? t().calculating : t().calculate}
            </Button>
            <Show when={calculating()}>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  routeAbort?.abort();
                  setCalculating(false);
                }}
              >
                {t().cancel}
              </Button>
            </Show>
            <Show when={!calculating()}>
              <Button size="xs" variant="ghost" onClick={() => setRouteEditor(false)}>
                {t().cancel}
              </Button>
            </Show>
          </div>
        </Show>
        <Show when={error()}>
          <div class="notebook-map__notice" role="alert">
            {error()}{" "}
            <Show when={!draft() && !blocked()}>
              <Button
                size="xs"
                variant="text"
                onClick={() =>
                  void (retryAction() === "route" ? calculate() : retryAction() === "availability" ? refreshAvailability() : runSearch())
                }
              >
                {t().retry}
              </Button>
            </Show>
          </div>
        </Show>
        <Show when={showMap()}>
          <div class="notebook-map__print-fallback">
            <p>{t().printFailed}</p>
            <Show when={document().route}>
              <p>{routeSummary(document(), locale())}</p>
            </Show>
            <p>{document().route ? t().routeSource : t().source}</p>
          </div>
        </Show>
        <Show when={blocked() || listMode()}>
          <p class="notebook-map__source">{document().route ? t().routeSource : t().source}</p>
          <Show when={routeOnly()}>
            <p>{routeSummary(document(), locale())}</p>
          </Show>
        </Show>
      </div>
    </>
  );
}

/** Both Book and CodeMirror enhance the exact authorized document in the server's HTML. */
export function enhanceNotebookMaps(
  root: HTMLElement,
  locale: string,
  onChange?: (previous: GeoDocument, next: GeoDocument) => boolean,
): () => void {
  const cleanups: (() => void)[] = [];
  for (const figure of root.querySelectorAll<HTMLElement>("figure.notebook-map[data-map-document]:not([data-map-enhanced])")) {
    const original = figure.innerHTML;
    try {
      const document = GeoDocumentSchema.parse(JSON.parse(figure.dataset.mapDocument!));
      const state: NotebookMapState = JSON.parse(figure.dataset.mapState ?? "{}");
      figure.replaceChildren();
      let previous = document;
      const dispose = render(
        () => (
          <LocaleProvider locale={locale}>
            <NotebookMap
              document={document}
              state={state}
              notebookId={figure.dataset.notebook!}
              mode={figure.dataset.mapMode ?? "book"}
              onChange={
                onChange
                  ? (next) => {
                      const applied = onChange(previous, next);
                      if (applied) previous = next;
                      return applied;
                    }
                  : undefined
              }
            />
          </LocaleProvider>
        ),
        figure,
      );
      figure.dataset.mapEnhanced = "";
      cleanups.push(() => {
        dispose();
        delete figure.dataset.mapEnhanced;
        figure.innerHTML = original;
      });
    } catch {
      figure.innerHTML = original;
      const status = document.createElement("p");
      status.className = "notebook-map__notice";
      status.setAttribute("role", "status");
      status.textContent = notebookMapMessages.resolve([locale]).t.unavailable;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = notebookMapMessages.resolve([locale]).t.retry;
      retry.addEventListener("click", () => window.location.reload());
      status.append(" ", retry);
      figure.append(status);
      cleanups.push(() => {
        status.remove();
        figure.innerHTML = original;
      });
    }
  }
  return () => cleanups.reverse().forEach((cleanup) => cleanup());
}
