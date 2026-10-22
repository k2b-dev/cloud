import type { MapViewLine, MapViewMarker, MapViewOwnLocation } from "@k2b/ui";
import { Button, ButtonLink, Checkbox, NumberInput, Select, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { z } from "zod";
import { requestSearchNavigation } from "../../browser/search-bridge";
import type { GeoCategorySchema } from "../../contracts/geo";
import type { GeoRouteOptions } from "../../contracts/geo-route";
import { CloudMap } from "../../geo/CloudMap";
import { geoNavigationHref, geoNavigationPlatform } from "../../geo/navigation";
import { type AiMap, type AiMapCommand, AiMapReferenceSchema, AiMapSchema, AiMapToolResultSchema } from "../map-contracts";
import { mapOpeningHours } from "../map-opening-hours";
import type { AiTurnBlock } from "../protocol";
import { mapMessages } from "./map-messages";
import { MapNotebookSave } from "./map-notebook";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
const responseSchema = z.object({ map: AiMapSchema, canAdmin: z.boolean().optional() });
const eventName = "cloud:assistant-map";
const safeWebsite = (url: string | undefined) => (url && /^https?:\/\//i.test(url) ? url : undefined);
export const mapAnchor = (id: string) => `assistant-map-${id}`;

/** Native result at the shared chat result seam, including follow-up links. Never an HTML artifact. */
export function AiMapToolBlock(props: { block: ToolBlock }) {
  const parsed = createMemo(() => {
    const result = AiMapToolResultSchema.safeParse(props.block.result);
    return result.success ? result.data : null;
  });
  const locale = useLocale();
  const t = () => mapMessages(locale());
  const initialFull = AiMapSchema.safeParse(parsed()?.map);
  const [loaded, setLoaded] = createSignal<AiMap | undefined>(initialFull.success ? initialFull.data : undefined);
  createEffect(() => {
    const result = parsed();
    if (!result) return;
    const full = AiMapSchema.safeParse(result.map);
    if (full.success) setLoaded(full.data);
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(eventName, { detail: result.map }));
    if (full.success || !result.anchor) return;
    const abort = new AbortController();
    onCleanup(() => abort.abort());
    void fetch(`/api/ai/conversations/${encodeURIComponent(result.map.conversationId)}/maps/${result.map.id}`, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("MAP_LOAD_FAILED");
        const value = responseSchema.parse(await response.json());
        if (!abort.signal.aborted) setLoaded(value.map);
      })
      .catch(() => {
        if (!abort.signal.aborted) setLoadFailed(true);
      });
  });
  const [loadFailed, setLoadFailed] = createSignal(false);
  return (
    <Show
      when={parsed()}
      fallback={
        <p role="status" class="text-dimmed">
          {props.block.status === "running" ? t().loading : t().failed}
        </p>
      }
    >
      {(result) => (
        <Show
          when={result().anchor}
          fallback={
            <a
              class="ai-map__jump"
              href={`/app/assistant?conversation=${encodeURIComponent(result().map.conversationId)}${result().map.anchorSeq ? `&message=${result().map.anchorSeq}` : ""}#${mapAnchor(result().map.id)}`}
              onClick={async (event) => {
                const href = event.currentTarget.href;
                const target = document.getElementById(mapAnchor(result().map.id));
                if (target) {
                  event.preventDefault();
                  target.scrollIntoView({ block: "start", behavior: "instant" });
                  target.focus({ preventScroll: true });
                } else {
                  event.preventDefault();
                  try {
                    const current = responseSchema.parse(
                      await (
                        await fetch(`/api/ai/conversations/${encodeURIComponent(result().map.conversationId)}/maps/${result().map.id}`)
                      ).json(),
                    ).map;
                    const destination = current.anchorSeq
                      ? `/app/assistant?conversation=${encodeURIComponent(current.conversationId)}&message=${current.anchorSeq}#${mapAnchor(current.id)}`
                      : href;
                    const handled = await requestSearchNavigation({
                      href: destination,
                      ref: { type: "assistant.chat", id: current.conversationId },
                    });
                    if (!handled) window.location.assign(destination);
                    else document.getElementById(mapAnchor(current.id))?.scrollIntoView({ block: "start" });
                  } catch {
                    setLoadFailed(true);
                  }
                }
              }}
            >
              {t().jump}: {result().map.title}
              <Show when={loadFailed()}>
                <span role="alert"> · {t().failed}</span>
              </Show>
            </a>
          }
        >
          <Show
            when={loaded()}
            fallback={
              <section
                id={mapAnchor(result().map.id)}
                class="ai-map ai-map__placeholder"
                data-kind={result().map.kind}
                aria-busy={!loadFailed()}
              >
                <p role="status">{loadFailed() ? t().failed : t().loading}</p>
                <Show when={loadFailed()}>
                  <Button size="sm" onClick={() => window.location.reload()}>
                    {t().reload}
                  </Button>
                </Show>
              </section>
            }
          >
            {(value) => <AssistantMap initial={value()} loading={props.block.status === "running"} />}
          </Show>
        </Show>
      )}
    </Show>
  );
}

