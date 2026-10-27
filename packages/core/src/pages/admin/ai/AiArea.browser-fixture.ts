/** Synthetic admin authority and catalog; the real AdminLayout, AI area view, islands and styles. No live services. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { AiModelSlot } from "@k2b/cloud/shared";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { type AiFixtureCatalog, aiFixtureCatalog, aiFixtureOverview, aiFixtureUsage } from "./AiArea.fixture-data";

/** States the captures and tests switch with `?state=`. */
export type AiAreaFixtureState =
  | "normal"
  | "empty"
  | "unreachable"
  | "badkey"
  | "loadfail"
  | "unassigned"
  | "noperm"
  | "conflict"
  | "listfail"
  | "saving";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "demo-admin",
  roles: ["admin", "user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Mia",
  sn: "Muster",
  displayName: "Mia Muster",
  mail: "mia.muster@example.test",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};

const catalogFor = (state: AiAreaFixtureState): AiFixtureCatalog => {
  const catalog = aiFixtureCatalog();
  if (state === "empty")
    return {
      providers: [],
      models: [],
      variants: [],
      assignments: { fast: null, balanced: null, thorough: null, maximum: null, vision: null, audio: null },
    };
  const cortecs = catalog.providers.find((entry) => entry.id === "cortecs")!;
  if (state === "unreachable") Object.assign(cortecs, { status: "unreachable", statusMessage: "Keine Antwort nach 10 s." });
  if (state === "badkey") Object.assign(cortecs, { status: "key_rejected", statusCode: "401" });
  if (state === "unassigned") catalog.assignments.maximum = null;
  return catalog;
};

