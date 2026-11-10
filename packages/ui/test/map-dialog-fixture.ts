import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";

/**
 * A page with one MapTile and its MapDialog on fictional data, served from a temporary build of the shipped browser
 * bundle and stylesheet. The map image is painted from GeoJSON in the map palette, so nothing leaves the machine.
 * `mountScene(name, options)` renders a scene: `route`, `places`, `single`, or `empty`.
 */
const ui = resolve(import.meta.dir, "..");
const entry = resolve(import.meta.dir, "map-dialog.fixture.ts");
const fixture = `
import { createComponent, createSignal, mergeProps } from "solid-js";
import { render } from "solid-js/web";
import { ButtonLink, MapDialog, MapTile, MapView, mapPalette } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const box = (kind, w, s, e, n) => ({ type: "Feature", properties: { kind }, geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } });
const road = (kind, coordinates) => ({ type: "Feature", properties: { kind }, geometry: { type: "LineString", coordinates } });
const style = (dark) => {
  const c = mapPalette[dark ? "dark" : "light"];
  const line = (kind, color, width) => ({ id: kind + color, type: "line", source: "f", filter: ["==", ["get", "kind"], kind], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": color, "line-width": width } });
  return {
    version: 8,
    sources: { f: { type: "geojson", data: { type: "FeatureCollection", features: [
      box("green", 10.90, 49.05, 10.99, 49.09), box("green", 11.05, 48.95, 11.16, 48.98), box("green", 11.12, 49.02, 11.2, 49.06),
      box("water", 10.97, 49.06, 11.01, 49.075),
      box("building", 10.945, 48.996, 10.958, 49.004), box("building", 11.014, 49.026, 11.027, 49.034), box("building", 11.074, 48.985, 11.087, 48.994), box("building", 11.114, 49.046, 11.128, 49.055),
      road("major", [[10.85, 49.02], [10.98, 49.035], [11.06, 49.08], [11.25, 49.1]]),
      road("minor", [[10.95, 49.0], [11.0, 49.02], [11.02, 49.03], [11.05, 49.0], [11.08, 48.99], [11.1, 49.02], [11.12, 49.05]]),
      road("minor", [[10.9, 48.97], [11.0, 48.975], [11.1, 48.97], [11.2, 48.99]]),
      road("minor", [[11.02, 49.03], [11.07, 49.04], [11.12, 49.05]]),
    ] } } },
    layers: [
      { id: "land", type: "background", paint: { "background-color": c.land } },
      { id: "green", type: "fill", source: "f", filter: ["==", ["get", "kind"], "green"], paint: { "fill-color": c.green } },
      { id: "water", type: "fill", source: "f", filter: ["==", ["get", "kind"], "water"], paint: { "fill-color": c.water } },
      { id: "building", type: "fill", source: "f", filter: ["==", ["get", "kind"], "building"], paint: { "fill-color": c.building } },
      line("minor", c.roadCasing, 6), line("major", c.motorwayCasing, 8), line("minor", c.road, 4), line("major", c.motorway, 5),
    ],
  };
};
const styles = { light: style(false), dark: style(true) };

const stops = [
  { id: "a", mark: "A", name: "Lager Antik Lindner", point: { lat: 49.0, lon: 10.952 }, subtitle: "Gewerbering 4, 91781 Lindach", trailing: "Start",
    address: "Gewerbering 4, 91781 Lindach", note: "Laden: Biedermeier-Vitrine, 2 Stühle, Sekretär.", source: { icon: "ti ti-box", label: "Warenfluss · Lager" } },
  { id: "b", mark: "B", name: "Familie Brandl", point: { lat: 49.03, lon: 11.02 }, subtitle: "Am Mühlbach 12, 91795 Oberried", trailing: "24 min", trailingDetail: "21,3 km",
    address: "Am Mühlbach 12, 91795 Oberried", note: "Biedermeier-Vitrine, zweiteilig. Hintereingang nutzen, 30 Minuten vorher anrufen.",
    source: { icon: "ti ti-user", label: "Kontakt · Kunden" }, links: [{ label: "Kontakt öffnen", href: "/app/contacts/brandl", icon: "ti ti-user" }, { label: "Bad", href: "javascript:alert(1)" }] },
  { id: "c", mark: "C", name: "Restaurierung Sedlmayr", point: { lat: 48.99, lon: 11.08 }, subtitle: "Werkstattgasse 3, 91788 Kirchzell", trailing: "36 min", trailingDetail: "34,8 km",
    address: "Werkstattgasse 3, 91788 Kirchzell", note: "2 Stühle zum Neubezug abgeben. Werkstatt schließt um 16:00.", source: { icon: "ti ti-user", label: "Kontakt · Partner" },
    links: [{ label: "Kontakt öffnen", href: "/app/contacts/sedlmayr", icon: "ti ti-user" }] },
  { id: "d", mark: "D", name: "Dr. Helene Voss", point: { lat: 49.05, lon: 11.12 }, subtitle: "Schlossallee 7, 91790 Sandberg", trailing: "32 min", trailingDetail: "30,3 km",
    address: "Schlossallee 7, 91790 Sandberg", note: "Sekretär, 1. Stock ohne Aufzug. Zwei Personen einplanen.", source: { icon: "ti ti-file-text", label: "Auftrag 2026-1184" },
    links: [{ label: "Auftrag öffnen", href: "https://orders.example/2026-1184", icon: "ti ti-file-text" }] },
];
const names = ["Polsterei Hartl", "Holzwerkstatt Reiter", "Möbelrestaurierung Aigner", "Vergolderei Thoma", "Restaurierung Sedlmayr", "Atelier Blattgold",
  "Schreinerei Kugler", "Uhrenwerkstatt Pfeiffer", "Sattlerei Obermaier", "Korbflechterei Wimmer", "Glaserei Stadler", "Steinmetz Lechner"];
const places = names.map((name, i) => ({
  id: "p" + (i + 1), mark: i + 1, name, tone: "second",
  point: { lat: 48.97 + ((i * 37) % 11) * 0.009, lon: 10.94 + ((i * 53) % 13) * 0.016 },
  subtitle: "Restaurierung · " + (i % 3 ? "jetzt geöffnet" : "Öffnungszeiten unbekannt"), trailing: (1.2 + i * 2.7).toFixed(1).replace(".", ",") + " km",
  address: "Bahnhofstraße " + (i + 3) + ", 9178" + (i % 10) + " Lindach", hours: i % 3 ? "Mo–Fr 8:00–17:00 · jetzt geöffnet" : "Öffnungszeiten unbekannt",
  note: i === 0 ? "Polstert Biedermeier-Stühle neu, holt im Umkreis von 20 km selbst ab." : undefined,
  source: { label: "Von Gustav gefunden · Geoapify, OpenStreetMap", tone: "ai" },
}));
const scenes = {
  route: { title: "Auslieferung Donnerstag", summary: "86,4 km · 1 h 32 min · A → B → C → D", label: "Karte öffnen: Auslieferung Donnerstag, 86,4 km, 4 Stopps",
    facts: [{ value: "86,4 km", label: "Entfernung" }, { value: "1 h 32 min", label: "Fahrzeit" }], listLabel: "Stopps", places: stops,
    lines: [{ id: "route", points: [stops[0].point, { lat: 49.02, lon: 11.0 }, stops[1].point, { lat: 49.0, lon: 11.05 }, stops[2].point, { lat: 49.02, lon: 11.1 }, stops[3].point] }],
    menu: ["Stopp einfügen", "Reihenfolge optimieren", "Optionen"], provenance: "Route: Geoapify · OpenStreetMap · Zeiten ohne Verkehr, berechnet 14:05" },
  places: { title: "Restauratoren im Umkreis", summary: "12 Orte", label: "Karte öffnen: Restauratoren im Umkreis, 12 Orte", count: "12 Orte",
    group: "Restauratoren und Polsterer", places, provenance: "Geoapify · OpenStreetMap" },
  single: { title: "Dr. Helene Voss", summary: "Schlossallee 7, 91790 Sandberg", label: "Karte öffnen: Dr. Helene Voss, Schlossallee 7, 91790 Sandberg",
    count: "Privatadresse", places: [{ id: "k1", name: "Dr. Helene Voss", point: stops[3].point, address: "Schlossallee 7, 91790 Sandberg" }], provenance: "Geoapify · OpenStreetMap" },
  empty: { title: "Herbstmärkte 2026", summary: "Keine Orte", label: "Karte öffnen: Herbstmärkte 2026, keine Orte", count: "0 Orte", places: [] },
};

window.events = [];
let dispose;
window.mountScene = (name, options = {}) => {
  dispose?.();
  const scene = scenes[name];
  const [loading, setLoading] = createSignal(!!options.loading);
  window.finishLoading = () => setLoading(false);
  const markers = () => scene.places.map((p) => ({ id: p.id, point: p.point, label: p.name, mark: p.mark, tone: p.tone }));
  const host = document.getElementById("root");
  dispose = render(() => [
    (() => { const p = document.createElement("p"); p.textContent = "Vorher"; return p; })(),
    createComponent(MapTile, {
      label: scene.label,
      get summary() { return loading() ? "Orte werden geladen …" : scene.summary; },
      get loading() { return loading(); },
      restoreId: options.restoreId,
      dialog: (close) => createComponent(MapDialog, {
        title: scene.title, facts: scene.facts, count: scene.count, listLabel: scene.listLabel, group: scene.group,
        get places() { return loading() ? [] : scene.places; }, lines: scene.lines, provenance: scene.provenance,
        get loading() { return loading(); },
        menu: scene.menu?.map((label) => ({ label, onSelect: () => window.events.push(label) })),
        placeActions: name === "places" ? (place) => createComponent(ButtonLink, { href: "#route-" + place.id, variant: "secondary", size: "sm", children: "Route hierher" }) : undefined,
        map: (view) => createComponent(MapView, mergeProps(view, { style: styles, attribution: "© OpenStreetMap · Geoapify" })),
        onClose: close,
      }),
      get children() {
        return createComponent(MapView, { still: true, height: options.height ?? 240, style: styles, attribution: "© OpenStreetMap · Geoapify", get markers() { return markers(); }, lines: scene.lines });
      },
    }),
  ], host);
};
`;

