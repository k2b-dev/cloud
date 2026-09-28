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
    name: "Campus-Café",
    icon: "ti ti-coffee",
    slug: "campus-cafe",
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
    expect(html).toContain("take shifts, add free time · public page active");
    expect(html).toContain("Front desk");
    expect(html).toContain("Viewer");
    expect(html).not.toContain("k2b-app-overview__aside");
  });

  test("offers the templates and a blank start in the first empty state, without a search", () => {
    const html = render([]);

    expect(html).toContain("No venues yet");
    expect(html).toContain("New venue");
    expect(html).not.toContain("k2b-app-overview__cards");
    expect(html).not.toContain('name="venue-search"');
    const actions = html.slice(html.indexOf("data-venue-empty-actions"));
    expect(actions).toContain("Café");
    expect(actions).toContain("Start blank");
  });

  test("shows the search once there is a venue", () => {
    expect(render([venue({})])).toContain('name="venue-search"');
  });

  test("keeps a search without matches resettable", () => {
    const html = render([venue({})], "nothing");

    expect(html).toContain("Clear search");
    expect(html).not.toContain('href="/app/venue/Cafe01"');
  });
});
