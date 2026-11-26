import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import type { PresentationMode } from "../../../../lib/presentation-mode";
import type { NoteGraph } from "../../../../service/links";
import { buildNoteUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import { NOTE_SOFT_NAVIGATED_EVENT } from "../detail/events";
import { layoutNetworkInSlices, type NetPoint } from "./layout-net";
import { buildGraphModel, type GraphArea, matchesQuery, visibleEdges, visibleNotes } from "./model";
import type { GraphZoomControls } from "./NetworkDisplay";
import { type GraphViewState, normalizeGraphViewState, PHONE_GRAPH_QUERY, resolveGraphDisplay, writeGraphViewState } from "./view-state";

const SEARCH_URL_DELAY_MS = 300;
const URL_RETRY_MS = 1000;

export type GraphProps = {
  notebookId: string;
  notebookName: string;
  /** The note the graph was opened from: it is labelled and ringed in the app's accent. */
  selectedNoteId: string | null;
  graph: NoteGraph;
  from?: PresentationMode;
  backHref?: string;
  /** View state parsed from the URL on the server, so the first paint shows the same display, filters and search. */
  view: GraphViewState;
  /** Server time, the base for relative dates on both sides. */
  now: string;
  /** The viewer's timezone from the request date config, used for date groups. */
  timeZone: string;
};

/**
 * The state of the Links graph of one notebook, shared by its frames: the view in the address, the visible notes and
 * links, the search, the centre, and the ways out of an empty state. The URL owns the view state; changes replace the
 * history entry, and opening a note is a normal navigation, so Back returns to the same display, filters and search.
 */
export const useGraphView = (
  props: GraphProps,
  /** The frame's root and the selector of its empty states, so a way out hands the focus to what replaces it. */
  frame: { root: () => HTMLElement | undefined; empty: string },
) => {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const model = buildGraphModel(props.graph, locale());
  const hasLinks = model.edges.length > 0;
  const [state, setState] = createSignal<GraphViewState>(props.view);
  const [centreId, setCentreId] = createSignal(
    props.selectedNoteId && model.byId.has(props.selectedNoteId) ? props.selectedNoteId : (model.notes[0]?.id ?? null),
  );
  let centreChanged = false;
  const [phone, setPhone] = createSignal<boolean | null>(
    typeof window === "undefined" ? null : window.matchMedia(PHONE_GRAPH_QUERY).matches,
  );
  const display = createMemo(() => resolveGraphDisplay(state().display, phone()));
  const [controls, setControls] = createSignal<GraphZoomControls | null>(null);
  let focusRequest: ((id?: string) => void) | undefined;
  const setFocusNote = (focus: (id?: string) => void) => {
    focusRequest = focus;
  };
  const focusNote = (id?: string) => focusRequest?.(id);

  // The address follows the state. Typing in the search writes it once the typing pauses, since Safari limits how
  // often a page may replace its history entry; a write it refuses is tried again, and leaving the page writes first.
  let urlTimer: ReturnType<typeof setTimeout> | undefined;
  const writeUrl = () => {
    clearTimeout(urlTimer);
    urlTimer = undefined;
    const url = writeGraphViewState(new URL(window.location.href), state());
    if (centreChanged && centreId()) {
      // A note in the path wins over `note` on the server, so a recentred graph moves to the notebook's graph address.
      url.pathname = url.pathname.replace(/\/notes\/[^/]+\/?$/, "");
      url.searchParams.set("note", centreId()!);
    }
    try {
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    } catch {
      urlTimer = setTimeout(writeUrl, URL_RETRY_MS);
    }
  };
  const flushUrl = () => {
    if (urlTimer !== undefined) writeUrl();
  };
  // The state is normalized with the URL's own limits first, so what renders is what a reload restores.
  const update = (patch: Partial<GraphViewState>) => {
    setState(normalizeGraphViewState({ ...state(), ...patch }));
    if (Object.keys(patch).every((key) => key === "q")) {
      clearTimeout(urlTimer);
      urlTimer = setTimeout(writeUrl, SEARCH_URL_DELAY_MS);
    } else writeUrl();
  };
  const recenter = (id: string) => {
    if (!model.byId.has(id) || id === centreId()) return;
    if (props.graph.scope) {
      // A large notebook's graph holds only the pages around one page; the graph around the chosen one loads anew.
      const url = writeGraphViewState(new URL(window.location.href), state());
      url.pathname = url.pathname.replace(/\/notes\/[^/]+\/?$/, "");
      url.searchParams.set("note", id);
      flushUrl();
      navigateTo(`${url.pathname}${url.search}`);
      return;
    }
    setCentreId(id);
    centreChanged = true;
    writeUrl();
    // The shell must follow the graph's current note before a reload, too.
    window.dispatchEvent(
      new CustomEvent(NOTE_SOFT_NAVIGATED_EVENT, { detail: { noteId: id, href: `${location.pathname}${location.search}` } }),
    );
  };
  onMount(() => {
    const media = window.matchMedia(PHONE_GRAPH_QUERY);
    const changed = () => setPhone(media.matches);
    media.addEventListener("change", changed);
    onCleanup(() => media.removeEventListener("change", changed));
    window.addEventListener("pagehide", flushUrl);
    onCleanup(() => {
      window.removeEventListener("pagehide", flushUrl);
      clearTimeout(urlTimer);
    });
  });

  // The search changes neither the visible notes nor the view; only the filters do.
  const filterKey = createMemo(() => `${state().links}|${state().hide.join(",")}`);
  // Without links there are no filters to show, so a saved filter in the address does not apply either.
  const notes = createMemo(() => {
    filterKey();
    return hasLinks ? untrack(() => visibleNotes(model, { links: state().links, hide: state().hide })) : model.notes;
  });
  const visibleIds = createMemo(() => new Set(notes().map((note) => note.id)));
  const edges = createMemo(() => visibleEdges(model, visibleIds()));
  const query = () => state().q;
  const hits = createMemo(() => (query().trim() ? notes().filter((note) => matchesQuery(note, query())) : []));
  const currentId = centreId;
  const current = () => (currentId() ? model.byId.get(currentId()!) : undefined);
  const noteHref = (id: string) => buildNoteUrl(props.notebookId, id, props.from);
  const open = (id: string, newTab = false) => {
    if (newTab) {
      window.open(noteHref(id), "_blank", "noopener");
      return;
    }
    flushUrl();
    navigateTo(noteHref(id));
  };
  // The layout runs once, when the network first shows, and is kept while the frame lives, so returning from the list
  // or from an empty filter does not arrange the notes again or undo a drag.
  const layoutAbort = new AbortController();
  onCleanup(() => layoutAbort.abort());
  let layout: Promise<Map<string, NetPoint> | null> | undefined;
  const networkLayout = () => {
    layout ??= layoutNetworkInSlices(model, layoutAbort.signal);
    return layout;
  };
  const closeHref = () =>
    props.backHref ??
    (current()
      ? buildNoteUrl(props.notebookId, current()!.id, props.from)
      : `/app/notebooks/${props.notebookId}${props.from ? `?mode=${props.from}` : ""}`);
  // A way out of an empty state replaces the button that had focus. Focus moves to the graph that replaces it, or to
  // the next empty state's first action, never to the page start.
  let focusGraph = false;
  const claimFocus = () => focusGraph;
  const leaveEmpty = (patch: Partial<GraphViewState>) => {
    focusGraph = !!document.activeElement?.closest(frame.empty);
    update(patch);
    if (!focusGraph) return;
    focusGraph = false;
    queueMicrotask(() => {
      const root = frame.root();
      if (root && !root.contains(document.activeElement)) root.querySelector<HTMLElement>(`${frame.empty} :is(button, a[href])`)?.focus();
    });
  };
  const resetFilters = () => leaveEmpty({ links: "all", hide: [] });
  const toggleArea = (key: string) => {
    const hide = state().hide;
    update({ hide: hide.includes(key) ? hide.filter((item) => item !== key) : [...hide, key] });
  };
  const areaName = (area: GraphArea) => (area.index === 0 ? t().graphTopLevel : area.title || t().untitled);
  const showsGraph = () =>
    !state().list &&
    display() !== "timeline" &&
    hasLinks &&
    notes().length > 0 &&
    (display() !== "neighborhood" || notes().some((note) => current()?.neighbours.has(note.id)));

  return {
    t,
    model,
    hasLinks,
    state,
    display,
    controls,
    setControls,
    focusNote,
    setFocusNote,
    update,
    recenter,
    filterKey,
    notes,
    visibleIds,
    edges,
    query,
    hits,
    currentId,
    current,
    noteHref,
    open,
    networkLayout,
    closeHref,
    claimFocus,
    leaveEmpty,
    resetFilters,
    toggleArea,
    areaName,
    showsGraph,
  };
};

export type GraphView = ReturnType<typeof useGraphView>;
