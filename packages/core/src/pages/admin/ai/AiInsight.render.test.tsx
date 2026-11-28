import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { toJSON } from "seroval";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";

// KI › Nutzung and Budgets › Nutzung je Person as the server renders them: names, figures and every drill-down link are
// in the first picture, missing measurements stay distinct from zero, and nothing waits for a loader.
const root = mkdtempSync(resolve(tmpdir(), "core-ai-insight-render-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { LocaleProvider } = await import("@k2b/ui");
const { adminNavFixture } = await import("../admin-v2.fixture");
const { default: UsageScreen } = await import("./UsageScreen");
const { default: PeopleScreen } = await import("./PeopleScreen");
const { usageFixture, peopleFixture } = await import("./fixture-insight");

const ADA = "11111111-0000-4000-8000-000000000000";
const nav = adminNavFixture("/admin/ai");
const render = (locale: "de" | "en", screen: () => JSX.Element) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return screen();
      },
    }),
  );
const input = (query: string, locale: "de" | "en" = "en", state = "normal") => ({ state, locale, params: new URLSearchParams(query) });
/** The island's props as the server serializes them into `data-props` (`JSON.stringify(toJSON(props))`), in bytes. */
const islandBytes = (props: object) => Buffer.byteLength(JSON.stringify(toJSON(props)));

describe("usage explorer", () => {
  for (const locale of ["en", "de"] as const)
    test(`comparisons in ${locale}: people with their drill-down into failed runs and negative ratings, filters as statements`, () => {
      const data = usageFixture(input(`sec=usage&view=comparisons&userId=${ADA}`, locale));
      const html = render(locale, () => createComponent(UsageScreen, { nav, data }));
      expect(html).toContain("Ada Renz");
      expect(html).toContain('data-k2-part="FilterBar"');
      expect(html).toContain(`userId=${ADA}`);
      expect(html).toContain("rating=down");
      expect(html).toContain("status=failed");
      expect(html).not.toContain("cortecs/gpt-oss-120b");
      expect(html).toContain(locale === "de" ? "Bewertungsabdeckung" : "Response rating coverage");
      expect(html).not.toContain('data-k2-part="Loading"');
    });

  test("runs show failures in their colour, unassigned runs by name, and the open run with its stored error", () => {
    const data = usageFixture(input("sec=usage&view=runs&run=background:44444444-0000-4000-8000-000000000002"));
    const html = render("en", () => createComponent(UsageScreen, { nav, data }));
    expect(html).toContain("Failed");
    expect(html).toContain("Unassigned");
    expect(html).toContain("Stored error");
    expect(html).toContain("Der Anbieter antwortete mit 502 Bad Gateway.");
    // a run without measured tokens or costs shows "—", never 0
    expect(html).toContain("—");
  });

  test("an empty period says so where the charts would stand", () => {
    const data = usageFixture(input("sec=usage", "en", "empty"));
    const html = render("en", () => createComponent(UsageScreen, { nav, data }));
    expect(html).toContain("No priced calls in this period.");
    expect(html).toContain("No AI turns in this range.");
  });

  test("each view hands its island only its own parts of the report, within a measured budget", () => {
    const views = {
      overview: "sec=usage",
      people: "sec=usage&view=comparisons",
      models: "sec=usage&view=comparisons&compare=models",
      feedback: "sec=usage&view=feedback",
      runs: "sec=usage&view=runs",
    };
    const measure = (state: string) =>
      Object.fromEntries(
        Object.entries(views).map(([name, query]) => {
          const data = usageFixture(input(query, "de", state));
          // the view still draws from its own parts alone
          expect(render("de", () => createComponent(UsageScreen, { nav, data }))).toContain('data-k2-part="FilterBar"');
          return [name, islandBytes({ nav, data })];
        }),
      );
    const sizes = { normal: measure("normal"), worst: measure("worst") };
    console.log(JSON.stringify({ islandBytes: sizes }));
    // With every view's parts the island carried 77 KB on each view, 176 KB in the worst case. Now a view carries its
    // own: the overview its charts' days and side tables, a comparison or Feedback one page of rows, Runs one page of
    // runs with what an open run shows beside them (40 runs; 100 with long errors in the worst case).
    const budget = { normal: { runs: 56_000, other: 20_000 }, worst: { runs: 128_000, other: 48_000 } };
    for (const state of ["normal", "worst"] as const)
      for (const [name, bytes] of Object.entries(sizes[state])) {
        const limit = name === "runs" ? budget[state].runs : budget[state].other;
        expect({ state, name, within: bytes <= limit }).toEqual({ state, name, within: true });
      }
  });
});

describe("use per person", () => {
  for (const locale of ["en", "de"] as const)
    test(`accounts with their tightest allowance as a bar in ${locale}; the open account with its allowances`, () => {
      const data = peopleFixture(input(`sec=budgets&rule=people&identity=${ADA}&identityType=user`, locale));
      const html = render(locale, () => createComponent(PeopleScreen, { nav, data }));
      expect(html).toContain("Mira Solberg");
      expect(html).toContain('data-k2-part="Progress"');
      expect(html).toContain(locale === "de" ? "Aktuelle Kontingente" : "Current allowances");
      expect(html).toContain(locale === "de" ? "Alle angemeldeten Nutzer" : "All signed-in users");
      expect(html).toContain(locale === "de" ? "Kontingent zurücksetzen" : "Reset allowance");
      expect(html).toContain("sec=usage&amp;view=comparisons");
      expect(html).not.toContain("NaN");
    });

  test("pages keep the search and the model filter", () => {
    const data = peopleFixture(input("sec=budgets&rule=people&search=Ada&model=claude", "en", "worst"));
    const html = render("en", () => createComponent(PeopleScreen, { nav, data }));
    const next = html.match(/href="([^"]*page=2[^"]*)"/)?.[1] ?? "";
    expect(next).toContain("search=Ada");
    expect(next).toContain("model=claude");
    expect(next).toContain("rule=people");
  });
});
