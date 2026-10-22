import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "spaces-sidebar-render-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: SpacesSidebarList } = await import("./SpacesSidebarList");
const { default: SpaceSidebar } = await import("./SpaceSidebar");
const { LocaleProvider } = await import("@k2b/ui");
const sidebar = {
  spaces: [
    { id: "First01", name: "Launch", color: "#3b82f6", description: "Launch work", openItemCount: 3 },
    { id: "Other01", name: "Ideas", color: "#6366f1", description: null, openItemCount: 2 },
  ],
  pinnedSpaceIds: ["Other01"],
  myWorkCount: 5,
};

describe("shared Spaces sidebar", () => {
  for (const locale of ["en", "de"]) {
    test(`overview and Space contain identical object rows without a switcher (${locale})`, async () => {
      const render = (space: boolean) =>
        renderToString(() =>
          createComponent(LocaleProvider, {
            locale,
            get children() {
              return space
                ? createComponent(SpaceSidebar, {
                    sidebar,
                    ctx: {
                      userId: "user",
                      space: {
                        id: "First01",
                        name: "Launch",
                        color: "#3b82f6",
                        description: null,
                        icalToken: null,
                        createdAt: "2026-10-01T00:00:00Z",
                        updatedAt: "2026-10-01T00:00:00Z",
                        columns: [],
                        virtualColumns: [],
                        tags: [],
                        templates: [],
                      },
                      columns: [],
                      tags: [],
                      currentView: "list",
                      query: "view=list",
                      hasOverride: false,
                      settings: { view: "list", hideSettings: false },
                      canWrite: false,
                    },
                  })
                : createComponent(SpacesSidebarList, { ...sidebar, current: { kind: "overview" }, canCreate: true });
            },
          }),
        );
      const overview = render(false);
      const space = render(true);
      for (const html of [overview, space]) {
        expect(html).toContain(locale === "de" ? "Meine Arbeit" : "My work");
        expect(html).toContain("Launch");
        expect(html).toContain("Ideas");
        expect(html.indexOf('href="/app/spaces/Other01"')).toBeLessThan(html.indexOf('href="/app/spaces/First01"'));
        expect(html).not.toContain("k2b-sidebar-switcher");
        expect(html).not.toContain("k2b-app-workspace__switcher");
        expect(html).not.toContain("view=kanban");
        expect(html).toContain(locale === "de" ? "Neuer Space" : "New space");
        // The collapsed rail hides every label and row action, so each link and button it shows names itself in its title.
        const rail = [...html.matchAll(/<(?:a|button)\b[^>]*>/g)]
          .map((match) => match[0])
          // Rows with a pin action keep their link inside an expanded-only wrapper, so only whole-row controls count here.
          .filter((tag) => /class="k2b-app-workspace__sidebar-item[\s"]/.test(tag) && !/data-sidebar-mode="expanded"/.test(tag));
        const names = rail.map((control) => control.match(/\btitle="([^"]+)"/)?.[1]);
        expect(names).toEqual([
          locale === "de" ? "Meine Arbeit" : "My work",
          "Ideas",
          "Launch: Launch work",
          locale === "de" ? "Neuer Space" : "New space",
        ]);
      }
      expect(overview).toMatch(/<a[^>]*href="\/app\/spaces"[^>]*aria-current="page"/);
      expect(space).toMatch(/<a[^>]*href="\/app\/spaces\/First01"[^>]*aria-current="page"/);
      expect(space).toContain('"label":"Launch"');
      expect(space).not.toContain('"switchLabel"');
      // JSX spreads render on the server but are not serialized by the island transform.
      const snapshots: string[] = [];
      await new HTMLRewriter()
        .on('solid-island[data-file="SpacesSidebarList.island.tsx"]', {
          element(element) {
            snapshots.push(element.getAttribute("data-props") ?? "");
          },
        })
        .transform(new Response(space))
        .text();
      expect(snapshots).toHaveLength(1);
      for (const field of ["spaces", "pinnedSpaceIds", "myWorkCount", "Other01", "Launch", "Ideas"]) expect(snapshots[0]).toContain(field);
    });
  }
});
