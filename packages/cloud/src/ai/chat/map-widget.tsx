import type { MapDialogMenuItem, MapPlace, MapViewLine, MapViewMarker, MapViewOwnLocation } from "@k2b/ui";
import { Button, ButtonLink, Checkbox, MapDialog, MapTile, NumberInput, Select, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { z } from "zod";
import { requestSearchNavigation } from "../../browser/search-bridge";
import type { GeoCategorySchema, GeoPlace, GeoPoint } from "../../contracts/geo";
import type { GeoRouteOptions } from "../../contracts/geo-route";
import { AddressAutocomplete } from "../../geo/AddressAutocomplete";
import { CloudMap } from "../../geo/CloudMap";
import {
  type AiMap,
  type AiMapCommand,
  AiMapReferenceSchema,
  AiMapSchema,
  AiMapToolResultSchema,
  aiMapDetailLink,
  aiMapWebsite,
} from "../map-contracts";
import { mapOpeningHours } from "../map-opening-hours";
import type { AiTurnBlock } from "../protocol";
import { mapMessages } from "./map-messages";

type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;
const responseSchema = z.object({ map: AiMapSchema, canAdmin: z.boolean().optional() });
const eventName = "cloud:assistant-map";
export const mapAnchor = (id: string) => `assistant-map-${id}`;
/** The chat's map tile has one height at every width, so the server's frame and every client render match. */
const TILE_HEIGHT = 240;
/** From this many stops the tile names their number instead of their order. */
const ORDER_STOPS = 6;

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
              href={`?conversation=${encodeURIComponent(result().map.conversationId)}${result().map.anchorSeq ? `&message=${result().map.anchorSeq}` : ""}#${mapAnchor(result().map.id)}`}
              onClick={async (event) => {
                const href = event.currentTarget.href;
                const target = document.getElementById(mapAnchor(result().map.id));
                if (target) {
                  event.preventDefault();
                  target.scrollIntoView({ block: "start", behavior: "instant" });
                  (target.querySelector<HTMLElement>(".k2b-map-tile__open") ?? target).focus({ preventScroll: true });
                } else {
                  event.preventDefault();
                  try {
                    const current = responseSchema.parse(
                      await (
                        await fetch(`/api/ai/conversations/${encodeURIComponent(result().map.conversationId)}/maps/${result().map.id}`)
                      ).json(),
                    ).map;
                    // The host can be full Assistant or its panel. Keep the link's SSR/browser path
                    // when loading an older map instead of navigating the panel to the full app.
                    const targetUrl = new URL(href);
                    targetUrl.searchParams.set("conversation", current.conversationId);
                    if (current.anchorSeq) targetUrl.searchParams.set("message", String(current.anchorSeq));
                    targetUrl.hash = mapAnchor(current.id);
                    const destination = targetUrl.href;
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

/**
 * The chat shows a map as a still tile. Its dialog is the small map app: the list of places or stops, the selected
 * place's details and navigation, and every route tool, confirmation and recovery of the conversation's map.
 */
export function AssistantMap(props: { initial: AiMap; loading?: boolean }) {
  const locale = useLocale();
  const t = () => mapMessages(locale());
  const [map, setMap] = createSignal(props.initial);
  const [selected, setSelected] = createSignal(props.initial.selectionId ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [conflict, setConflict] = createSignal(false);
  const [canAdmin, setCanAdmin] = createSignal(false);
  const [mode, setMode] = createSignal<"ready" | "insert" | "options" | "along" | "start" | "repair">("ready");
  const [location, setLocation] = createSignal<MapViewOwnLocation>();
  const [online, setOnline] = createSignal(true);
  const [start, setStart] = createSignal("");
  const [category, setCategory] = createSignal<z.infer<typeof GeoCategorySchema>>("attraction");
  const [placeName, setPlaceName] = createSignal(props.initial.lastSearch?.name ?? "");
  const [fromKm, setFromKm] = createSignal(40);
  const [toKm, setToKm] = createSignal(80);
  const [travelMode, setTravelMode] = createSignal<"car" | "bike" | "walk">("car");
  const [avoid, setAvoid] = createSignal<NonNullable<GeoRouteOptions["avoid"]>>([]);
  const [repairStop, setRepairStop] = createSignal("");
  const [repairPoint, setRepairPoint] = createSignal<GeoPoint>();
  const [scope, setScope] = createSignal("all");
  let disposed = false;
  const controller = new AbortController();
  const url = () => `/api/ai/conversations/${encodeURIComponent(map().conversationId)}/maps/${map().id}`;
  const number = (value: number, digits = 0) => new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(value);
  const km = (value: number) => `${number(value / 1000, 1)} km`;
  const minutes = (value: number) => `${number(Math.round(value / 60))} min`;
  const duration = (value: number) => {
    const total = Math.round(value / 60);
    return total >= 60 ? `${number(Math.floor(total / 60))} h ${number(total % 60)} min` : `${number(total)} min`;
  };
  const time = (value: string) =>
    new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", timeZone: map().timeZone ?? "UTC" }).format(new Date(value));
  const letter = (index: number) => String.fromCharCode(65 + index);
  const update = (value: AiMap) => {
    if (value.id !== map().id || value.conversationId !== map().conversationId || value.revision < map().revision) return;
    if (value.revision > map().revision && value.selectionId !== map().selectionId) setSelected(value.selectionId ?? "");
    setMap(value);
  };
  createEffect(() => update(props.initial));
  // Results to pick a stop from belong to the insert form; after a reload the form opens with them again.
  createEffect(() => {
    if (map().picker?.length && mode() === "ready") setMode("insert");
  });
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
    setOnline(navigator.onLine);
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
    const connection = () => setOnline(navigator.onLine);
    window.addEventListener(eventName, receive);
    window.addEventListener("focus", focus);
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    void reload();
    onCleanup(() => {
      disposed = true;
      controller.abort();
      window.removeEventListener(eventName, receive);
      window.removeEventListener("focus", focus);
      window.removeEventListener("online", connection);
      window.removeEventListener("offline", connection);
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
        return [{ place, mark: groupIndex === 0 ? String(index + 1) : letter(index), second: groupIndex > 0, group: group.title }];
      }),
    );
  });
  const choices = () => map().picker ?? [];
  const ambiguous = () => Boolean(map().candidates?.length && map().issue?.code === "GEO_ADDRESS_AMBIGUOUS");
  const selection = () => selected() || (map().candidates?.length ? "candidate-0" : choices()[0]?.id || places()[0]?.place.id || "");
  const selectedPlace = () => [...choices(), ...places().map((p) => p.place)].find((p) => p.id === selection());
  const waiting = () => busy() || (map().pending && props.loading);
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
  const web = (placeId: string) => map().web.find((w) => w.placeId === placeId);
  const hours = (place: GeoPlace) =>
    mapOpeningHours(place.openingHours, map().viewedAt ?? place.provenance.computedAt, map().timeZone, locale());
  const markers = createMemo<MapViewMarker[]>(() => {
    if (map().candidates?.length)
      return map().candidates!.map((p, i) => ({ id: `candidate-${i}`, mark: i + 1, label: p.formatted, point: p.point, tone: "second" }));
    const base = choices().length
      ? choices().map((p, i) => ({ id: p.id, mark: i + 1, label: p.name, point: p.point, tone: "second" as const }))
      : places().map((p) => ({
          id: p.place.id,
          mark: p.mark,
          label: p.place.name,
          point: p.place.point,
          tone: p.second ? ("second" as const) : ("accent" as const),
        }));
    const route = map().route;
    const stops =
      (route?.stops ?? map().plan?.stops.flatMap((s) => (s.point ? [{ id: s.id, label: s.label, point: s.point }] : [])))?.map((s, i) => ({
        id: s.id,
        mark: letter(i),
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
  const changedRoute = () => map().preview?.result.route ?? map().route;
  const legOptions = (options: GeoRouteOptions) =>
    `${options.mode ? t()[options.mode] : ""}${options.avoid?.length ? ` · ${t().without} ${options.avoid.map((a) => t()[a]).join(", ")}` : ""}`;
  /** The caller's note, source and links for a place or stop; the map only shows them. */
  const details = (id: string) => {
    const detail = map().details?.find((item) => item.id === id);
    return {
      note: detail?.note,
      source: detail?.source
        ? { label: detail.source.label, icon: detail.source.icon ? `ti ti-${detail.source.icon}` : undefined }
        : undefined,
      links: (detail?.links ?? []).flatMap((link) => {
        const href = aiMapDetailLink(link.url);
        return href ? [{ label: link.label, href }] : [];
      }),
    };
  };
  const placeEntry = (place: GeoPlace, mark: string | number, second: boolean, group?: string): MapPlace => {
    const website = aiMapWebsite(place.website);
    const description = web(place.id);
    const own = details(place.id);
    return {
      id: place.id,
      name: place.name,
      point: place.point,
      mark,
      tone: second ? "second" : "accent",
      group,
      subtitle: `${categoryLabel(place.categories)} · ${hours(place)}`,
      trailing:
        place.atMeters !== undefined
          ? `km ${number(place.atMeters / 1000)}`
          : place.distanceMeters !== undefined
            ? km(place.distanceMeters)
            : undefined,
      trailingDetail: place.distanceToRouteMeters !== undefined ? `${t().corridor} ${km(place.distanceToRouteMeters)}` : undefined,
      address: place.address.formatted,
      hours: hours(place),
      note: [own.note, description?.description].filter(Boolean).join("\n\n") || undefined,
      source: own.source ?? { icon: "ti ti-world", label: `${t().source}: ${place.provenance.attribution.text}` },
      links: [
        ...own.links,
        ...(website ? [{ label: new URL(website).hostname, href: website, icon: "ti ti-world" }] : []),
        ...(description ? [{ label: `${t().description}: ${new URL(description.url).hostname}`, href: description.url }] : []),
      ],
    };
  };
  // The list shows what the map shows: candidates while a stop is ambiguous, search results while picking a stop,
  // otherwise the stops (with the proposed one) and the places.
  const listPlaces = createMemo((): MapPlace[] => {
    if (map().candidates?.length)
      return map().candidates!.map((candidate, i) => ({
        id: `candidate-${i}`,
        name: candidate.formatted,
        point: candidate.point,
        mark: i + 1,
        tone: "second",
        address: candidate.formatted,
        navigate: false,
      }));
    if (choices().length) return choices().map((place, i) => placeEntry(place, i + 1, true, map().lastSearch?.title));
    const route = map().route;
    // During a proposal, each row shows the proposed leg that reaches its stop; the letters stay until it is accepted.
    const legs = changedRoute()?.legs ?? [];
    const legFacts = (stopId: string, first: boolean) => {
      const leg = legs.find((l) => l.toStopId === stopId);
      if (!leg) return { trailing: first ? t().startStop : undefined };
      const before = route?.legs.find((old) => old.fromStopId === leg.fromStopId && old.toStopId === leg.toStopId);
      const changed =
        !!map().preview &&
        (!before ||
          before.polyline6 !== leg.polyline6 ||
          before.durationSeconds !== leg.durationSeconds ||
          before.distanceMeters !== leg.distanceMeters ||
          JSON.stringify(before.options) !== JSON.stringify(leg.options));
      return {
        subtitle: `${legOptions(leg.options)}${changed ? ` · ${t().changed}` : ""}`,
        trailing: minutes(leg.durationSeconds),
        trailingDetail: km(leg.distanceMeters),
      };
    };
    const stops: MapPlace[] = (route?.stops ?? map().plan?.stops ?? []).map((stop, i) => {
      const point = "point" in stop ? stop.point : undefined;
      const known = "address" in stop ? stop.address : undefined;
      const address = known ? ("formatted" in known ? known.formatted : known.text) : undefined;
      return {
        id: stop.id,
        name: stop.label ?? address ?? stop.id,
        point,
        mark: letter(i),
        address,
        ...legFacts(stop.id, i === 0),
        ...details(stop.id),
      };
    });
    const preview = map().preview;
    if (preview?.changes.type === "insert") {
      const inserted = preview.result.route.stops.find((s) => !route?.stops.some((old) => old.id === s.id));
      if (inserted)
        stops.push({ id: inserted.id, name: inserted.label ?? "+", point: inserted.point, mark: "+", ...legFacts(inserted.id, false) });
    }
    return [
      ...stops,
      ...places().map((p) => placeEntry(p.place, p.mark, p.second, map().groups.length > 1 || stops.length ? p.group : undefined)),
    ];
  });
  const canReduceReservation = () =>
    Boolean(map().plan && !map().route && map().issue?.requiredCredits && (map().issue?.availableCredits ?? 0) > 0) &&
    !map().availability.cloud.exhausted &&
    !map().availability.person.exhausted;
  const blocked = () =>
    !map().availability.configured ||
    map().issue?.code === "GEO_NOT_CONFIGURED" ||
    (map().issue?.code === "GEO_BUDGET_EXHAUSTED" && !canReduceReservation());
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
    run({
      type: "search",
      insert,
      search: {
        title: t().stopSearch,
        name: placeName().trim() || undefined,
        categories: [category()],
        along: { fromKm: fromKm(), toKm: toKm() },
      },
    });
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
  const costConfirmationRequired = () => map().issue?.requiresCostConfirmation || map().issue?.code === "GEO_COST_OVERRUN";
  const issueText = () => {
    const issue = map().issue;
    if (!map().availability.configured || issue?.code === "GEO_NOT_CONFIGURED") return t().off;
    if (issue?.code === "GEO_BUDGET_EXHAUSTED")
      return `${issue.scope === "person" ? t().person : t().cloud}: ${t().budget}. ${t().reset}: ${issue.resetsAt ? new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: map().timeZone ?? "UTC" }).format(new Date(issue.resetsAt)) : ""}`;
    if (issue?.code === "GEO_COST_OVERRUN") return t().cost;
    if (issue?.code === "GEO_LIMIT_EXCEEDED" && issue.requiredCredits !== undefined) return t().routeLimit;
    if (issue?.code === "GEO_NO_ROUTE") return t().noRoute;
    if (issue?.code === "GEO_BUSY") return `${t().failed} (${issue.retryAfterSeconds ?? 1} s)`;
    return t().failed;
  };
  /** The tile names the map's state; the way out is in the dialog. */
  const stateText = () => {
    const issue = map().issue;
    if (!map().availability.configured || issue?.code === "GEO_NOT_CONFIGURED") return t().offShort;
    if (ambiguous()) return t().choose;
    if (costConfirmationRequired()) return t().costShort;
    if (issue?.code === "GEO_BUDGET_EXHAUSTED" || issue?.code === "GEO_LIMIT_EXCEEDED") return t().limitShort;
    if (issue || (map().pending && !props.loading)) return t().failedShort;
    return undefined;
  };
  const summary = () => {
    if (map().pending && props.loading) return t().loading;
    const state = stateText();
    if (state) return state;
    const route = changedRoute();
    if (map().kind === "route" && route) {
      const order =
        route.stops.length >= ORDER_STOPS ? `${number(route.stops.length)} ${t().stops}` : route.stops.map((_, i) => letter(i)).join(" → ");
      return `${km(route.distanceMeters)} · ${duration(route.durationSeconds)} · ${order}`;
    }
    return places().length ? `${number(places().length)} ${t().places}` : t().noPlaces;
  };
  const recovery = () => (
    <div class="ai-map__state" role="status">
      <p>{issueText()}</p>
      <Show when={!costConfirmationRequired()}>
        <Button variant="ghost" size="sm" disabled={busy()} onClick={() => void run({ type: "retry" })}>
          {t().retry}
        </Button>
      </Show>
      <Show when={map().issue?.requiredCredits !== undefined}>
        <p>
          {t().budgetNumbers({
            required: number(map().issue!.requiredCredits!),
            available: number(map().issue!.availableCredits ?? 0),
            missing: number(map().issue!.shortfallCredits ?? 0),
          })}
        </p>
      </Show>
      <Show when={costConfirmationRequired()}>
        <Show when={map().issue?.code !== "GEO_COST_OVERRUN"}>
          <p>{t().cost}</p>
        </Show>
        <Show when={map().issue?.costs}>
          {(costs) => (
            <p>
              {t().recordedCosts({
                settled: number(costs().settledCredits),
                unknown: number(costs().unknownCredits),
              })}
            </p>
          )}
        </Show>
        <p>{t().noInvoiceCap}</p>
        <Button size="sm" disabled={busy()} onClick={() => void run({ type: "retry" })}>
          {t().resumeRoute}
        </Button>
      </Show>
      <Show when={map().plan && !map().route && !costConfirmationRequired() && !blocked()}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setRepairStop(map().ambiguousStopId ?? map().plan!.stops.at(-1)!.id);
            setStart("");
            setRepairPoint(undefined);
            setMode("repair");
          }}
        >
          {t().changeStop}
        </Button>
      </Show>
      <Show when={canAdmin() && (blocked() || map().issue?.requiredCredits !== undefined)}>
        <ButtonLink href="/admin/settings?tab=places" variant="ghost" size="sm">
          {map().availability.configured ? t().limits : t().configure}
        </ButtonLink>
      </Show>
    </div>
  );
  const menu = (): MapDialogMenuItem[] | undefined => {
    if (map().kind !== "route") return undefined;
    // One tool at a time: an open form, results to pick from, a proposal, a question, or a recovery comes first.
    const idle =
      busy() ||
      !map().route ||
      !!waiting() ||
      mode() !== "ready" ||
      !!map().preview ||
      !!map().picker?.length ||
      ambiguous() ||
      !!map().issue;
    return [
      {
        label: t().insert,
        icon: "ti ti-map-pin-plus",
        disabled: idle,
        onSelect: () => {
          setMode("insert");
          setCategory("attraction");
          setFromKm(0);
          setToKm(Math.min(200, (map().route?.distanceMeters ?? 0) / 1000));
        },
      },
      {
        label: t().optimize,
        icon: "ti ti-arrows-sort",
        disabled: idle,
        onSelect: () => void run({ type: "preview", change: { type: "optimize" } }),
      },
      { label: t().options, icon: "ti ti-adjustments", disabled: idle, onSelect: showOptions },
      {
        label: t().along,
        icon: "ti ti-tools-kitchen-2",
        disabled: idle,
        onSelect: () => {
          setMode("along");
          setCategory("restaurant");
          setFromKm(40);
          setToKm(80);
        },
      },
    ];
  };
  const placeActions = (place: MapPlace) => {
    if (place.id.startsWith("candidate-"))
      return (
        <Button size="sm" disabled={busy()} onClick={() => void run({ type: "choose", index: Number(place.id.slice(10)) })}>
          {place.name} · {t().useStop}
        </Button>
      );
    if (choices().some((p) => p.id === place.id))
      return (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy() || mode() !== "insert"}
          onClick={() => void run({ type: "preview", change: { type: "insert", placeId: place.id } })}
        >
          {t().preview} {place.name}
        </Button>
      );
    if (map().kind !== "places" || !places().some((p) => p.place.id === place.id)) return undefined;
    return (
      <>
        <Button
          size="sm"
          variant="secondary"
          aria-disabled={!online() || undefined}
          disabled={busy()}
          onClick={() => online() && void routeHere()}
        >
          <i class="ti ti-route" aria-hidden="true" /> {t().here}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy()}
          onClick={() => void run({ type: "search", search: { title: t().nearby, categories: ["cafe"], placeId: place.id } })}
        >
          <i class="ti ti-radar" aria-hidden="true" /> {t().nearby}
        </Button>
      </>
    );
  };
  // One zone above the list holds the open form, the proposal to confirm, the recovery, or the last change's undo.
  const tools = () => (
    <div class="ai-map-tools">
      <Show when={error()}>
        <div role="alert" class="ai-map__error">
          {error()}{" "}
          <Button variant="ghost" size="sm" disabled={busy()} onClick={() => void reload()}>
            {t().reload}
          </Button>
        </div>
      </Show>
      <Switch>
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
                ...(map().route?.legs.map((leg, i) => ({ value: String(i), label: `${letter(i)} → ${letter(i + 1)}` })) ?? []),
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
            <div class="ai-map__actions">
              <Button size="sm" disabled={busy()} onClick={() => void optionChange()}>
                {t().calculate}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("ready")}>
                {t().cancel}
              </Button>
            </div>
          </div>
        </Match>
        <Match when={mode() === "insert" || mode() === "along"}>
          <div class="ai-map__search">
            <div class="ai-map__actions">
              <TextInput
                label={t().placeName}
                type="search"
                icon="ti ti-search"
                placeholder={t().placeNamePlaceholder}
                value={placeName()}
                maxLength={300}
                disabled={busy()}
                onValueChange={setPlaceName}
              />
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
            </div>
            <Show when={!choices().length}>
              <div class="ai-map__actions">
                <NumberInput label={t().from} value={fromKm()} min={0} onValueChange={(v) => setFromKm(v ?? 0)} />
                <NumberInput label={t().to} value={toKm()} min={0} onValueChange={(v) => setToKm(v ?? 0)} />
              </div>
            </Show>
            <div class="ai-map__actions">
              <Button
                size="sm"
                disabled={busy() || placeName().trim().length > 300 || toKm() <= fromKm() || toKm() - fromKm() > 200}
                onClick={() => void search(mode() === "insert")}
              >
                {t().search}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMode("ready");
                  if (choices().length) void run({ type: "discard" });
                }}
              >
                {t().cancel}
              </Button>
            </div>
          </div>
        </Match>
        <Match when={mode() === "start"}>
          <div class="ai-map__search">
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
              <Button size="sm" variant="ghost" onClick={() => setMode("ready")}>
                {t().cancel}
              </Button>
            </div>
          </div>
        </Match>
        <Match when={mode() === "repair"}>
          <div class="ai-map__search">
            <Select
              label={t().changeStop}
              value={repairStop()}
              onValueChange={(v) => {
                setRepairStop(v ?? "");
                setStart("");
                setRepairPoint(undefined);
              }}
              options={
                map().plan?.stops.map((s, i) => ({ value: s.id, label: `${letter(i)} · ${s.label ?? s.address?.text ?? s.id}` })) ?? []
              }
            />
            <AddressAutocomplete
              label={t().start}
              value={start()}
              availability={map().availability}
              disabled={busy()}
              onValueChange={(value) => {
                setStart(value);
                setRepairPoint(undefined);
              }}
              onOwnEntry={() => setRepairPoint(undefined)}
              onPick={(address) => {
                setStart(address.formatted.slice(0, 300));
                setRepairPoint(address.point);
              }}
            />
            <div class="ai-map__actions">
              <Button
                size="sm"
                disabled={busy() || !repairStop() || !start().trim()}
                onClick={() =>
                  void run({ type: "repair", stopId: repairStop(), address: start(), ...(repairPoint() ? { point: repairPoint() } : {}) })
                }
              >
                {t().calculate}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("ready")}>
                {t().cancel}
              </Button>
            </div>
          </div>
        </Match>
        <Match when={ambiguous()}>
          <div class="ai-map__confirm" role="status">
            <p>{t().choose}</p>
            <Show when={costConfirmationRequired()}>
              <p class="ai-map__muted">{t().cost}</p>
            </Show>
            <Show when={map().plan}>
              <div class="ai-map__actions">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRepairStop(map().ambiguousStopId ?? map().plan!.stops[0]!.id);
                    setStart("");
                    setRepairPoint(undefined);
                    setMode("repair");
                  }}
                >
                  {t().changeStop}
                </Button>
              </div>
            </Show>
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
              <Show when={preview().changes.type === "optimize"}>
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
              </Show>
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
        <Match when={map().issue || (map().pending && !props.loading)}>{recovery()}</Match>
        <Match when={map().receipt}>
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
        </Match>
      </Switch>
    </div>
  );
  const facts = () => {
    if (map().kind !== "route") return undefined;
    const route = changedRoute();
    const preview = map().preview;
    return [
      { value: route ? km(route.distanceMeters) : "—", label: t().distance },
      { value: route ? duration(route.durationSeconds) : "—", label: t().duration },
      ...(preview
        ? [
            {
              value: `${preview.result.delta.durationSeconds > 0 ? "+" : ""}${minutes(preview.result.delta.durationSeconds)}`,
              label: `${preview.result.delta.distanceMeters > 0 ? "+" : ""}${km(preview.result.delta.distanceMeters)}`,
            },
          ]
        : []),
    ];
  };
  const provenance = () => {
    const route = map().route;
    if (route) return `${t().route}: ${route.provenance.attribution.text} · ${t().noTraffic} ${time(route.provenance.computedAt)}`;
    return places()[0]?.place.provenance.attribution.text ?? "Geoapify · OpenStreetMap";
  };
  return (
    <div class="ai-map-host">
      <section
        id={mapAnchor(map().id)}
        class="ai-map"
        data-kind={map().kind}
        tabIndex={-1}
        aria-label={map().title}
        aria-busy={busy() || props.loading}
      >
        <MapTile
          label={`${t().open}: ${map().title}, ${summary()}`}
          summary={summary()}
          loading={!!(map().pending && props.loading)}
          restoreId={map().id}
          restoreQuery={map().anchorSeq ? { message: String(map().anchorSeq) } : undefined}
          dialog={(close) => (
            <MapDialog
              title={map().title}
              facts={facts()}
              count={map().kind === "places" ? `${number(places().length)} ${t().places}` : undefined}
              listLabel={ambiguous() ? t().choose : map().kind === "route" ? t().stops : t().places}
              places={listPlaces()}
              lines={lines()}
              markers={markers().filter((marker) => !listPlaces().some((place) => place.id === marker.id))}
              fit={map().candidates?.length || choices().length ? "markers" : "all"}
              selectedId={selection()}
              onSelect={setSelected}
              loading={!!waiting()}
              empty={
                <>
                  <p>{t().noPlaces}</p>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!map().lastSearch || busy()}
                    onClick={() => void run({ type: "search", search: { ...map().lastSearch!, radiusMeters: 10000 } })}
                  >
                    {t().expand}
                  </Button>
                </>
              }
              map={(view) => <CloudMap {...view} availability={map().availability} />}
              menu={menu()}
              placeActions={placeActions}
              placeHint={(place) =>
                !online() && map().kind === "places" && places().some((p) => p.place.id === place.id) ? t().offlineRoute : undefined
              }
              notice={tools()}
              provenance={provenance()}
              onLocation={setLocation}
              onClose={close}
            />
          )}
        >
          <CloudMap
            still
            height={TILE_HEIGHT}
            markers={markers()}
            lines={lines()}
            fit={map().candidates?.length || choices().length ? "markers" : "all"}
            availability={map().availability}
          />
        </MapTile>
      </section>
    </div>
  );
}