export function AssistantMap(props: { initial: AiMap; loading?: boolean }) {
  const locale = useLocale();
  const t = () => mapMessages(locale());
  const [map, setMap] = createSignal(props.initial);
  const [selected, setSelected] = createSignal(props.initial.selectionId ?? "");
  const [expanded, setExpanded] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [conflict, setConflict] = createSignal(false);
  const [canAdmin, setCanAdmin] = createSignal(false);
  const [mode, setMode] = createSignal<"ready" | "insert" | "options" | "along" | "start" | "save" | "repair">("ready");
  const [width, setWidth] = createSignal(796);
  const [location, setLocation] = createSignal<MapViewOwnLocation>();
  const [locationError, setLocationError] = createSignal("");
  const [start, setStart] = createSignal("");
  const [category, setCategory] = createSignal<z.infer<typeof GeoCategorySchema>>("attraction");
  const [fromKm, setFromKm] = createSignal(40);
  const [toKm, setToKm] = createSignal(80);
  const [travelMode, setTravelMode] = createSignal<"car" | "bike" | "walk">("car");
  const [avoid, setAvoid] = createSignal<NonNullable<GeoRouteOptions["avoid"]>>([]);
  const [repairStop, setRepairStop] = createSignal("");
  const [scope, setScope] = createSignal("all");
  const [allowance, setAllowance] = createSignal<number>();
  const [navigationPlatform, setNavigationPlatform] = createSignal<ReturnType<typeof geoNavigationPlatform>>("desktop");
  const candidateIndex = () => {
    const index = Number(/^candidate-(\d)$/.exec(selection())?.[1] ?? 0);
    return index < (map().candidates?.length ?? 0) ? index : 0;
  };
  const allowanceMeters = () =>
    map().issue?.distanceAllowanceMeters ?? map().route?.distanceAllowanceMeters ?? map().plan?.distanceAllowanceMeters ?? 500000;
  const waiting = () => busy() || (map().pending && props.loading);
  const candidateRows = () => (
    <div
      role="listbox"
      aria-label={t().choose}
      tabIndex={0}
      onKeyDown={(event) => {
        const count = map().candidates?.length ?? 0;
        const current = candidateIndex();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : event.key === "ArrowDown"
                ? Math.min(count - 1, current + 1)
                : event.key === "ArrowUp"
                  ? Math.max(0, current - 1)
                  : undefined;
        if (next !== undefined) {
          event.preventDefault();
          setSelected(`candidate-${next}`);
        }
        if (event.key === "Enter") void run({ type: "choose", index: candidateIndex() });
      }}
      aria-activedescendant={`${mapAnchor(map().id)}-candidate-${candidateIndex()}`}
    >
      <p>{t().choose}</p>
      <For each={map().candidates}>
        {(candidate, index) => (
          <Button
            variant="ghost"
            size="sm"
            onPointerEnter={() => setSelected(`candidate-${index()}`)}
            onFocus={() => setSelected(`candidate-${index()}`)}
            onClick={() => setSelected(`candidate-${index()}`)}
            role="option"
            tabIndex={-1}
            id={`${mapAnchor(map().id)}-candidate-${index()}`}
            aria-selected={candidateIndex() === index()}
            disabled={busy()}
            class="ai-map__candidate"
            title={candidate.formatted}
          >
            <span>
              {index() + 1}. {candidate.formatted}
            </span>
          </Button>
        )}
      </For>
    </div>
  );
  let root!: HTMLElement;
  let disposed = false;
  const controller = new AbortController();
  const narrow = () => width() < 600;
  const panel = () => width() <= 368 && typeof window !== "undefined" && window.innerWidth >= 800;
  const url = () => `/api/ai/conversations/${encodeURIComponent(map().conversationId)}/maps/${map().id}`;
  const number = (value: number, digits = 0) => new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(value);
  const km = (value: number) => `${number(value / 1000, 1)} km`;
  const minutes = (value: number) => `${number(Math.round(value / 60))} min`;
  const time = (value: string) =>
    new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", timeZone: map().timeZone ?? "UTC" }).format(new Date(value));
  const update = (value: AiMap) => {
    if (value.id !== map().id || value.conversationId !== map().conversationId || value.revision < map().revision) return;
    if (value.revision > map().revision && value.selectionId !== map().selectionId) setSelected(value.selectionId ?? "");
    setMap(value);
  };
  createEffect(() => update(props.initial));
  const publish = (value: AiMap) => {
    update(value);
    window.dispatchEvent(new CustomEvent(eventName, { detail: value }));
  };
  const reload = async () => {
    try {
      const response = await fetch(url(), { signal: controller.signal });
      if (!response.ok) throw new Error(t().failed);
      const result = responseSchema.parse(await response.json());
      if (disposed) return;
      publish(result.map);
      setCanAdmin(result.canAdmin ?? false);
      setConflict(false);
      setError("");
    } catch {
      if (!disposed) setError(t().failed);
    }
  };
  onMount(() => {
    setNavigationPlatform(geoNavigationPlatform(navigator.userAgent));
    const observer = new ResizeObserver((entries) => {
      if (entries[0]) setWidth(entries[0].contentRect.width);
    });
    observer.observe(root);
    const receive = (event: Event) => {
      if (event instanceof CustomEvent) {
        const value = AiMapSchema.safeParse(event.detail);
        if (value.success) update(value.data);
        else {
          const ref = AiMapReferenceSchema.safeParse(event.detail);
          if (
            ref.success &&
            ref.data.id === map().id &&
            ref.data.conversationId === map().conversationId &&
            ref.data.revision > map().revision
          )
            void reload();
        }
      }
    };
    const focus = () => {
      if (!busy()) void reload();
    };
    window.addEventListener(eventName, receive);
    window.addEventListener("focus", focus);
    void reload();
    onCleanup(() => {
      disposed = true;
      controller.abort();
      observer.disconnect();
      window.removeEventListener(eventName, receive);
      window.removeEventListener("focus", focus);
    });
  });
  const run = async (command: AiMapCommand) => {
    if (busy() || conflict()) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${url()}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: map().revision, command }),
        signal: controller.signal,
      });
      if (response.status === 409) {
        setConflict(true);
        throw new Error(t().conflict);
      }
      if (!response.ok) throw new Error(t().failed);
      const result = responseSchema.parse(await response.json());
      if (disposed) return;
      publish(result.map);
      if (result.map.issue || !result.map.picker) setMode("ready");
    } catch {
      if (!disposed) setError(conflict() ? t().conflict : t().failed);
    } finally {
      if (!disposed) setBusy(false);
    }
  };
  const places = createMemo(() => {
    const groups = map().groups;
    const seen = new Set<string>();
    return groups.flatMap((group, groupIndex) =>
      group.places.flatMap((place, index) => {
        if (seen.has(place.id)) return [];
        seen.add(place.id);
        return [{ place, mark: groupIndex === 0 ? String(index + 1) : String.fromCharCode(65 + index), second: groupIndex > 0 }];
      }),
    );
  });
  const choices = () => map().picker ?? [];
  const selection = () => selected() || (map().candidates?.length ? "candidate-0" : choices()[0]?.id || places()[0]?.place.id || "");
  const selectedPlace = () => [...choices(), ...places().map((p) => p.place)].find((p) => p.id === selection());
  const categoryLabel = (categories: string[]) =>
    categories
      .map((c) =>
        c === "entertainment.museum"
          ? t().museum
          : c === "catering.cafe"
            ? t().cafe
            : c === "catering.restaurant"
              ? t().restaurant
              : c.replaceAll("_", " ").split(".").at(-1),
      )
      .join(", ");
  const web = () => map().web.find((w) => w.placeId === selectedPlace()?.id);
  const visiblePlaces = () => {
    const all = places();
    if (!narrow() || expanded()) return all;
    const second = all.filter((p) => p.second);
    return (second.length ? second : all).slice(0, 4);
  };
  const selectPlace = (id: string) => {
    setSelected(id);
    if (narrow() && !visiblePlaces().some((p) => p.place.id === id) && places().some((p) => p.place.id === id)) setExpanded(true);
  };
  const keydown = (event: KeyboardEvent) => {
    const list = visiblePlaces();
    const index = list.findIndex((p) => p.place.id === selection());
    let next = index;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = list.length - 1;
    else if (event.key === "ArrowDown") next = Math.min(index + 1, list.length - 1);
    else if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
    else return;
    event.preventDefault();
    const row = list[next];
    if (row) {
      setSelected(row.place.id);
      root.querySelector(`[data-option-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
    }
  };
  const markers = createMemo<MapViewMarker[]>(() => {
    if (map().candidates?.length)
      return map().candidates!.map((p, i) => ({
        id: `candidate-${i}`,
        mark: i + 1,
        label: p.formatted,
        point: p.point,
        tone: "second",
        selected: selection() === `candidate-${i}`,
      }));
    const base = choices().length
      ? choices().map((p, i) => ({
          id: p.id,
          mark: i + 1,
          label: p.name,
          point: p.point,
          tone: "second" as const,
          selected: selection() === p.id,
        }))
      : places().map((p) => ({
          id: p.place.id,
          mark: p.mark,
          label: p.place.name,
          point: p.place.point,
          tone: p.second ? ("second" as const) : ("accent" as const),
          selected: selection() === p.place.id,
        }));
    const route = map().route;
    const stops =
      (route?.stops ?? map().plan?.stops.flatMap((s) => (s.point ? [{ id: s.id, label: s.label, point: s.point }] : [])))?.map((s, i) => ({
        id: s.id,
        mark: String.fromCharCode(65 + i),
        label: s.label ?? s.id,
        point: s.point,
        tone: "accent" as const,
      })) ?? [];
    const preview = map().preview;
    if (preview?.changes.type === "insert") {
      const inserted = preview.result.route.stops.find((s) => !route?.stops.some((old) => old.id === s.id));
      if (inserted) stops.push({ id: inserted.id, mark: "+", label: inserted.label ?? "+", point: inserted.point, tone: "accent" });
    }
    return choices().length ? base : [...stops, ...base];
  });
  const lines = createMemo<MapViewLine[]>(() => {
    if (map().candidates?.length) return [];
    const route = map().route;
    const preview = map().preview;
    if (!route) return [];
    if (!preview) return [{ id: "route", polyline6: route.polyline6 }];
    return [
      { id: "before", polyline6: route.polyline6, tone: "previous" },
      { id: "preview", polyline6: preview.result.route.polyline6, tone: preview.changes.type === "insert" ? "preview" : "accent" },
    ];
  });
  const blocked = () =>
    !map().availability.configured || map().issue?.code === "GEO_NOT_CONFIGURED" || map().issue?.code === "GEO_BUDGET_EXHAUSTED";
  const locate = () => {
    if (!navigator.geolocation) {
      setLocationError(t().locationFailed);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (disposed) return;
        setLocation({ point: { lat: position.coords.latitude, lon: position.coords.longitude }, accuracyMeters: position.coords.accuracy });
        setLocationError("");
      },
      (error) => {
        if (!disposed) setLocationError(error.code === error.PERMISSION_DENIED ? t().noLocation : t().locationFailed);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  };
  const routeHere = async () => {
    const place = selectedPlace();
    if (!place) return;
    if (!location()) {
      setMode("start");
      return;
    }
    await run({ type: "location", destinationId: place.id, point: location()!.point });
  };
  const search = (insert: boolean) =>
    run({ type: "search", insert, search: { title: t().stopSearch, categories: [category()], along: { fromKm: fromKm(), toKm: toKm() } } });
  const showOptions = () => {
    setMode("options");
    setTravelMode(map().route?.options.mode ?? "car");
    setAvoid(map().route?.options.avoid ?? []);
  };
  const optionChange = () => {
    const leg = scope() === "all" ? undefined : map().route?.legs[Number(scope())];
    return run({
      type: "preview",
      change: {
        type: "options",
        options: { mode: travelMode(), avoid: avoid() },
        ...(leg ? { leg: { fromStopId: leg.fromStopId, toStopId: leg.toStopId } } : {}),
      },
    });
  };
  const changedRoute = () => map().preview?.result.route ?? map().route;
  const issueText = () => {
    const issue = map().issue;
    if (!map().availability.configured || issue?.code === "GEO_NOT_CONFIGURED") return t().off;
    if (issue?.code === "GEO_BUDGET_EXHAUSTED")
      return `${issue.scope === "person" ? t().person : t().cloud}: ${t().budget}. ${t().reset}: ${issue.resetsAt ? new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: map().timeZone ?? "UTC" }).format(new Date(issue.resetsAt)) : ""}`;
    if (issue?.code === "GEO_COST_OVERRUN") return `${t().cost} ${number(allowanceMeters() / 1000)} km / ${t().stops}.`;
    if (issue?.code === "GEO_NO_ROUTE") return t().noRoute;
    if (issue?.code === "GEO_BUSY") return `${t().failed} (${issue.retryAfterSeconds ?? 1} s)`;
    return t().failed;
  };
  const recovery = () => (
    <div class="ai-map__state" role="status">
      <p>{issueText()}</p>
      <Show when={map().issue?.code !== "GEO_COST_OVERRUN"}>
        <Button variant="ghost" size="sm" disabled={busy()} onClick={() => void run({ type: "retry" })}>
          {t().retry}
        </Button>
      </Show>
      <Show when={map().issue?.code === "GEO_COST_OVERRUN"}>
        <NumberInput
          label={t().newAllowance}
          value={allowance() ?? null}
          min={allowanceMeters() / 1000 + 1}
          onValueChange={(v) => setAllowance(v ?? undefined)}
        />
        <p>{t().noInvoiceCap}</p>
        <Button
          size="sm"
          disabled={busy() || !allowance() || allowance()! * 1000 <= allowanceMeters()}
          onClick={() => void run({ type: "retry", distanceAllowanceMeters: allowance()! * 1000 })}
        >
          {t().calculate}
        </Button>
      </Show>
      <Show when={map().plan && !map().route && map().issue?.code !== "GEO_COST_OVERRUN" && !blocked()}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setRepairStop(map().ambiguousStopId ?? map().plan!.stops.at(-1)!.id);
            setStart("");
            setMode("repair");
          }}
        >
          {t().changeStop}
        </Button>
      </Show>
      <Show when={canAdmin() && blocked()}>
        <ButtonLink href="/admin/settings?tab=places" variant="ghost" size="sm">
          {map().availability.configured ? t().limits : t().configure}
        </ButtonLink>
      </Show>
    </div>
  );
  const placeRows = () => (
    <div
      class="ai-map__list"
      data-expanded={expanded()}
      role="listbox"
      tabIndex={0}
      aria-label={t().places}
      aria-activedescendant={
        visiblePlaces().some((p) => p.place.id === selection())
          ? `${mapAnchor(map().id)}-option-${visiblePlaces().findIndex((p) => p.place.id === selection())}`
          : undefined
      }
      onKeyDown={keydown}
    >
      <Show
        when={places().length && !map().issue && !waiting()}
        fallback={
          waiting() ? (
            <div class="ai-map__skeleton" role="status">
              {t().loading}
              <For each={[1, 2, 3, 4]}>{() => <span />}</For>
            </div>
          ) : map().candidates?.length && map().issue?.code === "GEO_ADDRESS_AMBIGUOUS" ? (
            candidateRows()
          ) : map().issue || map().pending ? (
            recovery()
          ) : (
            <div class="ai-map__state">
              <p>{t().noPlaces}</p>
              <Button
                size="sm"
                variant="ghost"
                disabled={!map().lastSearch}
                onClick={() =>
                  void run({
                    type: "search",
                    search: { ...map().lastSearch!, radiusMeters: 10000 },
                  })
                }
              >
                {t().expand}
              </Button>
            </div>
          )
        }
      >
        <div class="ai-map__group" data-second={visiblePlaces()[0]?.second}>
          {map().groups[visiblePlaces()[0]?.second ? 1 : 0]?.title}
        </div>
        <For each={visiblePlaces()}>
          {(row, index) => (
            <div
              role="option"
              id={`${mapAnchor(map().id)}-option-${index()}`}
              data-option-index={index()}
              aria-selected={selection() === row.place.id}
              class="ai-map__place"
              data-second={row.second}
              onClick={() => selectPlace(row.place.id)}
              onKeyDown={keydown}
            >
              <span class="ai-map__mark">{row.mark}</span>
              <span class="ai-map__place-text">
                <span>{row.place.name}</span>
                <small>
                  {categoryLabel(row.place.categories)} ·{" "}
                  {mapOpeningHours(row.place.openingHours, map().viewedAt ?? row.place.provenance.computedAt, map().timeZone, locale())}
                </small>
              </span>
              <span class="ai-map__distance">
                {row.place.atMeters !== undefined
                  ? `km ${number(row.place.atMeters / 1000)}`
                  : row.place.distanceMeters !== undefined
                    ? km(row.place.distanceMeters)
                    : ""}
              </span>
            </div>
          )}
        </For>
        <Show when={narrow()}>
          <Button size="sm" variant="ghost" class="ai-map__more" onClick={() => setExpanded(!expanded())}>
            {expanded() ? t().less : `${t().all} ${number(places().length)} ${t().places}`}
          </Button>
        </Show>
      </Show>
    </div>
  );
  const info = () => (
    <div class="ai-map__info" aria-live="polite">
      <Show when={!map().issue && !waiting() ? selectedPlace() : undefined}>
        {(p) => (
          <>
            <h4>{p().name}</h4>
            <div class="text-dimmed">{categoryLabel(p().categories)}</div>
            <div>◷ {mapOpeningHours(p().openingHours, map().viewedAt ?? p().provenance.computedAt, map().timeZone, locale())}</div>
            <div>{p().address.formatted}</div>
            <Show when={safeWebsite(p().website)}>
              {(href) => (
                <a href={href()} target="_blank" rel="noopener noreferrer">
                  {new URL(href()).hostname}
                </a>
              )}
            </Show>
            <p class="ai-map__description">{web()?.description}</p>
            <small>
              {t().source}: {p().provenance.attribution.text}
              <Show when={web()}>
                {" "}
                · {t().description}:{" "}
                <a href={web()!.url} target="_blank" rel="noopener noreferrer">
                  {new URL(web()!.url).hostname}
                </a>
              </Show>
            </small>
          </>
        )}
      </Show>
    </div>
  );
  return (
    <div class="ai-map-host">
      <section
        ref={root}
        id={mapAnchor(map().id)}
        class="ai-map"
        data-kind={map().kind}
        data-expanded={expanded()}
        tabIndex={-1}
        aria-label={map().title}
        aria-busy={busy() || props.loading}
      >
        <Show
          when={!blocked()}
          fallback={
            <>
              {recovery()}
              <Show when={map().route?.stops ?? map().plan?.stops}>
                {(stops) => (
                  <ol class="ai-map__saved-stops">
                    <For each={stops()}>
                      {(stop, index) => (
                        <li>
                          {String.fromCharCode(65 + index())} · {stop.label ?? stop.id}
                        </li>
                      )}
                    </For>
                  </ol>
                )}
              </Show>
              <Show when={places().length}>
                <ul>
                  <For each={places()}>
                    {(p) => (
                      <li>
                        {p.place.name} · {p.place.address.formatted}
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={places().length || map().route}>
                <small class="ai-map__provenance">
                  {map().route?.provenance.attribution.text ?? places()[0]?.place.provenance.attribution.text}
                </small>
              </Show>
            </>
          }
        >
          <div class="ai-map__head">
            <Show
              when={map().kind === "route"}
              fallback={
                <>
                  <Show
                    when={map().groups.length > 1}
                    fallback={
                      <>
                        <span>{map().title}</span>
                        <span class="ai-map__chip">
                          {number(places().length)} {t().places}
                        </span>
                      </>
                    }
                  >
                    <For each={map().groups}>
                      {(g) => (
                        <span class="ai-map__chip" data-second={map().groups.indexOf(g) > 0}>
                          {g.title} · {number(g.places.length)}
                        </span>
                      )}
                    </For>
                  </Show>
                </>
              }
            >
              {map().title}{" "}
              <span class="ai-map__chip">
                {number(map().route?.stops.length ?? map().plan?.stops.length ?? 0)} {t().stops}
              </span>
            </Show>
          </div>
          <CloudMap
            height={map().kind === "route" ? (narrow() ? 240 : 330) : narrow() ? (panel() ? 200 : 230) : 330}
            markers={markers()}
            lines={lines()}
            fit={map().candidates?.length || choices().length ? "markers" : "all"}
            selectedId={selection()}
            onSelect={selectPlace}
            ownLocation={location()}
            onLocate={locate}
            availability={map().availability}
            notice={locationError() || (busy() || props.loading ? t().loading : undefined)}
          />
          <Show
            when={map().kind === "places"}
            fallback={
              <>
                <div class="ai-map__facts">
                  <div>
                    <strong>{changedRoute() ? km(changedRoute()!.distanceMeters) : "—"}</strong>
                    <small>{t().distance}</small>
                  </div>
                  <div>
                    <strong>{changedRoute() ? minutes(changedRoute()!.durationSeconds) : "—"}</strong>
                    <small>{t().duration}</small>
                  </div>
                  <Show when={map().preview}>
                    {(preview) => (
                      <div data-gain={preview().result.delta.durationSeconds < 0}>
                        <strong>
                          {preview().result.delta.durationSeconds > 0 ? "+" : ""}
                          {minutes(preview().result.delta.durationSeconds)}
                        </strong>
                        <small>
                          {preview().result.delta.distanceMeters > 0 ? "+" : ""}
                          {km(preview().result.delta.distanceMeters)}
                        </small>
                      </div>
                    )}
                  </Show>
                </div>
                <div class="ai-map__stages">
                  <Switch>
                    <Match when={waiting()}>
                      <div class="ai-map__skeleton" role="status">
                        {t().loading}
                        <For each={[1, 2, 3, 4]}>{() => <span />}</For>
                      </div>
                    </Match>
                    <Match when={map().candidates?.length && map().issue?.code === "GEO_ADDRESS_AMBIGUOUS"}>{candidateRows()}</Match>
                    <Match when={mode() === "options"}>
                      <div class="ai-map__opts">
                        <Select
                          label={t().scope}
                          value={scope()}
                          onValueChange={(v) => {
                            setScope(v ?? "all");
                            const options = v && v !== "all" ? map().route?.legs[Number(v)]?.options : map().route?.options;
                            setTravelMode(options?.mode ?? "car");
                            setAvoid(options?.avoid ?? []);
                          }}
                          options={[
                            { value: "all", label: t().whole },
                            ...(map().route?.legs.map((leg, i) => ({
                              value: String(i),
                              label: `${String.fromCharCode(65 + i)} → ${String.fromCharCode(66 + i)}`,
                            })) ?? []),
                          ]}
                        />
                        <Select
                          label={t().mode}
                          value={travelMode()}
                          onValueChange={(v) => {
                            if (v === "car" || v === "bike" || v === "walk") {
                              setTravelMode(v);
                              if (v !== "car") setAvoid(avoid().filter((a) => a === "ferries"));
                            }
                          }}
                          options={[
                            { value: "car", label: t().car },
                            { value: "bike", label: t().bike },
                            { value: "walk", label: t().walk },
                          ]}
                        />
                        <div class="ai-map__actions">
                          <For each={["highways", "tolls", "ferries"] as const}>
                            {(item) => (
                              <Checkbox
                                label={t()[item]}
                                value={avoid().includes(item)}
                                disabled={travelMode() !== "car" && item !== "ferries"}
                                onValueChange={(v) => setAvoid(v ? [...avoid(), item] : avoid().filter((a) => a !== item))}
                              />
                            )}
                          </For>
                        </div>
                        <small>{t().prefs}</small>
                      </div>
                    </Match>
                    <Match when={mode() === "insert" || mode() === "along"}>
                      <Show when={!choices().length} fallback={<p>{t().choose}</p>}>
                        <div class="ai-map__search">
                          <Select
                            label={t().category}
                            value={category()}
                            onValueChange={(v) => {
                              if (v === "attraction" || v === "restaurant" || v === "cafe") setCategory(v);
                            }}
                            options={[
                              { value: "attraction", label: t().waterfall },
                              { value: "restaurant", label: t().restaurant },
                              { value: "cafe", label: t().cafe },
                            ]}
                          />
                          <div class="ai-map__actions">
                            <NumberInput label={t().from} value={fromKm()} min={0} onValueChange={(v) => setFromKm(v ?? 0)} />
                            <NumberInput label={t().to} value={toKm()} min={0} onValueChange={(v) => setToKm(v ?? 0)} />
                          </div>
                        </div>
                      </Show>
                      <For each={choices()}>
                        {(p, i) => (
                          <Button variant="ghost" size="sm" disabled={busy()} onClick={() => selectPlace(p.id)}>
                            {i() + 1}. {p.name}
                          </Button>
                        )}
                      </For>
                    </Match>
                    <Match when={map().issue || (map().pending && !props.loading)}>{recovery()}</Match>
                    <Match when={map().groups.length > 0 && !!map().lastSearch?.along}>
                      <For each={places().slice(0, 5)}>
                        {(row) => (
                          <Button variant="ghost" size="sm" onClick={() => selectPlace(row.place.id)}>
                            {row.mark} {row.place.name} · km {number((row.place.atMeters ?? 0) / 1000)} · {t().corridor}{" "}
                            {km(row.place.distanceToRouteMeters ?? 0)}
                          </Button>
                        )}
                      </For>
                      <Show when={selectedPlace()}>
                        {(p) => (
                          <div class="ai-map__route-place">
                            {p().name} · {p().address.formatted}
                          </div>
                        )}
                      </Show>
                    </Match>
                    <Match when={map().preview?.changes.type === "optimize"}>
                      <div class="ai-map__order">
                        <div>
                          <strong>{t().before}</strong>
                          <ol>
                            <For each={map().route?.stops}>{(stop) => <li>{stop.label ?? stop.id}</li>}</For>
                          </ol>
                        </div>
                        <div>
                          <strong>{t().after}</strong>
                          <ol>
                            <For each={changedRoute()?.stops}>{(stop) => <li>{stop.label ?? stop.id}</li>}</For>
                          </ol>
                        </div>
                      </div>
                    </Match>
                    <Match when={true}>
                      <For each={changedRoute()?.legs}>
                        {(leg, i) => (
                          <div
                            class="ai-map__leg"
                            data-changed={
                              !!map().preview &&
                              map().route?.legs.find((old) => old.fromStopId === leg.fromStopId && old.toStopId === leg.toStopId)
                                ?.polyline6 !== leg.polyline6
                            }
                          >
                            <span>
                              {map().route?.stops.some((s) => s.id === leg.fromStopId)
                                ? String.fromCharCode(65 + map().route!.stops.findIndex((s) => s.id === leg.fromStopId))
                                : "+"}{" "}
                              →{" "}
                              {map().route?.stops.some((s) => s.id === leg.toStopId)
                                ? String.fromCharCode(65 + map().route!.stops.findIndex((s) => s.id === leg.toStopId))
                                : "+"}
                            </span>
                            <span>
                              {changedRoute()?.stops.find((s) => s.id === leg.toStopId)?.label ?? leg.toStopId}
                              <small>
                                {leg.options.mode ? t()[leg.options.mode] : ""}
                                {leg.options.avoid?.length ? ` · ${t().without} ${leg.options.avoid.map((a) => t()[a]).join(", ")}` : ""}
                              </small>
                            </span>
                            <span>{km(leg.distanceMeters)}</span>
                            <span>{minutes(leg.durationSeconds)}</span>
                          </div>
                        )}
                      </For>
                    </Match>
                  </Switch>
                </div>
              </>
            }
          >
            <div class="ai-map__split">
              {info()}
              {placeRows()}
            </div>
          </Show>
          <div class="ai-map__zone">
            <Switch>
              <Match when={mode() === "save"}>
                <MapNotebookSave map={map()} onCancel={() => setMode("ready")} />
              </Match>
              <Match when={mode() === "repair"}>
                <Select
                  label={t().changeStop}
                  value={repairStop()}
                  onValueChange={(v) => setRepairStop(v ?? "")}
                  options={
                    map().plan?.stops.map((s, i) => ({
                      value: s.id,
                      label: `${String.fromCharCode(65 + i)} · ${s.label ?? s.address?.text ?? s.id}`,
                    })) ?? []
                  }
                />
                <TextInput label={t().start} value={start()} onValueChange={setStart} />
                <div class="ai-map__actions">
                  <Button
                    size="sm"
                    disabled={busy() || !repairStop() || !start().trim()}
                    onClick={() => void run({ type: "repair", stopId: repairStop(), address: start() })}
                  >
                    {t().calculate}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setMode("ready")}>
                    {t().cancel}
                  </Button>
                </div>
              </Match>
              <Match when={mode() === "start"}>
                <TextInput label={t().start} value={start()} onValueChange={setStart} />
                <div class="ai-map__actions">
                  <Button
                    size="sm"
                    disabled={!start().trim() || busy()}
                    onClick={() =>
                      void run({
                        type: "route",
                        title: selectedPlace()?.name ?? t().route,
                        stops: [
                          { id: "start", address: start() },
                          { id: "destination", placeId: selection() },
                        ],
                      })
                    }
                  >
                    {t().go}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={locate}>
                    {t().locate}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setMode("ready")}>
                    {t().cancel}
                  </Button>
                </div>
              </Match>
              <Match when={map().candidates?.length && map().issue?.code === "GEO_ADDRESS_AMBIGUOUS"}>
                <div class="ai-map__confirm">
                  <p>{t().choose}</p>
                  <div class="ai-map__actions">
                    <Button size="sm" disabled={busy()} onClick={() => void run({ type: "choose", index: candidateIndex() })}>
                      {map().candidates?.[candidateIndex()]?.formatted} · {t().useStop}
                    </Button>
                    <Show when={map().plan}>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setRepairStop(map().ambiguousStopId ?? map().plan!.stops[0]!.id);
                          setStart("");
                          setMode("repair");
                        }}
                      >
                        {t().changeStop}
                      </Button>
                    </Show>
                  </div>
                </div>
              </Match>
              <Match when={map().preview}>
                {(preview) => (
                  <div class="ai-map__confirm">
                    <p>{preview().title}?</p>
                    <small>
                      {t().before}: {km(map().route!.distanceMeters)}, {minutes(map().route!.durationSeconds)} · {t().after}:{" "}
                      {km(preview().result.route.distanceMeters)}, {minutes(preview().result.route.durationSeconds)}
                    </small>
                    <div class="ai-map__actions">
                      <Button size="sm" disabled={busy() || conflict()} onClick={() => void run({ type: "accept" })}>
                        {preview().title}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy()} onClick={() => void run({ type: "discard" })}>
                        {t().discard}
                      </Button>
                    </div>
                  </div>
                )}
              </Match>
              <Match when={mode() === "options"}>
                <div class="ai-map__actions">
                  <Button size="sm" disabled={busy()} onClick={() => void optionChange()}>
                    {t().calculate}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setMode("ready")}>
                    {t().cancel}
                  </Button>
                </div>
              </Match>
              <Match when={mode() === "insert" || mode() === "along"}>
                <div class="ai-map__actions">
                  <Button
                    size="sm"
                    disabled={busy() || toKm() <= fromKm() || toKm() - fromKm() > 200}
                    onClick={() => void search(mode() === "insert")}
                  >
                    {t().search}
                  </Button>
                  <Show when={mode() === "insert" && choices().some((p) => p.id === selection())}>
                    <Button
                      size="sm"
                      disabled={busy()}
                      onClick={() => void run({ type: "preview", change: { type: "insert", placeId: selection() } })}
                    >
                      {t().preview} {selectedPlace()?.name}
                    </Button>
                  </Show>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setMode("ready");
                      void run({ type: "discard" });
                    }}
                  >
                    {t().cancel}
                  </Button>
                </div>
              </Match>
              <Match when={true}>
                <Show when={map().receipt}>
                  {(receipt) => (
                    <div class="ai-map__receipt">
                      <span>{receipt().title}</span>
                      <time dateTime={receipt().at}>{time(receipt().at)}</time>
                      <Show when={map().undo}>
                        <Button variant="ghost" size="xs" disabled={busy()} onClick={() => void run({ type: "undo" })}>
                          {t().undo}
                        </Button>
                      </Show>
                    </div>
                  )}
                </Show>
                <div class="ai-map__actions" data-quiet={waiting() || !!map().issue} inert={waiting() || !!map().issue}>
                  <Show
                    when={map().kind === "places"}
                    fallback={
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy() || !map().route}
                          onClick={() => {
                            setMode("insert");
                            setCategory("attraction");
                            setFromKm(0);
                            setToKm(Math.min(200, (map().route?.distanceMeters ?? 0) / 1000));
                          }}
                        >
                          {t().insert}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy() || !map().route}
                          onClick={() => void run({ type: "preview", change: { type: "optimize" } })}
                        >
                          {t().optimize}
                        </Button>
                        <Button size="sm" variant="secondary" disabled={!map().route} onClick={showOptions}>
                          {t().options}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!map().route}
                          onClick={() => {
                            setMode("along");
                            setCategory("restaurant");
                            setFromKm(40);
                            setToKm(80);
                          }}
                        >
                          {t().along}
                        </Button>
                        <Show when={map().route?.stops.at(-1)}>
                          {(end) => (
                            <ButtonLink
                              size="sm"
                              variant="secondary"
                              target="_blank"
                              rel="noopener noreferrer"
                              href={geoNavigationHref(
                                { point: end().point, text: end().label ?? "", name: end().label },
                                navigationPlatform(),
                              )}
                            >
                              {t().nav}
                            </ButtonLink>
                          )}
                        </Show>
                      </>
                    }
                  >
                    <Button size="sm" variant="secondary" disabled={!selectedPlace() || busy()} onClick={() => void routeHere()}>
                      <i class="ti ti-route" aria-hidden="true" /> {t().here}
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy() || !places().length} onClick={() => setMode("save")}>
                      <i class="ti ti-notebook" aria-hidden="true" /> {t().save}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!selectedPlace() || busy()}
                      onClick={() =>
                        void run({ type: "search", search: { title: t().nearby, categories: ["cafe"], placeId: selection() } })
                      }
                    >
                      <i class="ti ti-radar" aria-hidden="true" /> {t().nearby}
                    </Button>
                  </Show>
                  <Show when={map().kind === "route"}>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy() || (!places().length && !map().route)}
                      onClick={() => setMode("save")}
                    >
                      <i class="ti ti-notebook" aria-hidden="true" /> {t().save}
                    </Button>
                  </Show>
                </div>
              </Match>
            </Switch>
          </div>
          <div class="ai-map__provenance">
            <Show
              when={map().route}
              fallback={
                <>
                  Geoapify · OpenStreetMap
                  <Show when={web()}>
                    {" "}
                    ·{" "}
                    <a href={web()!.url} target="_blank" rel="noopener noreferrer">
                      {new URL(web()!.url).hostname}
                    </a>
                  </Show>
                </>
              }
            >
              {(route) => (
                <>
                  {t().route}: {route().provenance.attribution.text} · {t().noTraffic} {time(route().provenance.computedAt)}
                </>
              )}
            </Show>
          </div>
        </Show>
        <Show when={error()}>
          <div role="alert" class="ai-map__error">
            {error()}{" "}
            <Button variant="ghost" size="sm" disabled={busy()} onClick={() => void reload()}>
              {t().reload}
            </Button>
          </div>
        </Show>
      </section>
    </div>
  );
}
