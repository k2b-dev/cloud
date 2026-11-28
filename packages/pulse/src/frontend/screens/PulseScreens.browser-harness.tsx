import { LocaleProvider } from "@k2b/ui";
import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import AdminScreen, { ADMIN_VIEWS } from "../admin/AdminScreen";
import { fixtureAdminBases, fixtureAdminNav, fixturePolicy, fixtureTargets } from "../admin/admin-fixtures";
import { PULSE_SETTINGS_TABS, readWorkspacePathState } from "../workspace/routes";
import { sqlTestLimits } from "../workspace/sql-test-fixtures";
import DeletingScreen from "./DeletingScreen";
import {
  fixtureAccess,
  fixtureAuthors,
  fixtureBases,
  fixtureDeletingBases,
  fixtureNav,
  fixtureQueries,
  fixtureSources,
  manyBases,
  manySources,
  sourcesProps,
  worstBases,
  worstDeletingBases,
  worstSources,
} from "./fixtures";
import QueriesScreen from "./QueriesScreen";
import SettingsScreen from "./SettingsScreen";
import SourcesScreen from "./SourcesScreen";
import SqlScreen from "./SqlScreen";
import StartScreen from "./StartScreen";

/**
 * Every Pulse page for the browser tests, rendered from the address as the server would: `data-variant` on the
 * document picks the data (`normal`, `worst` for break-ui, `huge` for the scale check, `deleting` for a start with
 * bases in deletion). The test answers the APIs.
 */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const variant = document.documentElement.dataset.variant ?? "normal";
// the sidebar as the server sends it: the first bases of the variant, and the bases in deletion for their admin
const nav =
  variant === "huge"
    ? fixtureNav(manyBases(1000))
    : variant === "worst"
      ? fixtureNav([...worstBases, ...fixtureBases], [...worstDeletingBases, ...fixtureDeletingBases])
      : fixtureNav();
const sources =
  variant === "huge"
    ? manySources(1000)
    : variant === "worst"
      ? [...worstSources, ...fixtureSources]
      : variant === "empty"
        ? []
        : fixtureSources;
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
  // `/app/pulse` stands only before the first base; the server opens a base otherwise
  if (path === "/app/pulse") return <StartScreen deleting={variant === "normal" ? [] : nav.deleting} />;
  const [, , , id, view, item] = path.split("/");
  const deleting = nav.deleting.find((base) => base.id === id);
  if (deleting) return <DeletingScreen nav={nav} base={deleting} />;
  const frame = {
    nav,
    baseId,
    baseName: fixtureBases.find((base) => base.id === baseId)?.name ?? "",
    sourceCount: sources.length,
  };
  if (view === "sql") {
    const route = readWorkspacePathState(`${path}${location.search}`, baseId);
    const query = item ? (fixtureQueries.find((entry) => entry.id === item) ?? null) : null;
    if (query) route.sql = undefined;
    return <SqlScreen {...frame} route={route} snapshot={{ limits: sqlTestLimits, query, error: null }} canWrite />;
  }
  if (view === "queries")
    return (
      <QueriesScreen
        {...frame}
        page={{ items: fixtureQueries, total: fixtureQueries.length, nextOffset: null }}
        offset={0}
        authors={fixtureAuthors}
        dateConfig={{ timeZone: "Europe/Berlin", locale: "de" }}
      />
    );
  if (view === "settings") {
    const tab = PULSE_SETTINGS_TABS.find((entry) => entry === item) ?? "general";
    return (
      <SettingsScreen
        nav={nav}
        base={fixtureBases[0]!}
        tab={tab}
        canAdmin={variant !== "member"}
        admins={["Jana Petersen"]}
        maxRawRetentionDays={365}
        access={fixtureAccess}
        limits={sqlTestLimits}
      />
    );
  }
  return (
    <SourcesScreen
      {...sourcesProps({ open: view === "sources" ? (item ?? "") : "", sources })}
      initialNav={nav}
      initialSearch={params.get("q") ?? ""}
    />
  );
};

render(() => <LocaleProvider locale="de">{screen()}</LocaleProvider>, host);
// When the page stood: milliseconds from the start of navigation, measured in the page.
document.body.dataset.readyAt = String(Math.round(performance.now()));
document.body.dataset.ready = "true";
