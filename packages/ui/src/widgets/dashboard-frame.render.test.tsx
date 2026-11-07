import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-dashboard-frame-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { DashboardFrame } = await import("./DashboardFrame");
const { LocaleProvider } = await import("../intl/locale");
type Props = Parameters<typeof DashboardFrame>[0];

const solidMarkers = ["<!--$-->", "<!--/-->", "<!--!$-->"];
const strip = (html: string) =>
  solidMarkers
    .reduce((text, marker) => text.replaceAll(marker, ""), html)
    .replace(/ data-hk="[^"]*"/g, "")
    .replace(/ +([">])/g, "$1");
const frame = (props: Props, locale = "en") =>
  strip(
    renderToString(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(DashboardFrame, props);
        },
      }),
    ),
  );
const base: Props = { title: "Budgets", subtitle: "Booked and expected", height: "240px", children: "content" };

test("without a title the frame is only the surface, for content with its own head", () => {
  expect(frame({ children: "explorer" })).toBe('<div class="k2b-paper k2b-dashboard-frame">explorer</div>');
});

test("ready shows title, subtitle, tools and the content at the body's height", () => {
  const html = frame({ ...base, headingLevel: 4, tools: "tools" });
  expect(html).toContain("<h4>Budgets</h4>");
  expect(html).toContain('<p role="status">Booked and expected</p>');
  expect(html).toContain('<div class="k2b-dashboard-frame__tools">tools</div>');
  expect(html).toContain('<div class="k2b-dashboard-frame__body" style="height:240px">content</div>');
});

test("loading and stale take the subtitle's line; stale names the time and offers Try again", () => {
  expect(frame({ ...base, state: "loading" })).toContain('<p role="status">Loading …</p>');
  const stale = frame({ ...base, state: "stale", asOf: "09:12", onRetry: () => {} });
  expect(stale).toContain(
    '<p role="status" class="k2b-dashboard-frame__stale">As of 09:12 · Refresh failed · <button type="button" class="k2b-dashboard-frame__link">Try again</button></p>',
  );
  // Stale keeps the content; without onRetry there is no button.
  expect(stale).toContain(">content</div>");
  expect(frame({ ...base, state: "stale" })).not.toContain("<button");
});

test("a compact frame shows loading, empty and failure as one quiet line in the body", () => {
  expect(frame({ ...base, compact: true, state: "loading" })).toContain(
    '<div class="k2b-dashboard-frame__skeleton" aria-hidden="true"><span></span><span></span></div>',
  );
  expect(frame({ ...base, compact: true, state: "empty", empty: "No budget is set." })).toContain(
    '<p class="k2b-dashboard-frame__inline-state"><i class="ti ti-chart-bar-off" aria-hidden="true"></i>No budget is set.</p>',
  );
  const failed = frame({ ...base, compact: true, state: "error", onRetry: () => {} });
  expect(failed).toContain('role="alert"');
  expect(failed).toContain("The data could not be loaded.");
  expect(failed).toContain(">Try again</button>");
  expect(failed).not.toContain(">content<");
});

test("a reserved frame keeps the hidden full content in every state and centres its message", () => {
  for (const state of ["ready", "loading", "empty", "error", "stale"] as const) {
    const html = frame({ ...base, height: undefined, reserve: "every row", state, empty: "No campaign.", emptyIcon: "ti ti-table-off" });
    expect(html, state).toContain('<div class="k2b-dashboard-frame__reserve" aria-hidden="true" inert>every row</div>');
    if (state === "ready" || state === "stale") expect(html, state).toContain('<div class="k2b-dashboard-frame__content">content</div>');
    else expect(html, state).toContain(`<div class="k2b-chart-explorer__state" data-state="${state}"`);
  }
  expect(
    frame({ ...base, reserve: "rows", state: "empty", empty: "No campaign.", emptyIcon: "ti ti-table-off", emptyAction: "Clear" }),
  ).toContain('<i class="ti ti-table-off"></i></span><p>No campaign.</p>Clear</div>');
});

test("the frame's own words follow the inherited locale", () => {
  const html = frame({ ...base, state: "stale", asOf: "09:12", onRetry: () => {} }, "de");
  expect(html).toContain("Stand 09:12");
  expect(html).toContain("Erneut versuchen");
  expect(frame({ ...base, state: "loading" }, "de")).not.toContain("Loading");
});
