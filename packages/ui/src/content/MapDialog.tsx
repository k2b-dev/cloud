import { createEffect, createMemo, createSignal, createUniqueId, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { ButtonLink, IconButton } from "../actions/Button";
import { CopyButton } from "../actions/CopyButton";
import { Dropdown } from "../actions/Dropdown";
import { attachSheetHandle } from "../layout/sheet-handle";
import { prefersReducedMotion } from "../motion";
import { useMapDialogMessages } from "./map-dialog-messages";
import { type GeoNavigationPlatform, geoNavigationHref, geoNavigationPlatform } from "./map-navigation";
import { DEFAULT_PADDING } from "./map-view-geometry";
import type { MapViewFit, MapViewLine, MapViewMarker, MapViewOwnLocation, MapViewPoint, MapViewTone } from "./map-view-types";

/** A link the host gives a place, such as "Open contact". Only http(s) and same-origin paths are rendered. */
export type MapPlaceLink = { label: string; href: string; icon?: string };
/** Where a place's information comes from. `tone: "ai"` marks a suggestion that an account without a person made. */
export type MapPlaceSource = { label: string; icon?: string; tone?: "ai" };
export type MapPlace = {
  id: string;
  name: string;
  /** Without a point the place is listed but has no pin; navigation then uses the address text. */
  point?: MapViewPoint;
  /** A number, a single letter, or "+", as on MapView markers. */
  mark?: number | string;
  tone?: MapViewTone;
  /** The heading of the place's group in the list, such as the search that found it; shown where the group starts. */
  group?: string;
  /** Second line in the list. */
  subtitle?: string;
  /** Right column of the list row, for example a leg's minutes and kilometres. */
  trailing?: string;
  trailingDetail?: string;
  address?: string;
  hours?: string;
  note?: string;
  source?: MapPlaceSource;
  links?: MapPlaceLink[];
};
export type MapDialogFact = { value: string; label: string };
export type MapDialogMenuItem = { label: string; icon?: string; disabled?: boolean; onSelect: () => void };
/** What the host's map needs; spread it onto MapView or a wrapper of it. */
export type MapDialogMapView = {
  height: number;
  padding: number;
  markers: MapViewMarker[];
  lines?: MapViewLine[];
  fit?: MapViewFit;
  selectedId?: string;
  onSelect: (id: string) => void;
  ownLocation?: MapViewOwnLocation;
  onLocate: () => void;
  /** A message about the own location, for MapView's `notice`. */
  notice?: JSX.Element;
};
export type MapDialogProps = {
  title: string;
  /** Large figures under the title, such as distance and driving time. */
  facts?: MapDialogFact[];
  /** A chip under the title when there are no facts, such as "12 places". */
  count?: string;
  /** Name of the list for assistive technology, such as "Stops". */
  listLabel?: string;
  places: MapPlace[];
  lines?: MapViewLine[];
  /** Pins beyond the places, such as a proposed stop; drawn but not listed. */
  markers?: MapViewMarker[];
  fit?: MapViewFit;
  /** Controlled selection; otherwise the first place is selected. */
  selectedId?: string;
  onSelect?: (id: string) => void;
  loading?: boolean;
  /** Replaces the list when there are no places, for example with an action that widens the search. */
  empty?: JSX.Element;
  /** Renders the map; the dialog supplies its height, pins, lines, and selection. */
  map: (view: MapDialogMapView) => JSX.Element;
  menu?: MapDialogMenuItem[];
  /** More actions beside the navigation link of the selected place. */
  placeActions?: (place: MapPlace) => JSX.Element;
  /** A short line under the actions, such as why one of them is unavailable right now. */
  placeHint?: (place: MapPlace) => string | undefined;
  /** Host content above the list, such as a confirmation or a recovery. */
  notice?: JSX.Element;
  /** The source line at the bottom. */
  provenance?: JSX.Element;
  /** The person's location after "Show my location", for example to start a route there. */
  onLocation?: (location: MapViewOwnLocation) => void;
  onClose: () => void;
};

const PHONE = "(max-width: 47.999rem)";
const SHEET_DETENTS = ["peek", "half", "full"] as const;

/** Only web links and same-origin paths; any other scheme is dropped. */
export const safeMapLink = (href: string): { href: string; external: boolean } | null => {
  try {
    const base = typeof location === "undefined" ? "https://localhost" : location.href;
    const url = new URL(href, base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const external = typeof location === "undefined" ? /^[a-z][a-z0-9+.-]*:/i.test(href) : url.origin !== location.origin;
    return { href: url.href, external };
  } catch {
    return null;
  }
};

/**
 * The full map: map and list side by side in a dialog, on a phone the map on the whole screen with the list as a
 * sheet. Map and list share one selection; the selected place shows its details and a navigation link.
 */
export function MapDialog(props: MapDialogProps): JSX.Element {
  const t = useMapDialogMessages();
  const id = createUniqueId();
  const [own, setOwn] = createSignal<string>();
  const [platform, setPlatform] = createSignal<GeoNavigationPlatform>("desktop");
  const [mapHeight, setMapHeight] = createSignal(480);
  const [mapWidth, setMapWidth] = createSignal(480);
  // One pin alone would fit at street level; a 128 px box shows its neighbourhood, as the tile does.
  const padding = () =>
    markers().length === 1 ? Math.max(DEFAULT_PADDING, Math.floor((Math.min(mapHeight(), mapWidth()) - 128) / 2)) : DEFAULT_PADDING;
  const [detent, setDetent] = createSignal<string>("half");
  const [location, setLocation] = createSignal<MapViewOwnLocation>();
  const [locationError, setLocationError] = createSignal("");
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const locate = () => {
    if (!navigator.geolocation) {
      setLocationError(t().locationFailed);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (disposed) return;
        const found = {
          point: { lat: position.coords.latitude, lon: position.coords.longitude },
          accuracyMeters: position.coords.accuracy,
        };
        setLocation(found);
        setLocationError("");
        props.onLocation?.(found);
      },
      (error) => {
        if (!disposed) setLocationError(error.code === error.PERMISSION_DENIED ? t().noLocation : t().locationFailed);
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  };
  const single = () => props.places.length === 1 && !props.loading;
  const selected = createMemo(() => {
    const wanted = props.selectedId ?? own();
    return props.places.find((place) => place.id === wanted) ?? props.places[0];
  });
  const select = (placeId: string, via: "list" | "pin") => {
    setOwn(placeId);
    props.onSelect?.(placeId);
    if (via === "pin") {
      // A pin picked behind the lowered sheet raises it, so its details are in view.
      if (sheet && detent() === "peek" && matchMedia(PHONE).matches) {
        sheet.dataset.sheetDetent = "half";
        setDetent("half");
      }
      // On a phone the details come first in the sheet, which shows them from its top; beside the map, the row is shown.
      if (!matchMedia(PHONE).matches) list?.querySelector(`[data-place-id="${CSS.escape(placeId)}"]`)?.scrollIntoView({ block: "nearest" });
    }
  };
  const markers = createMemo<MapViewMarker[]>(() => [
    ...props.places.flatMap((place) =>
      place.point ? [{ id: place.id, point: place.point, label: place.name, mark: place.mark, tone: place.tone }] : [],
    ),
    ...(props.markers ?? []),
  ]);
  let mapBox!: HTMLDivElement;
  let sheet: HTMLDivElement | undefined;
  let handle: HTMLButtonElement | undefined;
  let list: HTMLDivElement | undefined;
  onMount(() => {
    setPlatform(geoNavigationPlatform(navigator.userAgent));
    const measure = () => {
      setMapHeight(Math.max(160, Math.round(mapBox.clientHeight)));
      setMapWidth(Math.round(mapBox.clientWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(mapBox);
    onCleanup(() => observer.disconnect());
    if (sheet && handle) {
      const dispose = attachSheetHandle(handle, {
        sheet,
        detents: SHEET_DETENTS,
        initial: "half",
        onChange: setDetent,
      });
      onCleanup(dispose);
    }
  });
  // A new selection on the phone shows its details from the top of the sheet.
  createEffect(
    on(
      () => selected()?.id,
      () => {
        if (sheet && matchMedia(PHONE).matches)
          sheet.querySelector(".k2b-map-dialog__body")?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
      },
      { defer: true },
    ),
  );
  const keydown = (event: KeyboardEvent) => {
    const places = props.places;
    const index = places.findIndex((place) => place.id === selected()?.id);
    const next =
      event.key === "ArrowDown"
        ? Math.min(index + 1, places.length - 1)
        : event.key === "ArrowUp"
          ? Math.max(index - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? places.length - 1
              : -1;
    const target = places[next];
    if (!target) return;
    event.preventDefault();
    select(target.id, "list");
    list?.querySelector(`[data-place-id="${CSS.escape(target.id)}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const navigation = (place: MapPlace) =>
    geoNavigationHref({ point: place.point, text: place.address ?? place.name, name: place.name }, platform());
  const links = (place: MapPlace) =>
    (place.links ?? []).flatMap((link) => {
      const safe = safeMapLink(link.href);
      return safe ? [{ ...link, ...safe }] : [];
    });

  const detail = (place: MapPlace) => (
    <>
      <Show when={!single()}>
        <h3 class="k2b-map-dialog__place-name">{place.name}</h3>
      </Show>
      <Show when={place.source}>
        {(source) => (
          <div class={`k2b-map-dialog__source${source().tone === "ai" ? " k2b-map-dialog__source-ai" : ""}`}>
            <i class={source().tone === "ai" ? "ti ti-sparkles" : (source().icon ?? "ti ti-info-circle")} aria-hidden="true" />
            <span>{source().label}</span>
          </div>
        )}
      </Show>
      <Show when={place.address}>
        {(address) => (
          <div class="k2b-map-dialog__address">
            <span>{address()}</span>
            <CopyButton text={address()} label={t().copyAddress} copiedLabel={t().copied} iconOnly size="xs" />
          </div>
        )}
      </Show>
      <Show when={place.hours}>
        <div class="k2b-map-dialog__hours">
          <i class="ti ti-clock" aria-hidden="true" />
          <span>{place.hours}</span>
        </div>
      </Show>
      <Show when={place.note}>
        <p class="k2b-map-dialog__note">{place.note}</p>
      </Show>
      <div class="k2b-map-dialog__actions">
        <ButtonLink
          variant="primary"
          size="sm"
          href={navigation(place)}
          target={platform() === "android" ? undefined : "_blank"}
          rel="noopener noreferrer"
        >
          <i class="ti ti-navigation" aria-hidden="true" /> {t().navigate({ platform: platform() })}
        </ButtonLink>
        {props.placeActions?.(place)}
        <For each={links(place)}>
          {(link) => (
            <ButtonLink
              variant="secondary"
              size="sm"
              href={link.href}
              target={link.external ? "_blank" : undefined}
              rel={link.external ? "noopener noreferrer" : undefined}
            >
              <i class={link.icon ?? (link.external ? "ti ti-external-link" : "ti ti-arrow-up-right")} aria-hidden="true" /> {link.label}
            </ButtonLink>
          )}
        </For>
      </div>
      <Show when={props.placeHint?.(place)}>{(hint) => <p class="k2b-map-dialog__hint">{hint()}</p>}</Show>
    </>
  );

  return (
    <div class="k2b-map-dialog" data-single={single() || undefined} data-loading={props.loading || undefined}>
      <div ref={mapBox} class="k2b-map-dialog__map">
        {props.map({
          get height() {
            return mapHeight();
          },
          get markers() {
            return markers();
          },
          get padding() {
            return padding();
          },
          get lines() {
            return props.lines;
          },
          get fit() {
            return props.fit;
          },
          get selectedId() {
            return selected()?.id;
          },
          onSelect: (placeId) => {
            if (props.places.some((place) => place.id === placeId)) select(placeId, "pin");
            else props.onSelect?.(placeId);
          },
          get ownLocation() {
            return location();
          },
          onLocate: locate,
          get notice() {
            return locationError() || undefined;
          },
        })}
      </div>
      <IconButton class="k2b-map-dialog__close-float k2b-overlay-surface" label={t().close} tooltip={false} onClick={() => props.onClose()}>
        <i class="ti ti-x" aria-hidden="true" />
      </IconButton>
      <div ref={sheet} class="k2b-map-dialog__side" data-sheet-detent="half">
        <button
          ref={handle}
          type="button"
          class="k2b-map-dialog__handle"
          aria-label={detent() === "full" ? t().shrink : t().enlarge}
          aria-controls={`${id}-body`}
        />
        <div class="k2b-map-dialog__head">
          <div class="k2b-map-dialog__title">
            <h2>{props.title}</h2>
            <Show when={props.menu?.length}>
              <Dropdown.Root
                label={t().more}
                items={(props.menu ?? []).map((item) => ({
                  label: item.label,
                  icon: item.icon,
                  disabled: item.disabled,
                  action: item.onSelect,
                }))}
              >
                <Dropdown.Trigger iconOnly label={t().more} size="sm" variant="ghost">
                  <i class="ti ti-dots" aria-hidden="true" />
                </Dropdown.Trigger>
              </Dropdown.Root>
            </Show>
            <IconButton class="k2b-map-dialog__close" label={t().close} tooltip={false} onClick={() => props.onClose()}>
              <i class="ti ti-x" aria-hidden="true" />
            </IconButton>
          </div>
          <Show
            when={props.facts?.length}
            fallback={
              <Show when={props.count}>
                <div>
                  <span class="k2b-map-dialog__count">{props.count}</span>
                </div>
              </Show>
            }
          >
            <div class="k2b-map-dialog__facts">
              <For each={props.facts}>
                {(fact) => (
                  <div>
                    <strong>{props.loading ? "—" : fact.value}</strong>
                    <small>{fact.label}</small>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
        <div class="k2b-map-dialog__body" id={`${id}-body`}>
          <Show when={props.notice}>
            <div class="k2b-map-dialog__notice">{props.notice}</div>
          </Show>
          <Show
            when={!props.loading}
            fallback={
              <div class="k2b-map-dialog__list" aria-busy="true">
                <p class="k2b-map-dialog__loading" role="status">
                  {t().loading}
                </p>
                <For each={[1, 2, 3, 4]}>{() => <span class="k2b-map-dialog__skeleton" />}</For>
              </div>
            }
          >
            <Show
              when={props.places.length}
              fallback={
                <div class="k2b-map-dialog__empty">
                  <span class="k2b-map-dialog__empty-icon" aria-hidden="true">
                    <i class="ti ti-map-pin" />
                  </span>
                  {props.empty ?? <p>{t().empty}</p>}
                </div>
              }
            >
              <Show when={!single()}>
                <div
                  ref={list}
                  class="k2b-map-dialog__list"
                  role="listbox"
                  tabIndex={0}
                  aria-label={props.listLabel ?? t().places}
                  aria-activedescendant={selected() ? `${id}-place-${props.places.indexOf(selected()!)}` : undefined}
                  onKeyDown={keydown}
                >
                  <For each={props.places}>
                    {(place, index) => (
                      <>
                        <Show when={place.group && place.group !== props.places[index() - 1]?.group}>
                          <div class="k2b-map-dialog__group" data-tone={place.tone} aria-hidden="true">
                            {place.group}
                          </div>
                        </Show>
                        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the listbox handles the keys through aria-activedescendant. */}
                        <div
                          id={`${id}-place-${index()}`}
                          class="k2b-map-dialog__place"
                          role="option"
                          data-place-id={place.id}
                          data-tone={place.tone}
                          aria-selected={selected()?.id === place.id}
                          onClick={() => select(place.id, "list")}
                        >
                          <span class="k2b-map-dialog__mark" data-empty={place.mark === undefined || undefined} aria-hidden="true">
                            {place.mark}
                          </span>
                          <span class="k2b-map-dialog__place-text">
                            <span>{place.name}</span>
                            <Show when={place.subtitle}>
                              <small>{place.subtitle}</small>
                            </Show>
                          </span>
                          <Show when={place.trailing || place.trailingDetail}>
                            <span class="k2b-map-dialog__trailing">
                              <span>{place.trailing}</span>
                              <small>{place.trailingDetail}</small>
                            </span>
                          </Show>
                        </div>
                      </>
                    )}
                  </For>
                </div>
              </Show>
              <div class="k2b-map-dialog__detail" aria-live="polite">
                <Show when={selected()} keyed>
                  {(place) => detail(place)}
                </Show>
              </div>
            </Show>
          </Show>
          <Show when={props.provenance}>
            <div class="k2b-map-dialog__provenance">{props.provenance}</div>
          </Show>
        </div>
      </div>
    </div>
  );
}
