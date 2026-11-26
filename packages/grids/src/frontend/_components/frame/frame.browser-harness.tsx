import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import DocumentsScreen from "../documents/DocumentsScreen";
import DocumentTemplateScreen from "../documents/DocumentTemplateScreen";
import BasesOverview from "../overview/BasesOverview";
import { basesQuery, parseBasesAddress } from "../overview/bases-query";
import QueryScreen from "../query/QueryScreen";
import QueryViewScreen from "../query/QueryViewScreen";
import RecordsView from "../records-view/RecordsView";
import BaseHome from "./BaseHome";
import {
  baseHomeFixture,
  basesFixture,
  documentsFixture,
  type FixtureVariant,
  queryFixture,
  queryViewFixture,
  recordsFixture,
  templateFixture,
} from "./frame.browser-fixture";
import { homeTab, resourcesQuery } from "./resources-query";

/**
 * The bases overview and a base home for a browser test, rendered as the server renders them for the page's
 * address: the address is parsed with the same declarations, the data comes from the invented fixtures.
 */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const variant = (document.documentElement.dataset.variant ?? "plain") as FixtureVariant;
const params = new URLSearchParams(location.search);

render(
  () => (
    <LocaleProvider locale="de">
      {location.pathname.includes("/document/") ? (
        <DocumentTemplateScreen {...templateFixture(variant, params)} />
      ) : location.pathname.endsWith("/query") ? (
        <QueryScreen {...queryFixture(variant, params)} />
      ) : location.pathname.endsWith("/view/V9") ? (
        <QueryViewScreen {...queryViewFixture(variant)} />
      ) : location.pathname.endsWith("/documents") ? (
        <DocumentsScreen {...documentsFixture(variant, params)} />
      ) : location.pathname.includes("/table/") ? (
        <RecordsView {...recordsFixture(variant, params)} />
      ) : location.pathname === "/app/grids" ? (
        <BasesOverview state={parseBasesAddress(basesQuery("de"), params).state} {...basesFixture(variant, params)} />
      ) : (
        (() => {
          const state = baseHomeFixture(variant, { edit: params.get("edit") === "true", groups: params.has("groups") });
          return (
            <BaseHome
              state={state}
              query={resourcesQuery("de").parse(params).state}
              tab={homeTab(params, (state.navigation?.groups.length ?? 0) > 0)}
            />
          );
        })()
      )}
    </LocaleProvider>
  ),
  host,
);
