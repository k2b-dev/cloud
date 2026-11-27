import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";

// My apps on v2 always shows its exceptions as chips, so a chip filters the list at any number of apps, also below
// v1's FILTER_FROM (review r7 of #4280: with 3 apps the chip was pressed and nothing changed).
const bootstrap = createDomTestHarness();
const fixtures = await import("../code-overview.fixture");
const { cardStatus, needsPerson } = await import("../code-overview");
const { FILTER_FROM } = await import("../code-overview-view");
const { default: AppsV2 } = await import("./AssistantAppsV2");
const { LocaleProvider } = await import("@k2b/ui");
bootstrap.cleanup();

beforeAll(() => setSystemTime(new Date(fixtures.FIXTURE_NOW)));
afterAll(() => setSystemTime());

test("with 3 apps the chip 'braucht dich' shows only the app that needs the person, and pressed again all three", async () => {
  const dom = createDomTestHarness();
  try {
    const all = fixtures.myAppsFixture("normal").initial!.items;
    const needing = all.find((item) => needsPerson(cardStatus(item)))!;
    const items = [needing, ...all.filter((item) => item !== needing).slice(0, 2)];
    expect(items.length).toBeLessThan(FILTER_FROM);
    const dispose = render(
      () => (
        <LocaleProvider locale="de">
          <AppsV2 userId="fixture" timeZone={fixtures.FIXTURE_TIME_ZONE} initial={{ items, nextCursor: null }} />
        </LocaleProvider>
      ),
      dom.root,
    );
    const rows = () => [...dom.root.querySelectorAll('[data-k2-part="Table"] tbody tr')].map((row) => row.textContent ?? "");
    const chip = () => [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.includes("braucht dich"));
    expect(rows()).toHaveLength(3);
    chip()!.click();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain(needing.title);
    expect(chip()!.getAttribute("aria-pressed")).toBe("true");
    chip()!.click();
    expect(rows()).toHaveLength(3);
    dispose();
  } finally {
    dom.cleanup();
  }
});