export async function aiAreaBrowserFixture(options: { port?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "core-ai-area-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
  const { AdminLayout } = await import("@k2b/cloud/ssr");
  const { AiAreaView } = await import("./view");
  const { aiAreaMessages } = await import("./messages");
  const { parseAiAreaQuery } = await import("./area");
  const ui = resolve(import.meta.dir, "../../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", `${ui}/`));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", `${ui}/`))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", `${ui}/`))).default;
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "AiArea.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-ai-area-fixture",
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
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not compile the AI area islands");
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
  pages.get("/admin/ai", (c) => {
    const locale = c.req.query("locale") === "en" ? "en" : "de";
    const theme = c.req.query("theme") === "dark" ? "dark" : "light";
    const state = (c.req.query("state") ?? "normal") as AiAreaFixtureState;
    c.req.raw.headers.set("x-cloud-locale", locale);
    c.set("runtime", {
      apps: [
        { id: "core", name: "Core", description: "Platform", icon: "ti ti-cloud", routes: ["/admin", "/"] },
        {
          id: "assistant",
          name: "Assistent",
          description: "AI",
          icon: "ti ti-sparkles",
          routes: ["/app/assistant"],
          adminNav: [{ section: "ai", label: "KI", links: [{ href: "/admin/assistant/apps", icon: "ti-apps", label: "Studio-Apps" }] }],
        },
      ],
    });
    c.set("user", user);
    c.set("settings", { app: { name: "Cloud", locale } });
    const t = aiAreaMessages.resolve([locale]).t;
    c.set("page", { title: t.aiArea, theme });
    const catalog = catalogFor(state);
    const overview = aiFixtureOverview(catalog);
    const query = parseAiAreaQuery(c.req.query());
    const provider = overview.providers.find((entry) => entry.id === query.p);
    const providerRow = catalog.providers.find((entry) => entry.id === query.p);
    const providerDetail = providerRow
      ? { ...providerRow, models: catalog.models.filter((entry) => entry.providerId === providerRow.id) }
      : null;
    const modelRow = query.m ? catalog.models.find((entry) => entry.id === query.m) : undefined;
    const model = modelRow
      ? {
          ...modelRow,
          variants: catalog.variants.filter((entry) => entry.modelId === modelRow.id),
          access: {
            entries: [
              {
                id: "a1",
                principal: { type: "authenticated" as const },
                permission: "read" as const,
                createdAt: "2026-10-02T09:00:00.000Z",
              },
            ],
            revision: 1,
          },
        }
      : null;
    const assignmentDetails = (Object.keys(catalog.assignments) as AiModelSlot[]).map((slot) => ({
      slot,
      variantId: catalog.assignments[slot],
      revision: 2,
      updatedAt: "2026-10-27T16:32:00.000Z",
      updatedBy: user.id,
      fallbackChain: [],
      effectiveClass: null,
      usage:
        slot === "fast"
          ? [
              { class: "fast", app: "core", task: "Chat-Titel", calls: 1840 },
              { class: "fast", app: "mail", task: "Betreff", calls: 312 },
            ]
          : slot === "balanced"
            ? [{ class: "balanced", app: "workflows", task: "KI-Schritt", calls: 96 }]
            : [],
    }));
    const body = renderToString(() =>
      createComponent(AdminLayout, {
        c,
        title: t.aiArea,
        ownMain: true,
        get children() {
          return createComponent(AiAreaView, {
            t,
            locale,
            query,
            overview: state === "loadfail" ? null : overview,
            index: state === "loadfail" ? null : { models: catalog.models, variants: catalog.variants, assignments: overview.assignments },
            loadFailed: state === "loadfail",
            studioLinks: [{ href: "/admin/assistant/apps", label: "Studio-Apps", icon: "ti-apps", app: t.fromApp({ p: "Assistent" }) }],
            provider,
            providerDetail,
            model,
            usage: model ? aiFixtureUsage(model.id) : null,
            accountingUnit: "EUR",
            assignmentDetails,
            appNames: { core: "Cloud", mail: "Mail", workflows: "Workflows", assistant: "Assistent" },
            retryHref: c.req.url,
            noPermission: state === "noperm",
            budgets:
              query.sec === "budgets"
                ? {
                    config: {
                      enabled: true,
                      revision: 4,
                      unit: "EUR",
                      background: { enabled: true, warnAt: 40, stopAt: 60 },
                      rules:
                        state === "empty"
                          ? []
                          : [
                              {
                                scope: "*",
                                hours: 168,
                                anchor: "2026-10-26T00:00:00.000Z",
                                grants: [{ principal: { type: "authenticated" as const }, limit: 10 }],
                                peopleAtLimit: 0,
                              },
                              {
                                scope: "claude",
                                hours: 168,
                                anchor: "2026-10-26T00:00:00.000Z",
                                grants: [
                                  {
                                    principal: { type: "group" as const, groupId: "33333333-3333-4333-8333-333333333333" },
                                    displayName: "Gruppe Entwicklung",
                                    limit: 30,
                                  },
                                ],
                                peopleAtLimit: 4,
                              },
                            ],
                    },
                    personalizationTokens: 100_000,
                    models: catalog.models
                      .filter((entry) => entry.kind === "chat" && entry.enabled)
                      .map((entry) => ({ id: entry.id, label: entry.label, priced: Boolean(entry.pricing) })),
                  }
                : undefined,
          });
        },
      }),
    );
    return c.html(
      `<!doctype html><html lang="${locale}" class="${theme}" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css"><style>${css}</style></head><body class="k2b-ui">${body}<script>window.__aiFixtureState=${JSON.stringify(state)}</script><script src="/fixture.js"></script></body></html>`,
    );
  });

  let catalog = aiFixtureCatalog();
  const conflictBody = (current: unknown) =>
    Response.json(
      {
        code: "conflict",
        current,
        changedBy: { id: "22222222-2222-4222-8222-222222222222", name: "Mara Beispiel" },
        changedAt: "2026-10-27T17:42:00.000Z",
      },
      { status: 409 },
    );
  const api = async (request: Request, url: URL): Promise<Response> => {
    const state = (new URL(request.headers.get("referer") ?? "http://x/").searchParams.get("state") ?? "normal") as AiAreaFixtureState;
    const path = url.pathname.replace("/api/admin/core/ai", "");
    if (state === "saving" && request.method !== "GET") return new Promise(() => {});
    if (request.method === "GET" && path === "/overview") return Response.json(aiFixtureOverview(catalog));
    if (request.method === "GET" && path === "/providers") return Response.json({ providers: catalog.providers });
    if (request.method === "GET" && path === "/models") return Response.json({ models: catalog.models });
    const modelMatch = path.match(/^\/models\/([^/]+)(\/usage)?$/);
    if (request.method === "GET" && modelMatch) {
      const found = catalog.models.find((entry) => entry.id === modelMatch[1]);
      if (!found) return Response.json({ code: "model_not_found" }, { status: 404 });
      if (modelMatch[2]) return Response.json(aiFixtureUsage(found.id));
      return Response.json({ ...found, variants: catalog.variants.filter((entry) => entry.modelId === found.id) });
    }
    const variantUsage = path.match(/^\/variants\/([^/]+)\/usage$/);
    if (request.method === "GET" && variantUsage)
      return Response.json({
        ...aiFixtureUsage(""),
        assignments: (Object.keys(catalog.assignments) as AiModelSlot[]).filter(
          (slot) => catalog.assignments[slot] === decodeURIComponent(variantUsage[1]!),
        ),
      });
    const available = path.match(/^\/providers\/([^/]+)\/available-models$/);
    if (available) {
      if (state === "listfail") return Response.json({ code: "list_failed", message: "Der Anbieter antwortete mit 502." }, { status: 502 });
      return Response.json({
        models: [
          { providerModel: "gpt-oss-120b", label: "GPT-OSS 120B", contextWindow: 131_072 },
          { providerModel: "mistral-small", label: "Mistral Small", contextWindow: 32_768 },
          { providerModel: "qwen3-coder-480b", label: "Qwen3 Coder", contextWindow: 262_144 },
          { providerModel: "deepseek-v3", label: "DeepSeek V3", contextWindow: 65_536 },
          { providerModel: "whisper-large-v3", label: "Whisper Large", kind: "transcription" },
        ],
      });
    }
    if (path.endsWith("/test")) return Response.json({ status: state === "badkey" ? "key_rejected" : "ok", message: "", latencyMs: 412 });
    if (state === "conflict") {
      const modelPatch = path.match(/^\/models\/([^/]+)$/);
      if (request.method === "PATCH" && modelPatch) {
        const found = catalog.models.find((entry) => entry.id === modelPatch[1])!;
        return conflictBody({
          ...found,
          revision: found.revision + 1,
          pricing: { inputPerMillion: 0.18, outputPerMillion: 0.6 },
          variants: catalog.variants.filter((entry) => entry.modelId === found.id),
        });
      }
      const slot = path.match(/^\/assignments\/([^/]+)$/);
      if (request.method === "PUT" && slot)
        return conflictBody({
          slot: slot[1],
          variantId: "claude",
          revision: 3,
          updatedAt: "2026-10-27T17:42:00.000Z",
          updatedBy: "22222222-2222-4222-8222-222222222222",
        });
    }
    if (request.method === "PUT" && path.startsWith("/assignments/")) {
      const slot = path.split("/")[2] as AiModelSlot;
      const body = (await request.json()) as { variantId: string | null };
      catalog = { ...catalog, assignments: { ...catalog.assignments, [slot]: body.variantId } };
      return Response.json({ slot, variantId: body.variantId, revision: 3, updatedAt: "2026-10-27T17:50:00.000Z", updatedBy: user.id });
    }
    return Response.json({ message: "Synthetic fixture: not available" }, { status: 503 });
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
      if (url.pathname === "/api/admin/core/ai-quotas/background")
        return Response.json({ used: 12.4, reserved: 0, unknown: 0, stoppedAt: null });
      if (url.pathname.startsWith("/api/admin/core/ai-quotas")) return Response.json({ enabled: true, revision: 5, rules: [] });
      if (url.pathname.startsWith("/api/admin/core/ai")) return api(request, url);
      if (url.pathname.startsWith("/api/")) return Response.json({ message: "Synthetic fixture: service unavailable" }, { status: 503 });
      return pages.fetch(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/admin/ai`,
    reset() {
      catalog = aiFixtureCatalog();
    },
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

if (import.meta.main) {
  const fixture = await aiAreaBrowserFixture({ port: Number(Bun.argv[2] ?? 0) });
  console.log(fixture.url);
}
