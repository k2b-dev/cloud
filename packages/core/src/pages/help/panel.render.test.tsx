import { expect, spyOn, test } from "bun:test";
import { helpMessages } from "@k2b/cloud/ssr/help-messages";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { apps, defaultRailPreferences, help, panelUrl, rail, server, settings, snapshot } from "./panel.test-fixture";

test("Core scopes an AI app's Help panel without changing the host document's primary", async () => {
  const app = apps.find((app) => app.id === "spaces")!;
  const original = app.appearance;
  const spies = [
    spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(snapshot, "loadSnapshot").mockResolvedValue({ app: { name: "Cloud" } }),
    spyOn(help, "createHelpReader").mockReturnValue({
      manifest: async () => null,
      list: async () => [],
      search: async () => [],
      read: async () => null,
    }),
  ];
  try {
    for (const primary of [undefined, "ai"] as const) {
      app.appearance = { accent: "#16a34a", primary };
      const response = await server.request(panelUrl("spaces"));
      expect(response.status).toBe(200);
      const html = await response.text();
      const panel = html.match(/<div\b[^>]*data-surface="panel"[^>]*>/)?.[0] ?? "";
      expect(panel).toContain("app-accent-scope");
      expect(panel.includes('data-k2b-primary="ai"')).toBe(primary === "ai");
      expect(html.match(/<body\b[^>]*>/)?.[0]).not.toContain("data-k2b-primary");
    }
  } finally {
    app.appearance = original;
    for (const spy of spies) spy.mockRestore();
  }
});

