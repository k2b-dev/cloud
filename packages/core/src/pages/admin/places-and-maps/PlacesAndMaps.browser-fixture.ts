/** Synthetic admin and geo data; real AdminLayout, page island and styles. No live services, no provider call. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type CloudRuntime,
  type GeoAdminStatus,
  type GeoAdminUsage,
  GeoBudgetInputSchema,
  GeoKeyInputSchema,
  type User,
  validateGeoBudget,
} from "@k2b/cloud/contracts";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { Dynamic, renderToString } from "solid-js/web";
import type { PlacesAndMapsInitial } from "./PlacesAndMaps.island";

const lea = { id: "11111111-1111-4111-8111-111111111111", name: "Lea Schulz" };
const user: User = {
  id: lea.id,
  uid: "lea.schulz",
  roles: ["admin", "user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Lea",
  sn: "Schulz",
  displayName: "Lea Schulz",
  mail: "lea.schulz@example.test",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};
const plans = {
  free: { dailyCredits: 3000, rps: 5 },
  api10: { dailyCredits: 10000, rps: 12 },
  api25: { dailyCredits: 25000, rps: 15 },
  api50: { dailyCredits: 50000, rps: 20 },
  api100: { dailyCredits: 100000, rps: 25 },
  api250: { dailyCredits: 250000, rps: 30 },
};
const setStatus = (): GeoAdminStatus => ({
  key: { state: "set", setAt: "2026-10-19T09:12:00.000Z", setBy: lea },
  budget: {
    plan: "free",
    customRps: 5,
    customDailyCredits: 3000,
    monthlyCredits: 90000,
    personDailyCredits: 300,
    unreadable: [],
    changedAt: "2026-10-19T09:14:00.000Z",
    changedBy: lea,
  },
  plans,
  timezone: "Europe/Berlin",
});
const usageOf = (month: number, today: number, peopleAtLimit = 0): GeoAdminUsage => ({
  month: { period: "2026-10", used: month, limit: 90000, resetsAt: "2026-10-31T23:00:00.000Z" },
  today: { period: "2026-10-20", used: today, allowance: 3000, resetsAt: "2026-10-20T22:00:00.000Z" },
  // 46 %, 22 %, 18 % and 14 % of the month, as in the approved mockup.
  shares: [
    { group: "tiles", credits: Math.round(month * 0.46) },
    { group: "places", credits: Math.round(month * 0.22) },
    { group: "route", credits: Math.round(month * 0.18) },
    { group: "address", credits: month - Math.round(month * 0.46) - Math.round(month * 0.22) - Math.round(month * 0.18) },
  ],
  peopleAtLimit,
  timezone: "Europe/Berlin",
});

/** Named starting points; transient states (replace, remove, refused, saved, invalid, loading) are reached by interaction. */
export const PLACES_AND_MAPS_SCENARIOS = {
  eingerichtet: () => ({ status: setStatus(), usage: usageOf(41230, 2140) }),
  aus: () => {
    const status = setStatus();
    status.key = { state: "none", setAt: null, setBy: null };
    status.budget.changedAt = null;
    status.budget.changedBy = null;
    return { status, usage: usageOf(0, 0) };
  },
  leer: () => ({ status: setStatus(), usage: usageOf(0, 0) }),
  "budget-cloud": () => ({ status: setStatus(), usage: usageOf(90000, 0) }),
  "budget-person": () => ({ status: setStatus(), usage: usageOf(41230, 2960, 3) }),
  "verbrauch-fehler": () => ({ status: setStatus(), usage: null }),
  "nicht-geladen": () => ({ status: null, usage: null }),
} satisfies Record<string, () => { status: GeoAdminStatus | null; usage: GeoAdminUsage | null }>;
export type PlacesAndMapsScenario = keyof typeof PLACES_AND_MAPS_SCENARIOS;

