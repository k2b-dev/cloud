import { expect, spyOn, test } from "bun:test";
import { helpMessages } from "@k2b/cloud/ssr/help-messages";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { apps, defaultRailPreferences, help, panelUrl, rail, server, settings, snapshot } from "./panel.test-fixture";

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
    expect(html.match(/data-help-view(?:="")?[\s\S]*?<\/section>/)?.[0]).toContain('data-help-topic="spaces-share"');
    expect(html).not.toContain('data-help-topic="unknown-id"');
    const dom = createDomTestHarness();
    dom.document.body.innerHTML = html;
    expect(dom.document.querySelector("[data-help-tasks]")?.closest("solid-island")).toBeNull();
    expect(dom.document.querySelector("[data-help-search]")?.closest("solid-island")).toBeNull();
    expect(dom.document.querySelector('[data-help-group="reference"]')?.closest("solid-island")).toBeNull();
    expect(dom.document.querySelector('[data-help-group="reference"]')?.textContent).toContain("spaces fixture roles");
    expect(dom.document.querySelector("[data-help-shortcuts]")?.textContent).toContain("Open global search");
    expect(dom.document.querySelectorAll("solid-island")).toHaveLength(7);
    dom.cleanup();
    expect(html).toContain("--app-canvas-from:#16a34a");
    expect(html).toContain('data-panel-provider="core"');
    for (const absent of ["rail-item", "cloud-app-canvas", 'id="cloud-panel"', "Help for spaces"]) expect(html).not.toContain(absent);
    for (const id of ["restricted", "app-denied", "admin-only", "nope"]) {
      const unavailable = await (await server.request(`${panelUrl(id)}&topic=${id}-share`)).text();
      expect(unavailable).toContain("This Help is not available");
      expect(unavailable).toContain("You may not have access to it, or it no longer exists.");
      expect(unavailable).not.toContain("fixture article");
      expect(unavailable).not.toContain("Server fixture lead.");
      expect(unavailable).not.toContain("fixture app");
      expect(unavailable).not.toContain("data-help-shortcuts");
      expect(unavailable).not.toContain("--app-accent:");
      expect(unavailable).not.toContain("data-help-search");
      expect(unavailable).not.toContain("data-help-menu");
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
    const duplicates = await (await server.request(panelUrl("spaces", ["spaces-share", "spaces-share", "unknown-id"]))).text();
    const viewSection = duplicates.match(/data-help-view(?:="")?[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(viewSection.match(/data-help-topic="spaces-share"/g)).toHaveLength(1);
    const empty = await (await server.request(panelUrl("empty"))).text();
    expect(empty).toContain("No Help articles here yet");
    for (const topic of ["spaces-share", "unknown-id", "UpperCase", "x".repeat(181)]) {
      const article = await (await server.request(`${panelUrl("spaces")}&topic=${topic}`)).text();
      expect(article.includes("data-help-article-head")).toBe(topic === "spaces-share");
      if (topic === "spaces-share") {
        expect(article).toContain('class="help-article-facts"');
        expect(article).toContain("Server fixture lead.");
        expect(article).toContain("Server fixture body.");
        const dom = createDomTestHarness();
        dom.document.body.innerHTML = article;
        const body = dom.document.querySelector(".help-document");
        expect(body?.closest("solid-island")).toBeNull();
        const data = JSON.parse(dom.document.querySelector("[data-help-panel-data]")?.textContent ?? "{}");
        expect(data.article.markdown).toContain("Server fixture body.");
        expect("html" in data.article).toBe(false);
        expect(dom.document.querySelectorAll("[data-help-panel-data]")).toHaveLength(1);
        dom.cleanup();
        expect(article).toContain("2 steps");
        expect(article).not.toContain('data-state="loading"');
      } else expect(article).not.toContain("Server fixture lead.");
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
    expect(failed).toContain("data-help-unavailable");
    expect(failed).toContain("Reload");
  } finally {
    reader.mockRestore();
    for (const spy of spies) spy.mockRestore();
  }
});