// One reader stub preserves preloadLayoutHelp's actual failure tracking and request-local cache.
test("Help panel SSR authorizes selectors and renders the first view without shell chrome", async () => {
  const articleReads: string[] = [];
  const spies = [
    spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(snapshot, "loadSnapshot").mockResolvedValue({ app: { name: "Cloud" } }),
  ];
  let fail = false;
  const requestedApps: string[] = [];
  const reader = spyOn(help, "createHelpReader").mockImplementation((locale) => ({
    manifest: async (id) => {
      requestedApps.push(id);
      if (fail) throw new Error("Fixture metadata read failed");
      const app = apps.find((app) => app.id === id);
      return app?.help
        ? {
            ...app.help,
            locale,
            documents: [
              {
                id: `${id}-share`,
                title: `${id} fixture article`,
                order: 1,
                locale,
                kind: "task",
                url: `/api/help/${id}`,
                searchUrl: `/api/help/${id}/search`,
              },
              {
                id: `${id}-roles`,
                title: `${id} fixture roles`,
                order: 2,
                locale,
                kind: "reference",
                url: `/api/help/${id}/roles`,
                searchUrl: `/api/help/${id}/search`,
              },
            ],
          }
        : null;
    },
    list: async () => [],
    search: async () => [],
    read: async ({ appId, documentId }) => {
      articleReads.push(`${appId}/${documentId}`);
      return {
        appId,
        documentId,
        appName: appId,
        title: `${appId} fixture article`,
        locale,
        manifestHash: appId,
        order: 1,
        kind: "task",
        needs: "edit",
        related: [],
        links: {},
        markdown: 'Server fixture lead.\n\n## Open sharing {icon="share"}\n\n:::steps\n1. Server fixture body.\n2. Confirm sharing.\n:::',
      };
    },
  }));
  try {
    const response = await server.request(panelUrl("spaces"));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
    const dom = createDomTestHarness();
    dom.document.body.innerHTML = html;
    const section = (title: string) => dom.document.querySelector(`section[data-k2-part="Section"][aria-label="${title}"]`);
    // The v2 reader is one island that the server renders with its first view: the start and its search.
    expect(dom.document.querySelectorAll('[data-k2-part="Workspace"]')).toHaveLength(1);
    expect(dom.document.querySelector('[data-k2-part="Workspace"]')?.closest(".k2-ui")).not.toBeNull();
    expect(section("For this view")?.querySelector('a[href="?topic=spaces-share"]')).not.toBeNull();
    expect(html).not.toContain("?topic=unknown-id");
    expect(section("Look up")?.textContent).toContain("spaces fixture roles");
    expect(section("Everywhere")?.textContent).toContain("Open global search");
    expect(dom.document.querySelector('input[type="search"]')).not.toBeNull();
    expect(dom.document.querySelectorAll('[data-k2-part="Loading"]')).toHaveLength(0);
    dom.cleanup();
    expect(html).toContain("--app-canvas-from:#16a34a");
    expect(html).toContain('data-panel-provider="core"');
    for (const absent of ["rail-item", "cloud-app-canvas", 'id="cloud-panel"']) expect(html).not.toContain(absent);
    for (const id of ["restricted", "app-denied", "admin-only", "nope"]) {
      const unavailable = await (await server.request(`${panelUrl(id)}&topic=${id}-share`)).text();
      expect(unavailable).toContain("This Help is not available");
      expect(unavailable).toContain("You may not have access to it, or it no longer exists.");
      expect(unavailable).not.toContain("fixture article");
      expect(unavailable).not.toContain("Server fixture lead.");
      expect(unavailable).not.toContain("fixture app");
      expect(unavailable).not.toContain("Open global search");
      expect(unavailable).not.toContain("--app-accent:");
      expect(unavailable).not.toContain('type="search"');
      expect(unavailable).not.toContain("Copy as Markdown");
    }
    expect(requestedApps).not.toContain("restricted");
    expect(requestedApps).not.toContain("app-denied");
    expect(requestedApps).not.toContain("nope");
    expect(requestedApps).not.toContain("admin-only");
    const core = await (await server.request("/panel")).text();
    expect(core).toContain("core fixture article");
    expect(core).not.toContain("spaces fixture article");
    const nullContext = await (await server.request("/panel?cloud_panel_context=null")).text();
    expect(nullContext).toContain("core fixture article");
    const duplicates = createDomTestHarness();
    duplicates.document.body.innerHTML = await (
      await server.request(panelUrl("spaces", ["spaces-share", "spaces-share", "unknown-id"]))
    ).text();
    expect(duplicates.document.querySelectorAll('section[aria-label="For this view"] a[href="?topic=spaces-share"]')).toHaveLength(1);
    duplicates.cleanup();
    const empty = await (await server.request(panelUrl("empty"))).text();
    expect(empty).toContain("No Help articles here yet");
    for (const topic of ["spaces-share", "unknown-id", "UpperCase", "x".repeat(181)]) {
      const article = createDomTestHarness();
      article.document.body.innerHTML = await (await server.request(`${panelUrl("spaces")}&topic=${topic}`)).text();
      const detail = article.document.querySelector('[data-k2-part="Pane"][data-detail]');
      expect(detail !== null).toBe(topic === "spaces-share");
      if (topic === "spaces-share") {
        // The article renders with the page: its facts, lead and body, and no loading shape.
        expect(detail?.textContent).toContain("2 steps");
        expect(detail?.textContent).toContain("Server fixture lead.");
        expect(detail?.textContent).toContain("Server fixture body.");
        expect(detail?.querySelectorAll('[data-k2-part="Loading"]')).toHaveLength(0);
      } else expect(article.document.body.textContent).not.toContain("Server fixture lead.");
      article.cleanup();
    }
    expect(articleReads).toEqual(["spaces/spaces-share"]);
    const german = await (
      await server.request(panelUrl("spaces"), {
        headers: { "Accept-Language": "de", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      })
    ).text();
    expect(german).toContain("Für diese Ansicht");
    expect(german).toContain("Was möchtest du tun?");
    expect(german).toContain("⌘");
    expect(helpMessages.resolve(["de"]).t.openAsPage).toBe("Als Seite öffnen");
    fail = true;
    const failed = await (await server.request(panelUrl("spaces"))).text();
    expect(failed).toContain("Help could not be loaded");
    expect(failed).toContain('data-k2-part="Failed"');
  } finally {
    reader.mockRestore();
    for (const spy of spies) spy.mockRestore();
  }
});
