import { describe, expect, test } from "bun:test";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { Venue } from "../../contracts";
import "../ssr-test-plugin";

const { default: VenueOverview } = await import("./VenueOverview.island.tsx");

const venue = (overrides: Partial<Venue>): Venue =>
  ({
    id: "Cafe01",
    name: "StuVe Café",
    icon: "ti ti-coffee",
    slug: "stuve-cafe",
    description: null,
    signupMode: "both",
    publicEnabled: true,
    permission: "admin",
    accentColor: "#2563eb",
    ...overrides,
  }) as Venue;

const render = (venues: Venue[], initialQuery = "") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(VenueOverview, {
          venues,
          templates: [{ id: "cafe", name: "Café", description: "Opening hours and shifts", icon: "ti ti-coffee" }],
          initialQuery,
        });
      },
    }),
  );

describe("Venue overview", () => {
  test("renders venues as cards under one page header with a single create menu", () => {
    const html = render([venue({}), venue({ id: "Desk01", name: "Service desk", permission: "read", description: "Front desk" })]);

    expect(html).toMatch(/<h1 class="k2b-panel-header__title is-large">Venues<\/h1>/);
    expect(html).toContain("2 venues available");
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(1);
    expect(html).toContain("New venue");
    expect(html).toContain("Blank venue");
    expect(html).toContain("Opening hours and shifts");
    expect(html).toContain("k2b-app-overview__cards");
    expect(html).toContain('href="/app/venue/Cafe01"');
    expect(html).toContain("shift + free signup · public page active");
    expect(html).toContain("Front desk");
    expect(html).toContain("Viewer");
    expect(html).not.toContain("k2b-app-overview__aside");
  });

  test("offers the create menu from the empty state page", () => {
    const html = render([]);

    expect(html).toContain("No venues yet");
    expect(html).toContain("Create your first venue to start scheduling.");
    expect(html).toContain("New venue");
    expect(html).not.toContain("k2b-app-overview__cards");
  });

  test("keeps a search without matches resettable", () => {
    const html = render([venue({})], "nothing");

    expect(html).toContain("Clear search");
    expect(html).not.toContain('href="/app/venue/Cafe01"');
  });
});
