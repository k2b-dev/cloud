import { LocaleProvider } from "@k2b/ui";
import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import AdminScreen, { ADMIN_VIEWS } from "../admin/AdminScreen";
import { fixtureAdminBases, fixtureAdminNav, fixturePolicy, fixtureTargets } from "../admin/admin-fixtures";
import { PULSE_SETTINGS_TABS, readWorkspacePathState } from "../workspace/routes";
import { sqlTestLimits } from "../workspace/sql-test-fixtures";
import {
  fixtureBases,
  fixtureDeletingBases,
  fixtureQueries,
  fixtureSources,
  manyBases,
  manySources,
  sourcesProps,
  worstBases,
  worstSources,
} from "./fixtures";
import OverviewScreen from "./OverviewScreen";
import QueriesScreen from "./QueriesScreen";
import SettingsScreen from "./SettingsScreen";
import SourcesScreen from "./SourcesScreen";
import SqlScreen from "./SqlScreen";

/**
 * Every Pulse page for the browser tests, rendered from the address as the server would: `data-variant` on the
 * document picks the data (`normal`, `worst` for break-ui, `huge` for the scale check). The test answers the APIs.
 */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const variant = document.documentElement.dataset.variant ?? "normal";
const bases = variant === "huge" ? manyBases(1000) : variant === "worst" ? [...worstBases, ...fixtureBases] : fixtureBases;
const sources = variant === "huge" ? manySources(1000) : variant === "worst" ? [...worstSources, ...fixtureSources] : fixtureSources;
const baseId = fixtureBases[0]!.id;

const screen = (): JSX.Element => {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  if (path === "/admin/pulse") {
    const view = ADMIN_VIEWS.find((entry) => entry === params.get("view")) ?? "store";
    return (
      <AdminScreen
        nav={fixtureAdminNav(view)}
        view={view}
        store={{ configured: true, url: "http://clickhouse:8123", user: "pulse", passwordSet: true }}
        policy={fixturePolicy}
        bases={fixtureAdminBases}
        targets={fixtureTargets}
      />
    );
  }
  if (path === "/app/pulse")
    return <OverviewScreen bases={bases} deletingBases={fixtureDeletingBases} initialQuery={params.get("q") ?? ""} />;
  const [, , , , view, id] = path.split("/");
  const frame = { bases: fixtureBases, baseId, sourceCount: sources.length };
  if (view === "sql") {
    const route = readWorkspacePathState(`${path}${location.search}`, baseId);
    const query = id ? (fixtureQueries.find((entry) => entry.id === id) ?? null) : null;
    if (query) route.sql = undefined;
    return <SqlScreen {...frame} route={route} snapshot={{ limits: sqlTestLimits, query, error: null }} canWrite />;
  }
  if (view === "queries")
    return (
      <QueriesScreen
        {...frame}
        page={{ items: fixtureQueries, total: fixtureQueries.length, nextOffset: null }}
        offset={0}
        dateConfig={{ timeZone: "Europe/Berlin", locale: "de" }}
      />
    );
  if (view === "settings") {
    const tab = PULSE_SETTINGS_TABS.find((entry) => entry === id) ?? "general";
    return (
      <SettingsScreen
        bases={fixtureBases}
        base={fixtureBases[0]!}
        tab={tab}
        canAdmin={variant !== "member"}
        admins={["Jana Petersen"]}
        maxRawRetentionDays={365}
        access={[]}
        limits={sqlTestLimits}
      />
    );
  }
  return <SourcesScreen {...sourcesProps({ open: view === "sources" ? (id ?? "") : "", sources })} initialSearch={params.get("q") ?? ""} />;
};

render(() => <LocaleProvider locale="de">{screen()}</LocaleProvider>, host);
// When the page stood: milliseconds from the start of navigation, measured in the page.
document.body.dataset.readyAt = String(Math.round(performance.now()));
document.body.dataset.ready = "true";