export type MapDialogFixture = { url: string; stop: () => void };

export async function startMapDialogFixture(): Promise<MapDialogFixture> {
  const out = mkdtempSync(resolve(tmpdir(), "k2b-map-dialog-"));
  const build = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: fixture },
    target: "browser",
    format: "esm",
    splitting: true,
    outdir: out,
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle the map dialog fixture.");
  copyFileSync(resolve(ui, "dist/browser/content/map-view-worker.js"), resolve(out, "map-view-worker.js"));
  const script = relative(out, build.outputs.find((output) => output.kind === "entry-point")!.path);
  const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
  const page = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/tabler.css"><style>${css}</style><style>body{margin:0;padding:24px;background:var(--k2b-surface)}#root{max-width:800px;margin:0 auto;display:flex;flex-direction:column;gap:12px}</style></head>
<body class="k2b-ui"><div id="root"></div><script type="module" src="/${script}"></script></body></html>`;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith(".js")) return new Response(Bun.file(resolve(out, `.${path}`)), { headers: { "content-type": "text/javascript" } });
      // The stylesheet's fonts and icons, as the shipped package serves them beside styles.css.
      const asset = Bun.file(resolve(ui, `dist/.${path}`));
      if (path !== "/" && (await asset.exists())) return new Response(asset);
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  return {
    url: `http://localhost:${server.port}/`,
    stop: () => {
      server.stop(true);
      rmSync(out, { recursive: true, force: true });
    },
  };
}
