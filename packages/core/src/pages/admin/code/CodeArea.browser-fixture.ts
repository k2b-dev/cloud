/** Synthetic admin authority and fictional Code; the real AdminLayout, Code area view, islands and styles. No live services. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { CODE_SETTINGS } from "../../../code/settings";
import type { SettingFieldDef } from "../settings/_components/setting-field";
import { CODE_LIMIT_KEYS } from "./area";
import {
  FIXTURE_PEOPLE,
  FIXTURE_VERSIONS,
  fixtureApprovalDetail,
  fixtureCodeDetail,
  fixtureData,
  fixtureEffective,
  fixtureRunners,
} from "./CodeArea.fixture-data";
import type { CodeAreaData } from "./view";

/** States the captures and tests switch with `?state=`. */
export const CODE_FIXTURE_STATES = [
  "normal",
  "empty",
  "fail",
  "noperm",
  "first",
  "newer",
  "own",
  "sole",
  "difffail",
  "approved",
  "missing",
  "conflict",
  "savefail",
  "saving",
] as const;
export type CodeFixtureState = (typeof CODE_FIXTURE_STATES)[number];

const user: User = {
  id: FIXTURE_PEOPLE.ben,
  uid: "ben",
  roles: ["admin", "user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Ben",
  sn: "Schulz",
  displayName: "Ben Schulz",
  mail: "ben.schulz@example.test",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};

const limitEntries = (locale: string): SettingFieldDef[] =>
  [...CODE_LIMIT_KEYS].map((key) => {
    const definition = CODE_SETTINGS[key];
    const de = definition.presentation.translations.de;
    return {
      key,
      label: locale === "de" ? de.label : definition.label,
      description: locale === "de" ? de.description : definition.description,
      kind: "number",
      value: definition.default,
      default: definition.default,
      resetValue: definition.default,
      valueSource: "default",
      resetValueSource: "default",
      isCustom: false,
      unreadable: false,
      group: "core",
      min: definition.min,
      max: definition.max,
    };
  });

/** The page data for one fixture state and URL. */
export function codeFixtureData(state: CodeFixtureState, query: Record<string, string | undefined>, locale = "de"): CodeAreaData {
  const data = fixtureData();
  data.limits = limitEntries(locale);
  if (state === "empty")
    return {
      ...data,
      summary: { approvals: 0, codes: 0, groups: 0, cleanup: 0 },
      approvals: [],
      decided: [],
      codes: { items: [], total: 0, owners: 0, nextCursor: null },
      cleanup: [],
      runners: fixtureRunners(true),
      policy: data.policy !== null && data.policy !== "failed" && data.policy !== "missing" ? { ...data.policy, groups: [] } : data.policy,
    };
  if (state === "fail")
    return { ...data, approvals: "failed", decided: "failed", codes: "failed", policy: "failed", cleanup: "failed", runners: "failed", limits: "failed" };
  if (query.sec === "approvals" && query.id) {
    const variant = query.id === FIXTURE_VERSIONS.lieferzeit1 ? "first" : state;
    data.approval =
      state === "missing"
        ? "missing"
        : fixtureApprovalDetail(
            variant === "first" || variant === "newer" || variant === "own" || variant === "sole" || variant === "difffail" || variant === "approved"
              ? variant
              : "normal",
          );
  }
  if (query.sec === "code" && query.id) data.code = state === "missing" ? "missing" : fixtureCodeDetail();
  if (query.sec === "code" && query.status) {
    const codes = data.codes;
    if (codes !== null && codes !== "failed" && codes !== "missing")
      data.codes = { ...codes, items: codes.items.filter((code) => code.status === query.status), total: codes.items.filter((code) => code.status === query.status).length };
  }
  if (query.sec === "effective" && query.id) data.effective = state === "missing" ? "missing" : fixtureEffective();
  return data;
}

export async function codeAreaBrowserFixture(options: { port?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "core-code-area-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
  const { AdminLayout } = await import("@k2b/cloud/ssr");
  const { CodeAreaView } = await import("./view");
  const { codeAdminMessages } = await import("./messages");
  const { parseCodeAreaQuery } = await import("./area");
  const ui = resolve(import.meta.dir, "../../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", `${ui}/`));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", `${ui}/`))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", `${ui}/`))).default;
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "CodeArea.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-code-area-fixture",
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
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not compile the Code area islands");
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
  pages.get("/admin/code", (c) => {
    const locale = c.req.query("locale") === "en" ? "en" : "de";
    const theme = c.req.query("theme") === "dark" ? "dark" : "light";
    const state = CODE_FIXTURE_STATES.find((entry) => entry === c.req.query("state")) ?? "normal";
    c.req.raw.headers.set("x-cloud-locale", locale);
    c.set("runtime", {
      apps: [
        { id: "core", name: "Core", description: "Platform", icon: "ti ti-cloud", routes: ["/admin", "/"] },
        { id: "mail", name: "Mail", description: "Mail", icon: "ti ti-mail", routes: ["/app/mail"] },
        { id: "spaces", name: "Spaces", description: "Tasks", icon: "ti ti-checkbox", routes: ["/app/spaces"] },
        { id: "werkstatt", name: "Werkstattbuch", description: "Workshop", icon: "ti ti-tool", routes: ["/app/werkstatt"] },
      ],
    });
    c.set("user", user);
    c.set("settings", { app: { name: "Cloud", locale } });
    const t = codeAdminMessages.resolve([locale]).t;
    c.set("page", { title: t.area, theme });
    const query = parseCodeAreaQuery(c.req.query());
    const body = renderToString(() =>
      createComponent(AdminLayout, {
        c,
        title: t.area,
        ownMain: true,
        get children() {
          return createComponent(CodeAreaView, {
            t,
            locale,
            dateConfig: { locale: locale === "de" ? "de-DE" : "en-GB", timeZone: "Europe/Berlin" },
            query,
            data: state === "noperm" ? null : codeFixtureData(state, c.req.query(), locale),
            noPermission: state === "noperm",
            retryHref: c.req.url,
            appNames: { mail: "Mail", spaces: "Spaces", werkstatt: "Werkstattbuch" },
            documentationBase: undefined,
          });
        },
      }),
    );
    return c.html(
      `<!doctype html><html lang="${locale}" class="${theme}" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css"><style>${css}</style></head><body class="k2b-ui">${body}<script src="/fixture.js"></script></body></html>`,
    );
  });

  /** Requests the islands sent, for assertions. */
  const requests: { path: string; body: unknown }[] = [];
  const api = async (request: Request, url: URL): Promise<Response> => {
    const state = new URL(request.headers.get("referer") ?? "http://x/").searchParams.get("state") ?? "normal";
    const path = url.pathname.replace("/api/code/admin/", "");
    const body: unknown = await request.json().catch(() => null);
    requests.push({ path, body });
    if (state === "saving" && path !== "policy/preview") return new Promise(() => {});
    if (path === "decide") {
      const decision = body && typeof body === "object" && "approved" in body ? body.approved : null;
      const detail = fixtureApprovalDetail();
      return Response.json({
        data: {
          version: { ...fixtureCodeDetail().versions[0]!.version, id: detail.version.id, codeId: detail.code.id, number: detail.version.number },
          binding: detail.binding,
          status: decision ? "approved" : "rejected",
          approvalId: detail.approvalId,
          decision: { approved: Boolean(decision), decidedBy: user.id, decidedAt: "2026-11-01T12:20:00.000Z", soleAdmin: false, label: "" },
        },
      });
    }
    if (path === "policy/preview") {
      if (state === "conflict") return Response.json({ code: "CONFLICT", message: "Code policy changed." }, { status: 409 });
      return Response.json({
        data: {
          revision: 7,
          total: 3,
          items: [
            { codeId: "c_woche", title: "Wochenbericht Vertrieb", rows: ["ask_deletes"], reason: "policy_changed" },
            { codeId: "c_liefer", title: "Lieferschein bei Abschluss", rows: ["ask_deletes"], reason: "policy_changed" },
            { codeId: "c_rechn", title: "Rechnungen an die Buchhaltung", rows: ["ask_deletes"], reason: "policy_changed" },
          ],
          nextCursor: null,
          owners: { c_woche: "Lea Muster", c_liefer: "Tom Beispiel", c_rechn: null },
        },
      });
    }
    if (path === "policy/update") {
      if (state === "savefail") return Response.json({ code: "UNAVAILABLE", message: "Database unavailable" }, { status: 503 });
      const definition = body && typeof body === "object" && "definition" in body ? body.definition : null;
      return Response.json({
        data: {
          policy: { revision: 8, definition, updatedBy: user.id, updatedAt: "2026-11-01T12:20:00.000Z" },
          pauseJobId: "aa000000-0000-4000-8000-000000000001",
        },
      });
    }
    if (path === "policy/read") {
      const data = fixtureData();
      const policy = data.policy !== null && data.policy !== "failed" && data.policy !== "missing" ? data.policy.policy : null;
      return Response.json({ data: { policy: { ...policy, revision: 9 } } });
    }
    return Response.json({ code: "NOT_FOUND", message: "Synthetic fixture: not available" }, { status: 404 });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
      if (url.pathname.startsWith("/public/")) {
        const path = resolve(root, `.${url.pathname}`);
        return path.startsWith(`${publicDir}/`) ? new Response(Bun.file(path)) : new Response(null, { status: 404 });
      }
      if (url.pathname.startsWith("/api/code/admin/")) return api(request, url);
      if (url.pathname.startsWith("/api/")) return Response.json({ message: "Synthetic fixture: service unavailable" }, { status: 503 });
      return pages.fetch(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/admin/code`,
    requests,
    reset() {
      requests.length = 0;
    },
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

if (import.meta.main) {
  const fixture = await codeAreaBrowserFixture({ port: Number(Bun.argv[2] ?? 0) });
  console.log(fixture.url);
}
