import type { GeoAvailabilityDataSchema } from "@k2b/cloud/contracts";
import { type GeoDocument, type GeoDocumentLink, GeoDocumentSchema } from "@k2b/cloud/geo/document";
import { highlight } from "@k2b/stdlib";
import { LocaleProvider, MapViewFrame, type MapViewMarker, mapAttribution } from "@k2b/ui";
import { createComponent } from "solid-js";
import { isServer, renderToString } from "solid-js/web";
import type { z } from "zod";
import { notebookMapMessages } from "./map-messages";
import { directives, QUERY_MAX_BLOCKS } from "./query-blocks";

export type NotebookMapState = {
  availability?: z.infer<typeof GeoAvailabilityDataSchema>;
  failed?: boolean;
  canAdmin?: boolean;
};
export type NotebookMapImage = { src: string; width: number; height: number };
export type NotebookMapBlock = { line: number; document: GeoDocument; from: number; to: number };
const escape = highlight.escape;

/** Revision of the exact bounded UTF-8 export text; JSON escaping must not reduce the Markdown budget. */
export async function notebookMapRevision(markdown: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(markdown));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseNotebookMapBlocks(markdown: string) {
  const blocks: NotebookMapBlock[] = [];
  const invalid: number[] = [];
  const found = directives(markdown).filter((block) => block.type === "map");
  for (const block of found.slice(0, QUERY_MAX_BLOCKS)) {
    try {
      const parsed = block.closed && GeoDocumentSchema.safeParse(JSON.parse(block.body.join("\n")));
      if (!parsed || !parsed.success) invalid.push(block.line);
      else blocks.push({ line: block.line, document: parsed.data, from: block.from, to: block.to });
    } catch {
      invalid.push(block.line);
    }
  }
  invalid.push(...found.slice(QUERY_MAX_BLOCKS).map((block) => block.line));
  return { blocks, invalid };
}

export function mapMarkers(document: GeoDocument): MapViewMarker[] {
  return [
    ...document.pins.map((pin, index) => ({ id: pin.id, point: pin.point, label: pin.label, mark: index + 1 })),
    ...(document.route?.stops.map((stop, index) => ({
      id: `route-${stop.id}`,
      point: stop.point,
      label: stop.label ?? stop.address?.formatted ?? String.fromCharCode(65 + index),
      mark: String.fromCharCode(65 + index),
      tone: document.pins.length ? ("second" as const) : ("accent" as const),
    })) ?? []),
  ];
}
export function mapLinkHref(link: GeoDocumentLink, notebookId: string, mode = "book") {
  if (link.type === "url") return link.url;
  return `/app/notebooks/${encodeURIComponent(notebookId)}/notes/${encodeURIComponent(link.noteId)}?mode=${mode}${link.type === "heading" ? `#${encodeURIComponent(link.heading)}` : ""}`;
}
export function mapBlocked(state?: NotebookMapState) {
  const available = state?.availability;
  return !!available && (!available.configured || available.person.exhausted || available.cloud.exhausted);
}
export function mapStateMessage(state: NotebookMapState, locale: string) {
  const t = notebookMapMessages.resolve([locale]).t;
  const available = state.availability;
  if (available && !available.configured) return t.notConfigured;
  if (available?.cloud.exhausted)
    return t.cloudBudget({
      time:
        new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(
          new Date(available.cloud.resetsAt),
        ) + " UTC",
    });
  if (available?.person.exhausted)
    return t.personBudget({
      time:
        new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(
          new Date(available.person.resetsAt),
        ) + " UTC",
    });
  return state.failed ? t.unavailable : "";
}
export function routeMetrics(document: GeoDocument, locale: string) {
  const route = document.route;
  if (!route) return "";
  const t = notebookMapMessages.resolve([locale]).t;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const minutes = Math.round(route.durationSeconds / 60);
  const time =
    minutes >= 60
      ? `${number.format(Math.floor(minutes / 60))} h ${number.format(minutes % 60)} min`
      : t.minutes({ count: number.format(minutes) });
  const date = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(
    new Date(document.savedAt ?? route.provenance.computedAt),
  );
  return `${number.format(route.distanceMeters / 1000)} km · ${time} · ${document.savedAt ? t.saved({ date }) : t.computed({ date })}`;
}
export function routeSummary(document: GeoDocument, locale: string) {
  const route = document.route;
  if (!route) return "";
  const names = route.stops.map((stop) => stop.label ?? stop.address?.formatted ?? `${stop.point.lat}, ${stop.point.lon}`).join(" → ");
  return `${names} · ${routeMetrics(document, locale)}`;
}

