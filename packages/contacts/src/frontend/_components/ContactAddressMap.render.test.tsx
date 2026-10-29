import { describe, expect, test } from "bun:test";
import type { GeoAvailabilityData } from "@k2b/cloud/contracts/geo";
import { renderToString } from "solid-js/web";
import type { ContactAddress } from "../../service";
import "./ssr-test-plugin";

const { default: ContactAddressMap, initialAddressMapView } = await import("./ContactAddressMap.tsx");
const { LocaleProvider } = await import("@k2b/ui");

const provenance = {
  provider: "geoapify" as const,
  attribution: { text: "Geoapify · OpenStreetMap" as const, links: ["https://geoapify.com", "https://www.openstreetmap.org/copyright"] },
  computedAt: "2026-10-22T10:00:00.000Z",
};
const address: ContactAddress = {
  id: "11111111-1111-4111-8111-111111111111",
  contactId: "jana",
  label: "Business",
  recipientName: null,
  companyName: null,
  line1: "Frauenstraße 28",
  line2: null,
  postalCode: "89073",
  city: "Ulm",
  stateRegion: null,
  countryCode: "DE",
  location: null,
  position: 0,
  createdAt: "2026-10-22T10:00:00.000Z",
  updatedAt: "2026-10-22T10:00:00.000Z",
};
const open = { exhausted: false, resetsAt: "2026-10-22T22:00:00.000Z" };
const configured: GeoAvailabilityData = { configured: true, person: open, cloud: { ...open, resetsAt: "2026-10-31T23:00:00.000Z" } };

const render = (props: { address?: ContactAddress; availability?: GeoAvailabilityData; locale?: string; canEdit?: boolean }) =>
  renderToString(() => (
    <LocaleProvider locale={props.locale ?? "de"}>
      <ContactAddressMap
        bookId="team"
        contactId="jana"
        contactName="Jana Berger"
        address={props.address ?? address}
        availability={props.availability}
        timeZone="Europe/Berlin"
        canEdit={props.canEdit ?? true}
        onEdit={() => {}}
      />
    </LocaleProvider>
  ));

describe("contact address map", () => {
  test("the first render follows Core's setup and budget before the stored location", () => {
    const found = { ...address, location: { status: "found" as const, point: { lat: 48.4, lon: 9.99 }, provenance } };
    expect(initialAddressMapView(found, { ...configured, configured: false })).toEqual({ kind: "off" });
    expect(initialAddressMapView(found, { ...configured, person: { ...open, exhausted: true } })).toMatchObject({
      kind: "budget",
      scope: "person",
    });
    expect(initialAddressMapView(found, { ...configured, cloud: { ...configured.cloud, exhausted: true } })).toMatchObject({
      kind: "budget",
      scope: "cloud",
    });
    expect(initialAddressMapView(found, configured)).toEqual({ kind: "found", point: { lat: 48.4, lon: 9.99 } });
    expect(initialAddressMapView({ location: { status: "not_found", checkedAt: "2026-10-22T10:00:00.000Z" } }, configured)).toEqual({
      kind: "not_found",
    });
    expect(initialAddressMapView(address, configured)).toEqual({ kind: "locating" });
    expect(initialAddressMapView(address)).toEqual({ kind: "locating" });
  });

  test("a pending address reserves the map place and the route uses the address text", () => {
    const html = render({ availability: configured });
    expect(html).toContain("height:160px");
    expect(html).toContain("Karte lädt …");
    expect(html).toContain("Route planen");
    expect(html).toContain("https://www.openstreetmap.org/search?query=Frauenstra%C3%9Fe%2028%2C%2089073%20Ulm%2C%20DE");
    expect(html).toContain("Bearbeiten");
  });

  test("a found address shows its pin, attribution and a route to the point", () => {
    const html = render({
      address: { ...address, location: { status: "found", point: { lat: 48.4, lon: 9.99 }, provenance } },
      availability: configured,
      canEdit: false,
    });
    expect(html).toContain("k2b-map-view__pin");
    expect(html).toContain("OpenStreetMap");
    expect(html).toContain("https://www.openstreetmap.org/directions?route=%3B48.4%2C9.99");
    expect(html).not.toContain("Karte lädt");
    expect(html).not.toContain("Bearbeiten");
  });

  test("not found and budget states speak calmly inside the reserved place", () => {
    expect(
      render({
        address: { ...address, location: { status: "not_found", checkedAt: "2026-10-22T10:00:00.000Z" } },
        availability: configured,
      }),
    ).toContain("Für diese Adresse kennt die Ortssuche keinen Punkt");
    expect(render({ availability: { ...configured, person: { ...open, exhausted: true } } })).toContain(
      "Karte heute nicht verfügbar, ab 0:00 Uhr wieder",
    );
    expect(render({ availability: { ...configured, cloud: { exhausted: true, resetsAt: "2026-10-31T23:00:00.000Z" } } })).toContain(
      "Karte bis 1. November, 0:00 Uhr, nicht verfügbar",
    );
  });

  test("without a configured geo service there is no map and no notice, only the route by text", () => {
    const html = render({ availability: { ...configured, configured: false } });
    expect(html).not.toContain("k2b-map-view");
    expect(html).not.toContain("Karte");
    expect(html).toContain("Route planen");
    expect(html).toContain("openstreetmap.org/search");
  });
});
