import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-dashboard-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { DashboardGrid, DashboardPanel, DashboardSection } = await import("./Dashboard");
const css = readFileSync(resolve(import.meta.dir, "../styles/surfaces-widgets-parity.css"), "utf8");
// Dynamic leaves a trailing space in class lists and before ">" on the server; it is not part of the contract.
const strip = (html: string) =>
  html
    .replace(/ data-hk="[^"]*"/g, "")
    .replace(/<!--[^>]*-->/g, "")
    .replace(/ +([">])/g, "$1");

test("a section names itself by its heading and draws its icon as a plain glyph", () => {
  const html = strip(
    renderToString(() =>
      createComponent(DashboardSection, {
        title: "Traffic",
        icon: "ti ti-router",
        iconColor: "#14b8a6",
        description: "Source Traefik · every 5 min",
        get children() {
          return createComponent(DashboardPanel<"article">, { width: "twoThirds", "aria-label": "Requests", children: "chart" });
        },
      }),
    ),
  );
  const id = /<h2 id="([^"]+)"/.exec(html)?.[1];
  expect(id).toBeTruthy();
  expect(html).toContain(`<section class="k2b-dashboard-section" aria-labelledby="${id}">`);
  expect(html).toContain(
    '<i class="k2b-dashboard-section__icon ti ti-router" style="color:color-mix(in srgb, #14b8a6 72%, var(--k2b-text))" aria-hidden="true">',
  );
  expect(html).not.toContain("k2b-icon-tile");
  expect(html).toContain('<p class="k2b-dashboard-section__description">Source Traefik · every 5 min</p>');
  expect(html).toContain('<article aria-label="Requests" class="k2b-dashboard-panel" data-width="twoThirds">chart</article>');
});

test("an untitled section has no heading, takes its accessible name from ariaLabel and panels default to a third", () => {
  const html = strip(
    renderToString(() =>
      createComponent(DashboardGrid, {
        get children() {
          return createComponent(DashboardSection, {
            ariaLabel: "Key figures",
            get children() {
              return createComponent(DashboardPanel<"div">, { as: "div", class: "app-panel", children: "x" });
            },
          });
        },
      }),
    ),
  );
  expect(html).toBe(
    '<div class="k2b-dashboard-grid"><section class="k2b-dashboard-section" aria-label="Key figures"><div class="k2b-dashboard-section__grid"><div class="k2b-dashboard-panel app-panel" data-width="third">x</div></div></section></div>',
  );
});

test("widths follow six columns and fold on the dashboard's own width at 1000 and 600 px", () => {
  const flat = css.replace(/\s+/g, " ");
  expect(flat).toContain("container: k2b-dashboard / inline-size;");
  expect(flat).toContain("grid-template-columns: repeat(6, minmax(0, 1fr));");
  for (const [width, span] of [
    ["half", 3],
    ["twoThirds", 4],
    ["full", 6],
  ] as const)
    expect(flat).toContain(`.k2b-dashboard-section__grid > .k2b-dashboard-panel[data-width="${width}"] { grid-column: span ${span}; }`);
  expect(flat).toContain(
    '@container k2b-dashboard (max-width: 1000px) { .k2b-ui .k2b-dashboard-section__grid > .k2b-dashboard-panel[data-width="third"] { grid-column: span 3; } .k2b-ui .k2b-dashboard-section__grid > .k2b-dashboard-panel[data-width="twoThirds"] { grid-column: span 6; } }',
  );
  expect(flat).toContain("@container k2b-dashboard (max-width: 600px)");
  // A dashboard is never a window-width layout: no media query sizes its panels.
  expect(flat).not.toMatch(/@media[^{]*\{[^}]*k2b-dashboard-panel\[data-width/);
});
