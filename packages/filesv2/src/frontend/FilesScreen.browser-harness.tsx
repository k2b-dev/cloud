import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { browserMessages } from "./browser-messages";
import { defaultView } from "./browser-preferences";
import FilesScreen from "./FilesScreen.island";
import {
  FIXTURE_NOW,
  FIXTURE_TIME_ZONE,
  type FixtureCase,
  fixtureActivity,
  fixtureBase,
  fixtureDirectory,
  fixtureFavorites,
  fixtureListing,
  fixtureMarkdown,
  fixtureMine,
  fixturePage,
  fixtureRecent,
  fixtureSearch,
  fixtureShares,
  fixtureSnapshot,
  fixtureStorages,
  fixtureTrash,
  fixtureWorstFavorites,
  fixtureWorstTrash,
} from "./files-screen.fixture";
import { browseOf, folderQueries, readFolderAddress, searchOf } from "./folder-query";
import { parseActivityFilters, screenViewOf } from "./urls";

/**
 * The v2 folder screen for a browser test, rendered as the server renders it for the page's address: the address is
 * read with the same list queries and the invented folders answer like the storage. The test answers the API alike.
 */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const requested = document.documentElement.dataset.fixture;
const fixture: FixtureCase = requested === "worst" || requested === "huge" || requested === "empty" ? requested : "plain";
const params = new URLSearchParams(location.search);
const queries = folderQueries(browserMessages.resolve(["de"]).t);
const address = readFolderAddress(queries, params, defaultView);
const path = params.get("path") ?? "";
const search = searchOf(address, params);
const listing = search
  ? fixtureSearch(fixture, path, search.q)
  : fixtureListing(fixture, path, browseOf(address.mode === "folder" ? address.state : queries.folder.reset()));
const page = fixturePage(listing, params.get("after"), Number(params.get("pages") ?? 1));
const directory = fixtureDirectory(path, page.items, search?.q, page.next);
const file = params.get("file");
const snapshot = fixtureSnapshot(`${location.pathname}${location.search}`, directory);
const detail = file ? directory.items.find((item) => item.path === file) : undefined;
if (detail) snapshot.detail = { base: snapshot.directory!.base, entry: detail, favorite: false };
// Every other view reads its own first page instead of a folder, as the server does.
const view = screenViewOf(params, snapshot.bases.items.length);
if (view !== "folder") {
  snapshot.directory = null;
  snapshot.detail = undefined;
  if (view === "overview" || view === "shares") snapshot.selectedId = null;
}
// the first data as the server sends it, of the same fixture case the test's API answers with
if (view === "trash") snapshot.trash = fixture === "worst" ? fixtureWorstTrash : fixtureTrash;
if (view === "favorites") snapshot.marks = fixture === "worst" ? fixtureWorstFavorites : fixtureFavorites;
if (view === "shares") snapshot.shares = fixtureShares(fixture);
if (view === "overview") {
  snapshot.bases = { ...snapshot.bases, items: fixtureStorages(fixture) };
  if (fixture === "worst") snapshot.bases.issues = [{ area: "freeipa", code: "unavailable" }];
  snapshot.favoritesPreview = fixture === "empty" ? { items: [], more: false } : { items: fixtureFavorites, more: false };
  snapshot.recentByYou =
    fixture === "empty"
      ? { page: fixtureActivity("empty"), opened: [] }
      : fixture === "worst"
        ? { page: { ...fixtureActivity("worst"), items: fixtureActivity("worst").items.slice(0, 5) }, opened: [] }
        : fixtureRecent();
}
if (view === "activity") {
  const filters = parseActivityFilters(params) ?? {};
  // "Me" shows this person's own changes, as the reader answers it
  snapshot.activity = { filters, page: filters.actor === "me" && fixture === "plain" ? fixtureMine() : fixtureActivity(fixture) };
  snapshot.marks = filters.actor === "me" ? [] : undefined;
}
if (view === "edit") snapshot.editor = fixtureMarkdown(location.origin, fixture);
// An old folder address: the server found where its folder went.
if (view === "folder" && path === "Alte Angebote") {
  snapshot.directory = null;
  // Felix moved the folder into the archive of 2025 this morning: old place, sentence and endpoint agree.
  const before = fixtureActivity("plain").items[3]!;
  const folder = (place: string) => ({
    visibility: "full" as const,
    source: "current" as const,
    name: "Alte Angebote",
    path: `werkstatt/${place}`,
    root: "groups",
    baseId: "20000000-0000-4000-8000-000000000001",
    publicBaseId: fixtureBase.id,
    relativePath: place,
    itemId: null,
    directory: true,
    size: null,
    revision: null,
  });
  const moved = { ...before, action: "item.move" as const, before: folder("Alte Angebote"), after: folder("Archiv/2025/Alte Angebote") };
  snapshot.moved = {
    baseId: fixtureBase.id,
    path,
    entry: { ...moved, time: FIXTURE_NOW },
    chain: {
      sourceId: moved.id,
      hops: [],
      endpoint: { baseId: fixtureBase.id, path: "Archiv/2025/Alte Angebote", itemId: null },
      certainty: "verified",
      historyComplete: false,
      truncated: false,
    },
    contents: {
      items: fixtureListing("plain", "Archiv/2025/Alte Angebote", { sort: "name", order: "asc", type: "all", groupFolders: true }),
      next: null,
    },
  };
}

render(
  () => (
    <LocaleProvider locale="de">
      <FilesScreen initial={snapshot} timeZone={FIXTURE_TIME_ZONE} />
    </LocaleProvider>
  ),
  host,
);
