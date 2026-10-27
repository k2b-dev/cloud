import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { createEffect, createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { BaseSummary } from "../contracts";
import Browser from "./Browser";
import { createFilesUploads } from "./files-uploads";
import { SEARCH_KINDS, searchState } from "./search-state";
import type { DirectoryView } from "./workspace-state";

// Fictional search states of one group storage; the state follows the location hash.
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const base: BaseSummary = {
  id: "cloud:groups:nordlicht",
  locationKey: "nordlicht",
  area: "cloud",
  kind: "groups",
  name: "Team Nordlicht",
  status: "existing",
  reason: null,
  indexEnabled: true,
  versioningEnabled: false,
};
const hits: [string, number][] = [
  ["Rechnungen", 0],
  ["Rechnungen/2026/Rechnung-2026-031.pdf", 284_113],
  ["Kunden/Bäckerei Sonnenschein/Rechnung Oktober.pdf", 91_402],
  ["Buchhaltung/Rechnungseingang.xlsx", 48_220],
  ["Vorlagen/Rechnungsvorlage.odt", 22_871],
  ["Projekte/Website-Relaunch/Angebot und Rechnung.docx", 35_090],
  ["Archiv/2024/Alte Rechnung Druckerei.pdf", 1_204_551],
];
/** Code-point ranges of `query` in each relative path, as Files returns them. */
const ranges = (path: string, query: string): [number, number][] => {
  const points = Array.from(path.toLocaleLowerCase());
  const needle = Array.from(query.toLocaleLowerCase());
  const found: [number, number][] = [];
  for (let index = 0; index + needle.length <= points.length; index++)
    if (needle.every((point, offset) => points[index + offset] === point)) found.push([index, index + needle.length]);
  return found;
};
/** The hash names the state and, after "?", the search's address fields: "#empty?kind=pdf". It changes without a reload. */
const address = (hash: string) => {
  const [state = "", query = ""] = hash.slice(1).split("?");
  const filters = new URLSearchParams(query);
  filters.set("base", base.id);
  if (!filters.has("q")) filters.set("q", "rechnung");
  return { state: state || "results", filters, search: searchState(filters) };
};
const result = ({ state, search }: ReturnType<typeof address>): DirectoryView => {
  const query = search?.q ?? "";
  const extensions: readonly string[] = search?.kind ? SEARCH_KINDS[search.kind] : [];
  const items =
    state === "empty"
      ? []
      : hits.filter(([path, size]) => !extensions.length || (size > 0 && extensions.includes(path.split(".").at(-1)!.toLowerCase())));
  return {
    base,
    path: "",
    query,
    scope: "tree",
    items: items.map(([path, size], index) => ({
      name: path.split("/").at(-1)!,
      path,
      directory: size === 0,
      size,
      modified: new Date(Date.UTC(2026, 9, 24 - index * 3, 9, 30)).toISOString(),
      actions: { write: true, move: true, share: true },
      highlight: ranges(path, query),
    })),
    next: null,
    total: state === "unknown" ? null : items.length,
    ...(state === "limited" ? { items: [], total: null, failure: "search_limited" } : {}),
    ...(state === "error" ? { items: [], total: null, failure: "unavailable" } : {}),
  };
};
const [current, setCurrent] = createSignal(address(location.hash));
window.addEventListener("hashchange", () => setCurrent(address(location.hash)));
render(() => {
  const uploads = createFilesUploads();
  // A loading search keeps the previous results underneath, as the workspace does while it navigates.
  const [shown, setShown] = createSignal(result(current()));
  createEffect(() => {
    if (current().state !== "loading") setShown(result(current()));
  });
  return (
    <LocaleProvider locale={document.documentElement.lang || "en"}>
      <AppWorkspace mobileSurface="flush">
        <AppWorkspace.Content>
          <Browser
            directory={shown()}
            bases={[base]}
            cloudUrl="https://cloud.example"
            source={`/app/filesv2?${current().filters}`}
            pending={current().state === "loading"}
            pendingSearch={current().state === "loading"}
            uploads={uploads}
            onSearch={(next) => host.setAttribute("data-search", JSON.stringify(next))}
            onRetry={() => host.setAttribute("data-retried", "true")}
            onNavigate={async (event) => host.setAttribute("data-navigated", `${event.url.pathname}${event.url.search}`)}
          />
        </AppWorkspace.Content>
      </AppWorkspace>
    </LocaleProvider>
  );
}, host);