/** Trusted markup is restored after the Markdown sanitizer, like the shared chart drawing. All stored strings escape. */
export function renderNotebookMapFigure(
  document: GeoDocument,
  options: {
    locale: string;
    notebookId: string;
    mode?: string;
    state?: NotebookMapState;
    print?: boolean;
    image?: NotebookMapImage;
    publicOrigin?: string;
    noteId?: string;
  },
) {
  const { locale, state } = options;
  const t = notebookMapMessages.resolve([locale]).t;
  const blocked = mapBlocked(state);
  const routeOnly = !!document.route && document.pins.length === 0;
  const height = routeOnly ? 240 : 320;
  const markers = mapMarkers(document);
  const lines = document.route ? [{ id: "route", polyline6: document.route.polyline6 }] : [];
  const json = escape(JSON.stringify(document));
  const attrs = options.print
    ? ' data-map-print=""'
    : ` data-map-document="${json}" data-map-state="${escape(JSON.stringify(state ?? {}))}" data-notebook="${escape(options.notebookId)}" data-map-mode="${escape(options.mode ?? "book")}"`;
  let frame = options.image
    ? `<img class="notebook-map__image" src="${escape(options.image.src)}" width="${options.image.width}" height="${options.image.height}" alt="${escape(document.title)}">`
    : "";
  if (!blocked && !options.print && !options.image) {
    try {
      frame = isServer
        ? renderToString(() =>
            createComponent(LocaleProvider, {
              locale,
              get children() {
                return createComponent(MapViewFrame, {
                  height,
                  markers,
                  lines,
                  selectedId: document.pins[0]?.id,
                  attribution: "Geoapify · OpenStreetMap",
                });
              },
            }),
          )
        : `<div class="notebook-map__placeholder" style="height:${height}px" role="status">${escape(t.loading)}</div>`;
    } catch {
      frame = `<p class="notebook-map__notice" role="status">${escape(t.invalid)}</p>`;
    }
  }
  const linkHref = (link: GeoDocumentLink) => {
    if (options.print && link.type !== "url" && link.noteId === options.noteId)
      return link.type === "heading" ? `#${encodeURIComponent(link.heading)}` : "#top";
    const href = mapLinkHref(link, options.notebookId, options.mode);
    return options.print && options.publicOrigin && href.startsWith("/") ? new URL(href, options.publicOrigin).href : href;
  };
  const imageSource = mapAttribution.map((item) => `<a href="${escape(item.href)}">${escape(item.label)}</a>`).join(" · ");
  const list = document.pins
    .map(
      (pin, index) =>
        `<li class="notebook-map__pin"><span class="notebook-map__number">${index + 1}</span><span class="notebook-map__name">${escape(pin.label)}</span>${pin.link ? `<a class="notebook-map__link" data-reference="${pin.link.type === "url" ? "page" : pin.link.type}" href="${escape(linkHref(pin.link))}"><i class="ti ti-${pin.link.type === "url" ? "link" : pin.link.type === "heading" ? "heading" : "file-text"}" aria-hidden="true"></i><span>${escape(pin.link.label)}</span></a>` : ""}</li>`,
    )
    .join("");
  return `<figure class="notebook-map${routeOnly ? " notebook-map--route" : ""}"${attrs}><figcaption class="notebook-map__header"><i class="ti ti-${routeOnly ? "route" : "map-2"}" aria-hidden="true"></i><strong>${escape(document.title)}</strong>${routeOnly ? `<span class="notebook-map__summary">${escape(routeMetrics(document, locale))}</span>` : ""}</figcaption><div class="notebook-map__body">${frame}${state && mapStateMessage(state, locale) ? `<p class="notebook-map__notice" role="status">${escape(mapStateMessage(state, locale))}${state.canAdmin ? ` <a href="/admin/settings?tab=places">${escape(state.availability?.configured ? t.changeLimit : t.configure)}</a>` : ""}</p>` : ""}${document.pins.length ? `<ol class="notebook-map__pins" aria-label="${escape(t.pins)}">${list}</ol>` : !routeOnly ? `<div class="notebook-map__empty"><strong>${escape(t.empty)}</strong><p>${escape(t.emptyDetail)}</p></div>` : ""}${document.route && (!routeOnly || options.print || blocked) ? `<p class="notebook-map__route-summary">${escape(routeSummary(document, locale))}</p>` : ""}${!options.print && !blocked ? `<div class="notebook-map__print-fallback"><p>${escape(t.printFailed)}</p>${document.route ? `<p>${escape(routeSummary(document, locale))}</p>` : ""}<p>${escape(document.route ? t.routeSource : t.source)}</p></div>` : ""}${options.print || blocked ? `<p class="notebook-map__source">${options.image ? imageSource : document.route ? t.routeSource.replace("Geoapify · OpenStreetMap", '<a href="https://www.geoapify.com/">Geoapify</a> · <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>') : t.source.replace("Geoapify · OpenStreetMap", '<a href="https://www.geoapify.com/">Geoapify</a> · <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>')}</p>` : ""}</div></figure>`;
}