export async function placesAndMapsBrowserFixture() {
  const root = mkdtempSync(join(tmpdir(), "core-places-maps-host-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
  const { AdminLayout } = await import("@k2b/cloud/ssr");
  const { default: PlacesAndMaps } = await import("./PlacesAndMaps.island.tsx");
  const { placesAndMapsMessages } = await import("./messages");
  const ui = resolve(import.meta.dir, "../../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", `${ui}/`));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", `${ui}/`))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", `${ui}/`))).default;
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "PlacesAndMaps.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-places-maps-fixture",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const transformed = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: transformed.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not compile the places and maps page");
  const script = await bundle.outputs[0]!.text();
  const styles = await Promise.all(
    [resolve(import.meta.dir, "../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../styles.css")].map((entry) =>
      Bun.build({ entrypoints: [entry], plugins: [tailwind] }),
    ),
  );
  for (const build of styles) if (!build.success) throw new AggregateError(build.logs, "Could not compile page styles");
  const css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(styles.map((build) => build.outputs[0]!.text()))),
  ].join("\n");
  const publicDir = join(root, "public");
  await (await import("../../../../scripts/font-assets")).buildFontAssets(publicDir);
  await (await import("../../../../scripts/tabler-assets")).buildTablerIconAssets(publicDir);

  // The synthetic Core: one state per fixture, reset with each page load.
  let state: { status: GeoAdminStatus | null; usage: GeoAdminUsage | null } = PLACES_AND_MAPS_SCENARIOS.eingerichtet();
  /** Requests the test holds back to show loading and waiting states. */
  const gates = new Map<string, Promise<void>>();
  const control = {
    hold(path: string) {
      let release = () => {};
      gates.set(path, new Promise<void>((done) => (release = done)));
      return () => {
        gates.delete(path);
        release();
      };
    },
    failUsage: false,
    failStatus: false,
    dropNextAnswer: false,
    requests: [] as Array<{ method: string; path: string; body: string }>,
  };
  const status = () => state.status ?? PLACES_AND_MAPS_SCENARIOS.eingerichtet().status;

  const api = new Hono()
    .use(async (c, next) => {
      control.requests.push({ method: c.req.method, path: c.req.path, body: c.req.method === "GET" ? "" : await c.req.raw.clone().text() });
      await gates.get(c.req.path);
      await next();
    })
    .get("/api/admin/core/geo", (c) => (control.failStatus ? c.json({ message: "Synthetic outage" }, 503) : c.json(status())))
    .get("/api/admin/core/geo/usage", (c) =>
      // A scenario without initial usage still answers a retry: the page read failed, not the ledger.
      control.failUsage ? c.json({ message: "Synthetic outage" }, 503) : c.json(state.usage ?? usageOf(41230, 2140)),
    )
    .put("/api/admin/core/geo/key", async (c) => {
      const { apiKey } = GeoKeyInputSchema.parse(await c.req.json());
      const key = apiKey.trim();
      if (key.startsWith("bad-")) return c.json({ code: "geo_key_rejected" }, 422);
      if (key.startsWith("down-")) return c.json({ code: "geo_key_unverified" }, 502);
      const next = status();
      next.key = { state: "set", setAt: new Date().toISOString(), setBy: lea };
      state = { ...state, status: next, usage: state.usage ?? PLACES_AND_MAPS_SCENARIOS.leer().usage };
      if (control.dropNextAnswer) {
        control.dropNextAnswer = false;
        return c.json({ message: "Synthetic lost answer" }, 504);
      }
      return c.json(next);
    })
    .delete("/api/admin/core/geo/key", (c) => {
      const next = status();
      next.key = { state: "none", setAt: null, setBy: null };
      state = { ...state, status: next };
      return c.json(next);
    })
    .put("/api/admin/core/geo/budget", async (c) => {
      const input = GeoBudgetInputSchema.parse(await c.req.json());
      const errors = validateGeoBudget(input);
      if (Object.keys(errors).length) return c.json({ code: "geo_budget_invalid", errors }, 400);
      const next = status();
      next.budget = {
        ...next.budget,
        plan: input.plan,
        monthlyCredits: Number(input.monthlyCredits),
        personDailyCredits: Number(input.personDailyCredits),
        ...(input.plan === "custom" ? { customRps: Number(input.customRps), customDailyCredits: Number(input.customDailyCredits) } : {}),
        changedAt: new Date().toISOString(),
        changedBy: lea,
      };
      state = { ...state, status: next };
      return c.json(next);
    })
    .all("/api/*", (c) => c.json({ message: "Synthetic fixture: unknown route" }, 404));

  const pages = new Hono<{
    Variables: {
      runtime: CloudRuntime;
      user: User;
      settings: Record<string, unknown>;
      actor: undefined;
      panelConsent: undefined;
      railPreferences: undefined;
      announcements: undefined;
      page: { title?: string; theme: "light" | "dark" };
    };
  }>();
  pages.get("/admin/places-and-maps", (c) => {
    const locale = c.req.query("locale") === "en" ? "en" : "de";
    const theme = c.req.query("theme") === "dark" ? "dark" : "light";
    const scenario = Object.entries(PLACES_AND_MAPS_SCENARIOS).find(([name]) => name === c.req.query("state"));
    state = (scenario?.[1] ?? PLACES_AND_MAPS_SCENARIOS.eingerichtet)();
    c.req.raw.headers.set("x-cloud-locale", locale);
    c.set("runtime", { apps: [{ id: "core", name: "Core", description: "Platform", icon: "ti ti-cloud", routes: ["/admin", "/"] }] });
    c.set("user", user);
    c.set("settings", { app: { name: "Cloud", locale } });
    const title = placesAndMapsMessages.resolve([locale]).t.title;
    c.set("page", { title, theme });
    const initial: PlacesAndMapsInitial = { status: state.status, usage: state.usage, actorId: user.id };
    const body = renderToString(() =>
      createComponent(AdminLayout, {
        c,
        title,
        get children() {
          return createComponent(Dynamic, {
            component: "div",
            class: "flex min-h-0 flex-1 flex-col",
            id: "places-and-maps-fixture",
            get children() {
              return createComponent(PlacesAndMaps, { initial });
            },
          });
        },
      }),
    );
    return c.html(
      `<!doctype html><html lang="${locale}" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css"><style>${css}</style></head><body class="k2b-ui${theme === "dark" ? " k2b-dark" : ""}">${body}<script type="application/json" id="places-and-maps-fixture-data">${JSON.stringify(initial)}</script><script src="/fixture.js"></script></body></html>`,
    );
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
      if (url.pathname.startsWith("/public/")) {
        const path = resolve(root, `.${url.pathname}`);
        return path.startsWith(`${publicDir}/`) ? new Response(Bun.file(path)) : new Response(null, { status: 404 });
      }
      if (url.pathname.startsWith("/api/")) return api.fetch(request);
      return pages.fetch(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/admin/places-and-maps`,
    control,
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
