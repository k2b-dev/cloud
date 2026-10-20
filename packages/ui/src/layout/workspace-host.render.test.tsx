import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const directory = mkdtempSync(resolve(tmpdir(), "k2b-workspace-host-render-"));
const { plugin } = createConfig({ dev: true, rootDir: directory });
Bun.plugin(plugin());
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const { default: AppWorkspace, appWorkspaceDetailElementId } = await import("./AppWorkspace");
const { LocaleProvider } = await import("../intl/locale");

test("application controls share the Detail's server-rendered DOM id", () => {
  const id = appWorkspaceDetailElementId("reader");
  expect(id).toBe("k2b-workspace-detail-reader");
  const html = renderToString(() => createComponent(AppWorkspace.Detail, { id: "reader", open: true, children: "Context" }));
  expect(html).toMatch(new RegExp(`<aside[^>]*id="${id}"`));
  expect(html).toContain(`aria-controls="${id}"`);
  expect(() => appWorkspaceDetailElementId("invalid id")).toThrow();
});

for (const locale of ["en", "de"] as const) {
  test(`Detail server-renders an accessible Details toggle before its handle and aside (${locale})`, () => {
    const html = renderToString(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(AppWorkspace.Detail, { id: "person", open: true, children: "Contact" });
        },
      }),
    );
    const button = html.match(/<button[^>]*data-app-workspace-detail-toggle[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).toContain('type="button"');
    expect(button).toContain('aria-controls="k2b-workspace-detail-person"');
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain('aria-hidden="true"');
    expect(button).toContain("Details");
    expect(html.indexOf(button!)).toBeLessThan(html.indexOf('data-app-workspace-resize="detail"'));
    expect(html.indexOf('data-app-workspace-resize="detail"')).toBeLessThan(html.indexOf("<aside"));
  });
}

for (const openOnChoice of [undefined, true, false]) {
  test(`Detail renders request-only choice metadata only when opted out (${openOnChoice})`, () => {
    const html = renderToString(() =>
      createComponent(AppWorkspace.Detail, { id: "reader", open: true, openOnChoice, children: "Context" }),
    );
    if (openOnChoice === false) expect(html).toMatch(/<aside[^>]*data-workspace-detail-choice="request"/);
    else expect(html).not.toContain("data-workspace-detail-choice");
  });
}

for (const minWidth of [760, 320, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
  test(`Main emits its scoped minimum rule only for finite widths above 320 (${minWidth})`, () => {
    const html = renderToString(() => createComponent(AppWorkspace.Main, { minWidth, children: "Main" }));
    if (minWidth === 760) {
      expect(html).toContain('data-workspace-main-min="760"');
      expect(html).toContain("--k2b-workspace-main-min:760px");
      expect(html).toContain(".k2b-app-workspace:has(> .k2b-app-workspace__content > .k2b-app-workspace__main");
      expect(html).toContain(":is(solid-island, solid-client)");
    } else {
      expect(html).not.toContain("data-workspace-main-min");
      expect(html).not.toContain("<style");
    }
  });
}

const share = { share: 0.25, offset: 428, min: 772, max: 892 };
for (const minWidth of [share, { ...share, offset: undefined }]) {
  test(`Main emits scoped padding, grid and container minimum rules for a share (offset ${minWidth.offset})`, () => {
    const html = renderToString(() => createComponent(AppWorkspace.Main, { minWidth, children: "Main" }));
    expect(html).toContain(`data-workspace-main-min="share:0.25,${minWidth.offset ?? 0},772,892"`);
    expect(html).toContain(`--k2b-workspace-main-min:clamp(772px, 0.25 * 100% + ${minWidth.offset ?? 0}px, 892px)`);
    expect(html).toContain("--k2b-workspace-main-min-grid:clamp(772px, (0.25 * (100% + var(--k2b-workspace-sidebar-space) + 2px - 20rem)");
    expect(html).toContain("--k2b-workspace-main-min-cq:clamp(772px, (0.25 * (100cqi + var(--k2b-workspace-sidebar-space) + 2px - 20rem)");
    expect(html).toContain("/ 0.75, 892px)");
    expect(html).toContain(":is(solid-island, solid-client)");
  });
}

for (const invalid of [
  { ...share, share: 0 },
  { ...share, share: 1 },
  { ...share, share: -0.25 },
  { ...share, share: Number.NaN },
  { ...share, share: Number.POSITIVE_INFINITY },
  { ...share, offset: Number.NaN },
  { ...share, offset: Number.POSITIVE_INFINITY },
  { ...share, min: Number.NEGATIVE_INFINITY },
  { ...share, max: Number.POSITIVE_INFINITY },
  { ...share, min: 893 },
]) {
  test(`invalid share keeps Main's default (${JSON.stringify(invalid)})`, () => {
    const html = renderToString(() => createComponent(AppWorkspace.Main, { minWidth: invalid, children: "Main" }));
    expect(html).not.toContain("data-workspace-main-min");
    expect(html).not.toContain("<style");
  });
}

test("MainPane emits a workspace share fallback inside its own limits and a numeric server handle", () => {
  const html = renderToString(() =>
    createComponent(AppWorkspace.Main, {
      get children() {
        return [
          createComponent(AppWorkspace.MainPane, {
            id: "list",
            label: "List",
            defaultSize: { share: 0.25, offset: -12, min: 332, max: 452 },
            minSize: 300,
            maxSize: 500,
            children: "List",
          }),
          "Reader",
        ];
      },
    }),
  );
  expect(html).toContain(
    "clamp(300px, var(--k2b-workspace-pane-list-width, clamp(332px, 0.25 * var(--k2b-workspace-width) + -12px, 452px)), 500px)",
  );
  expect(html).toContain('data-workspace-default-size="share:0.25,-12,332,452"');
  expect(html).toContain('aria-valuenow="332"');
});

for (const available of [true, false]) {
  test(`reopenable Detail exposes its closed trigger before hydration (${available})`, () => {
    const html = renderToString(() =>
      createComponent(AppWorkspace.Detail, {
        id: "reader",
        open: false,
        available,
        onOpen: () => {},
        children: "Context",
      }),
    );
    const button = html.match(/<button[^>]*data-app-workspace-detail-toggle[^>]*>/)?.[0];
    expect(button).toContain('data-workspace-detail-reopen="true"');
    expect(button).toContain('aria-expanded="false"');
    expect(Boolean(button?.match(/\sdisabled(?:[= >])/))).toBe(!available);
    expect(html).toMatch(/<aside[^>]*hidden/);
  });
}

for (const explicit of [true, false]) {
  test(`object navigation retains SSR reading order with ${explicit ? "explicit" : "fallback"} head`, () => {
    const markup = renderToString(() =>
      createComponent(AppWorkspace, {
        mobileSurface: "flush",
        get children() {
          return [
            createComponent(AppWorkspace.Sidebar, { label: "Objects", mobile: "stacked", children: "Object links" }),
            explicit ? createComponent(AppWorkspace.Head, { views: "View links" }) : null,
            createComponent(AppWorkspace.Content, { children: "Work content" }),
          ];
        },
      }),
    );
    expect(markup.match(/class="k2b-app-workspace__head[" ]/g)?.length).toBe(1);
    const nav = markup.indexOf('aria-label="Objects"');
    const head = markup.indexOf('class="k2b-app-workspace__head"');
    const content = markup.indexOf('class="k2b-app-workspace__content');
    if (explicit) expect(nav).toBeLessThan(head);
    else expect(head).toBeLessThan(nav);
    expect(nav).toBeLessThan(content);
    expect(head).toBeLessThan(content);
  });
}
