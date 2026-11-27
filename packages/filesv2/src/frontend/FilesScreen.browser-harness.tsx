import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { browserMessages } from "./browser-messages";
import { defaultView } from "./browser-preferences";
import FilesScreen from "./FilesScreen.island";
import {
  FIXTURE_TIME_ZONE,
  type FixtureCase,
  fixtureDirectory,
  fixtureListing,
  fixturePage,
  fixtureSearch,
  fixtureSnapshot,
} from "./files-screen.fixture";
import { browseOf, folderQueries, readFolderAddress, searchOf } from "./folder-query";

/**
 * The v2 folder screen for a browser test, rendered as the server renders it for the page's address: the address is
 * read with the same list queries and the invented folders answer like the storage. The test answers the API alike.
 */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const requested = document.documentElement.dataset.fixture;
const fixture: FixtureCase = requested === "worst" || requested === "huge" ? requested : "plain";
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

render(
  () => (
    <LocaleProvider locale="de">
      <FilesScreen initial={snapshot} timeZone={FIXTURE_TIME_ZONE} />
    </LocaleProvider>
  ),
  host,
);
