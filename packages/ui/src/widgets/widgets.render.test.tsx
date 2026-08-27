import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-widget-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Widget } = await import("./Widget");
const { WidgetHero } = await import("./WidgetHero");
const { WidgetList } = await import("./WidgetList");
const { LocaleProvider } = await import("../intl/locale");
const { WidgetPills } = await import("./WidgetPills");
const { WidgetStat } = await import("./WidgetStat");
const { WidgetStatus } = await import("./WidgetStatus");

const parityCss = readFileSync(resolve(import.meta.dir, "../styles/surfaces-widgets-parity.css"), "utf8");

describe("@k2b/ui Cloud-faithful widget composition", () => {
  test("keeps fixed widget sizes and links only the header", () => {
    const html = renderToString(() =>
      createComponent(Widget, {
        title: "Operations",
        meta: "last 24h",
        icon: "ti ti-activity",
        href: "/operations",
        size: "compact",
        children: createComponent(WidgetList, {
          items: [{ label: "Failed jobs", href: "/jobs?state=failed" }],
        }),
      }),
    );

    expect(html).toStartWith("<div");
    expect(html).toContain('class="k2b-paper k2b-widget');
    expect(html).toContain('data-size="compact"');
    expect(html).toContain('href="/operations" class="k2b-widget__header"');
    expect(html).toContain('href="/jobs?state=failed"');
    expect(html.indexOf('</a><div class="k2b-widget__body">')).toBeGreaterThan(-1);
  });

  test("renders list subtext, empty state, tone, links, and grow behavior", () => {
    const list = renderToString(() =>
      createComponent(WidgetList, {
        grow: true,
        items: [{ label: "Deploy", sub: "Production", meta: "now", icon: "ti ti-rocket", iconTone: "blue", href: "/deploy" }],
      }),
    );
    const empty = renderToString(() => createComponent(WidgetList, { items: [], emptyMessage: "No deployments", grow: true }));

    expect(list).toContain('data-grow="true"');
    expect(list).toContain("Production");
    expect(list).toContain('data-tone="blue"');
    expect(list).toContain('href="/deploy"');
    expect(empty).toContain("No deployments");
    expect(empty).toContain('data-grow="true"');
  });

  test("renders pills and stats with the shared five-tone vocabulary", () => {
    const pills = renderToString(() =>
      createComponent(WidgetPills, {
        grow: true,
        pills: [{ label: "Errors", value: 3, tone: "red", href: "/errors" }],
      }),
    );
    const stat = renderToString(() =>
      createComponent(WidgetStat, {
        label: "Requests",
        value: 42,
        sub: "last hour",
        valueClass: "request-value",
        grow: true,
        accent: { icon: "ti ti-trending-up", text: "+12%", tone: "emerald" },
      }),
    );

    expect(pills).toContain('href="/errors"');
    expect(pills).toContain('data-tone="red"');
    expect(pills).toContain('data-grow="true"');
    expect(stat).toContain("last hour");
    expect(stat).toContain("+12%");
    expect(stat).toContain("request-value");
  });

  test("renders the four WidgetStatus tones and their defaults", () => {
    const status = renderToString(() =>
      createComponent(WidgetStatus, { title: "Degraded", message: "One source unavailable", tone: "warning", grow: true }),
    );
    const custom = renderToString(() => createComponent(WidgetStatus, { title: "Queued", tone: "info", icon: "ti ti-clock" }));

    expect(status).toContain('data-tone="warning"');
    expect(status).toContain("ti ti-alert-triangle");
    expect(status).toContain("One source unavailable");
    expect(status).toContain('data-grow="true"');
    expect(custom).toContain("ti ti-clock");
  });

  test("formats numeric widget values with the render locale and preserves strings", () => {
    const number = renderToString(() =>
      createComponent(LocaleProvider, {
        locale: "de-CH",
        get children() {
          return createComponent(WidgetStat, { label: "Requests", value: 1234.5 });
        },
      }),
    );
    const string = renderToString(() => createComponent(WidgetPills, { pills: [{ label: "Code", value: "1234.5" }] }));

    expect(number).toContain(new Intl.NumberFormat("de-CH").format(1234.5));
    expect(string).toContain("1234.5");
  });

  test("keeps the widget chrome Cloud actually paints", () => {
    expect(parityCss).toMatch(/\.k2b-widget__icon \{[^}]*background: transparent/);
    expect(parityCss).toContain(".k2b-ui a.k2b-widget__header:hover { background: transparent; }");
    // WidgetStatus is a full-bleed banner; `error` is the one untinted tone.
    expect(parityCss).toContain('.k2b-widget-status[data-tone="danger"] { color: #991b1b; background: transparent; }');
    expect(parityCss).toMatch(/\.k2b-widget-status \{[^}]*border-radius: 0/);
    expect(parityCss).toContain('.k2b-widget-status[data-tone="warning"] .k2b-widget-status__icon');
    // Only `grow` blocks may claim the leftover height inside a fixed widget.
    expect(parityCss).toMatch(/\.k2b-widget-stat \{[^}]*flex: 0 0 auto/);
    expect(parityCss).toMatch(/\.k2b-widget-list \{[^}]*flex: 0 0 auto/);
    expect(parityCss).toMatch(/\.k2b-widget-pills \{[^}]*margin-top: 0/);
  });

  test("emits no inline Tailwind utility classes", () => {
    const rendered = [
      renderToString(() =>
        createComponent(Widget, {
          title: "Ops",
          icon: "ti ti-activity",
          meta: "24h",
          href: "/ops",
          get children() {
            return createComponent(WidgetHero, { title: "All clear", subtitle: "Nothing to do", icon: "ti ti-check", tone: "zinc" });
          },
        }),
      ),
      renderToString(() => createComponent(WidgetList, { items: [{ label: "L", sub: "s", meta: "m", icon: "ti ti-x", href: "/x" }] })),
      renderToString(() => createComponent(WidgetList, { items: [] })),
      renderToString(() => createComponent(WidgetPills, { pills: [{ label: "P", value: 1, tone: "red", href: "/p" }] })),
      renderToString(() =>
        createComponent(WidgetStat, { label: "L", value: 1, sub: "s", accent: { tone: "amber", icon: "ti ti-x", text: "+1" } }),
      ),
      renderToString(() => createComponent(WidgetStatus, { title: "T", message: "M", tone: "success" })),
    ].join("");

    const foreign = [...rendered.matchAll(/class="([^"]*)"/g)]
      .flatMap((attribute) => (attribute[1] ?? "").split(/\s+/).filter(Boolean))
      .filter((token) => !/^(k2b-|ti$|ti-)/.test(token));

    expect(foreign).toEqual([]);
  });
});
