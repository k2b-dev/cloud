import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import type { GeoAddress, GeoAvailabilityData } from "@k2b/cloud/contracts/geo";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { appHostCss } from "../../../../ui/test/app-host-fixture";
import type { Contact, ContactAddressLocateResult } from "../../service";
import type { ContactAddressInput } from "../../service/types";
import "./ssr-test-plugin";

/** Fictional fixtures only. Jana Berger and her address appear in the approved mockup. */
const now = "2026-10-22T10:00:00.000Z";
// Contacts' configured app accent, including the derived variables supplied by Cloud's page shell.
const contactsAccent =
  "--app-accent:#4f46e5;--app-ink-light:#4f46e5;--app-ink-dark:#8e89ee;--app-selected-light:#f3f2fd;--app-selected-dark:#1a1c37;--app-selected-nav-light:#ededfc;--app-selected-nav-dark:#1c1d3d";

const addressLocationKey = (address: Pick<ContactAddressInput, "line1" | "postalCode" | "city" | "stateRegion" | "countryCode">) =>
  [address.line1, address.postalCode, address.city, address.stateRegion, address.countryCode]
    .map((value) => (value ?? "").trim().toLowerCase().replace(/\s+/g, " "))
    .join("\n");
const provenance = {
  provider: "geoapify" as const,
  attribution: { text: "Geoapify · OpenStreetMap" as const, links: ["https://geoapify.com", "https://www.openstreetmap.org/copyright"] },
  computedAt: now,
};
export const janaPoint = { lat: 48.39841, lon: 9.99155 };
export const jana = (location: Contact["addresses"][number]["location"] = null): Contact => ({
  id: "jana",
  bookId: "team",
  label: null,
  firstName: "Jana",
  lastName: "Berger",
  companyName: "Hoffmann Druck GmbH",
  department: null,
  jobTitle: "Kundenberaterin",
  vatId: null,
  birthday: null,
  salutation: null,
  pronouns: null,
  preferredLanguage: null,
  source: null,
  createdAt: now,
  updatedAt: now,
  emails: [
    {
      id: "e1",
      contactId: "jana",
      label: "Geschäftlich",
      email: "jana.berger@hoffmann-druck.example",
      position: 0,
      createdAt: now,
      updatedAt: now,
    },
  ],
  phones: [{ id: "p1", contactId: "jana", label: "Geschäftlich", phone: "0731 123 456 78", position: 0, createdAt: now, updatedAt: now }],
  addresses: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      contactId: "jana",
      label: "Geschäftlich",
      recipientName: null,
      companyName: null,
      line1: "Frauenstraße 28",
      line2: null,
      postalCode: "89073",
      city: "Ulm",
      stateRegion: null,
      countryCode: "DE",
      location,
      position: 0,
      createdAt: now,
      updatedAt: now,
    },
  ],
  websites: [],
  bankAccounts: [],
  parentContactId: null,
  parent: null,
  members: [],
  tags: [],
});
export const found = { status: "found" as const, point: janaPoint, provenance };
export const suggestions: GeoAddress[] = [
  ["Frauenstraße 28", "89073", "Ulm"],
  ["Frauenstraße 28", "89079", "Ulm-Wiblingen"],
  ["Frauenstraße 2", "89073", "Ulm"],
  ["Frauengraben 28", "89073", "Ulm"],
  ["Frauenstraße 28", "88400", "Biberach an der Riß"],
].map(([line1, postalCode, city], index) => ({
  line1: line1!,
  postalCode: postalCode!,
  city: city!,
  stateRegion: "Baden-Württemberg",
  countryCode: "DE",
  point: { lat: janaPoint.lat + index / 100, lon: janaPoint.lon },
  formatted: `${line1}, ${postalCode} ${city}, Deutschland`,
  confidence: 1,
  buildingConfidence: 1,
  provenance,
}));
const open = { exhausted: false, resetsAt: "2026-10-22T22:00:00.000Z" };
export const availability = {
  configured: { configured: true, person: open, cloud: { exhausted: false, resetsAt: "2026-10-31T23:00:00.000Z" } },
  off: { configured: false, person: open, cloud: { exhausted: false, resetsAt: "2026-10-31T23:00:00.000Z" } },
  person: { configured: true, person: { ...open, exhausted: true }, cloud: { exhausted: false, resetsAt: "2026-10-31T23:00:00.000Z" } },
  cloud: { configured: true, person: open, cloud: { exhausted: true, resetsAt: "2026-10-31T23:00:00.000Z" } },
} satisfies Record<string, GeoAvailabilityData>;

export type Scenario = {
  view: "detail" | "form" | "workspace";
  initialAddressId?: string | null;
  /** A narrow application host beside another Cloud panel, independent of viewport width. */
  hostWidth?: number;
  href?: string;
  contacts?: Contact[];
  readonly?: boolean;
  contact: Contact;
  availability?: GeoAvailabilityData;
};
/** What the stub Core and Contacts APIs answer; tests change it between steps. */
export type StubState = {
  autocomplete: "ok" | "empty" | "error" | "budget";
  locate: ContactAddressLocateResult | "error";
  /** Holds locate answers until released, to see the reserved place. */
  holdLocate: boolean;
  autocompleteRequests: string[];
  locateRequests: number;
  /** Bodies of contact saves. */
  saves: unknown[];
  saveStatus: number;
  holdSave: boolean;
};

const { default: ContactDetailPanel } = await import("./ContactDetailPanel.island.tsx");
const { LocaleProvider } = await import("@k2b/ui");
const { default: ContactAddressWorkspace } = await import("./ContactAddressWorkspace.browser-fixture.tsx");
const detailProps = (scenario: Scenario) => ({
  initialContact: scenario.contact,
  initialContactId: scenario.contact.id,
  initialBookId: scenario.contact.bookId,
  initialNotesPage: { items: [], page: 1, perPage: 30, total: 0, hasNext: false },
  contacts: [scenario.contact],
  bookNames: { team: "Kunden" },
  writableBooks: [{ id: "team", name: "Kunden" }],
  adminBookIds: [],
  currentUserId: "user-1",
  showEmpty: false,
  initialFavoriteKeys: [],
  geoAvailability: scenario.availability,
  timeZone: "Europe/Berlin",
});
const serverMarkup = (scenario: Scenario) =>
  scenario.view === "workspace"
    ? renderToString(() =>
        createComponent(LocaleProvider, {
          locale: "de",
          get children() {
            return createComponent(ContactAddressWorkspace, { scenario });
          },
        }),
      )
    : scenario.view === "detail"
      ? renderToString(() =>
          createComponent(LocaleProvider, {
            locale: "de",
            get children() {
              return createComponent(ContactDetailPanel, detailProps(scenario));
            },
          }),
        )
      : "";

const entrySource = `
  import { createComponent } from "solid-js";
  import { render } from "solid-js/web";
  import { LocaleProvider } from "@k2b/ui";
  import ContactDetailPanel from "./ContactDetailPanel.island";
  import ContactUpsertForm from "./ContactUpsertForm";
  import ContactAddressWorkspace from "./ContactAddressWorkspace.browser-fixture";
  const root = document.querySelector("#root");
  const scenario = JSON.parse(root.dataset.scenario);
  await document.fonts.ready;
  window.serverHeight = root.getBoundingClientRect().height;
  const editorSnapshot = () => Array.from(document.querySelectorAll(".contacts-address-editor input"), input => ({value: input.value, box: input.getBoundingClientRect().toJSON()}));
  window.serverEditor = editorSnapshot();
  root.innerHTML = "";
  render(() => createComponent(LocaleProvider, { locale: "de", get children() {
    if (scenario.view === "workspace")
      return createComponent(ContactAddressWorkspace, { scenario });
    return scenario.view === "detail"
      ? createComponent(ContactDetailPanel, scenario.props)
      : createComponent(ContactUpsertForm, { mode: "edit", bookId: "team", initialContact: scenario.contact, title: "Jana Berger bearbeiten", geoAvailability: scenario.availability });
  } }), root);
  window.clientHeight = root.getBoundingClientRect().height;
  window.clientEditor = editorSnapshot();
`;

/** Serves the real Contacts detail and editor with stub Core and Contacts APIs in a browser page. */
export const startContactsGeoHarness = async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "contacts-geo-browser-"));
  const ui = resolve(import.meta.dir, "../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const entry = resolve(import.meta.dir, "ContactAddressGeo.fixture-entry.ts");
  const build = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: entrySource },
    target: "browser",
    format: "esm",
    splitting: true,
    outdir: directory,
    naming: { entry: "entry.js", chunk: "chunk-[hash].js" },
    plugins: [
      {
        name: "solid-contacts-geo",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Contacts geo browser build failed");
  const assets = new Map(await Promise.all(build.outputs.map(async (asset) => [basename(asset.path), await asset.arrayBuffer()] as const)));
  const tabler = resolve(Bun.resolveSync("@tabler/icons-webfont/package.json", ui), "../dist");
  const fontPreset = Bun.resolveSync("@k2b/ui/fonts/plex.css", ui);
  const fontDirectory = resolve(fontPreset, "../fonts");
  const fonts = (await Bun.file(fontPreset).text()).replaceAll("./fonts/", "/fonts/");
  const css = await appHostCss(resolve(import.meta.dir, "../../styles/app.css"));
  const state: StubState = {
    autocomplete: "ok",
    locate: { state: "located", location: found },
    holdLocate: false,
    autocompleteRequests: [],
    locateRequests: 0,
    saves: [],
    saveStatus: 200,
    holdSave: false,
  };
  let releaseSave: () => void = () => {};
  const savedContacts = new Map<string, Contact>();
  let releaseLocate: () => void = () => {};
  const scenarios = new Map<string, Scenario>();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") {
        const storedScenario = scenarios.get(url.searchParams.get("scenario") ?? "");
        const selectedId = url.searchParams.get("contact");
        const scenario = storedScenario && {
          ...storedScenario,
          href: `${url.pathname}${url.search}`,
          initialAddressId: url.searchParams.get("address"),
          contact:
            savedContacts.get(selectedId ?? "") ??
            storedScenario.contacts?.find((contact) => contact.id === selectedId) ??
            storedScenario.contact,
        };
        if (!scenario) return new Response("Unknown scenario", { status: 404 });
        const data = JSON.stringify({ ...scenario, props: detailProps(scenario) }).replaceAll("'", "&#39;");
        return new Response(
          `<!doctype html><html lang="de" class="${request.headers.get("cookie")?.includes("theme=dark") ? "dark" : "light"}"><head><meta charset="utf-8"><link rel="stylesheet" href="/tabler/tabler-icons.min.css"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n${fonts}</style></head><body class="k2b-ui app-accent-scope" style="${contactsAccent}"><main style="${scenario.hostWidth ? `width:${scenario.hostWidth}px;container:k2b-app-area / inline-size;` : ""}max-width:${scenario.view === "workspace" ? "none" : scenario.view === "detail" ? "640px" : "760px"};margin:0 auto;padding:${scenario.view === "workspace" ? 0 : 16}px;height:100dvh;display:flex;flex-direction:column"><div id="root" style="flex:1;min-height:0;display:flex;flex-direction:column" data-scenario='${data}'>${serverMarkup(scenario)}</div></main><script type="module" src="/entry.js"></script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        );
      }
      if (url.pathname === "/api/capabilities/v1/queries/core/address.autocomplete") {
        const body = (await request.json()) as { input: { text: string } };
        state.autocompleteRequests.push(body.input.text);
        await Bun.sleep(120);
        if (state.autocomplete === "budget")
          return Response.json(
            {
              code: "GEO_BUDGET_EXHAUSTED",
              message: "Budget exhausted",
              details: { code: "GEO_BUDGET_EXHAUSTED", scope: "person", resetsAt: "2026-10-22T22:00:00.000Z" },
            },
            { status: 429 },
          );
        if (state.autocomplete === "error")
          return Response.json({ code: "GEO_PROVIDER_FAILED", message: "Provider failed" }, { status: 502 });
        return Response.json({ data: { suggestions: state.autocomplete === "empty" ? [] : suggestions, provenance } });
      }
      if (url.pathname.endsWith("/locate") && request.method === "POST") {
        state.locateRequests += 1;
        if (state.holdLocate) await new Promise<void>((resolve) => (releaseLocate = resolve));
        const match = url.pathname.match(/\/contacts\/([^/]+)\/addresses\/([^/]+)\/locate$/);
        const contactId = match?.[1];
        const contact = contactId
          ? (savedContacts.get(contactId) ??
            [...scenarios.values()]
              .flatMap((scenario) => scenario.contacts ?? [scenario.contact])
              .find((contact) => contact.id === contactId))
          : undefined;
        if (contact && state.locate !== "error" && state.locate.state === "located") {
          const location = state.locate.location;
          savedContacts.set(contact.id, {
            ...contact,
            addresses: contact.addresses.map((address) => (address.id === match?.[2] ? { ...address, location } : address)),
          });
        }
        return state.locate === "error" ? Response.json({ message: "Failed" }, { status: 500 }) : Response.json(state.locate);
      }
      if (url.pathname.startsWith("/fonts/")) return new Response(Bun.file(resolve(fontDirectory, basename(url.pathname))));
      if (url.pathname.startsWith("/tabler/")) return new Response(Bun.file(resolve(tabler, url.pathname.slice("/tabler/".length))));
      if (url.pathname === "/api/contacts/books/team/contacts") {
        const referrer = new URL(request.headers.get("referer") ?? "/", server.url);
        const scenario = scenarios.get(referrer.searchParams.get("scenario") ?? "");
        const query = (url.searchParams.get("q") ?? "").toLocaleLowerCase("de");
        const people = scenario ? (scenario.contacts ?? [scenario.contact]) : [];
        const contacts =
          url.searchParams.get("favorites") === "true"
            ? []
            : people.filter((contact) => `${contact.firstName} ${contact.lastName}`.toLocaleLowerCase("de").includes(query));
        return Response.json({
          data: contacts,
          favoriteKeys: [],
          pagination: { total: contacts.length, page: 1, per_page: 30, total_pages: 1 },
        });
      }
      if (url.pathname === "/api/contacts/books/team/tags") return Response.json([]);
      const contactMatch = url.pathname.match(/^\/api\/contacts\/books\/team\/contacts\/([^/]+)$/);
      const contactId = contactMatch?.[1];
      const storedContact = contactId
        ? (savedContacts.get(contactId) ??
          [...scenarios.values()]
            .flatMap((scenario) => scenario.contacts ?? [scenario.contact])
            .find((contact) => contact.id === contactId))
        : undefined;
      if (storedContact && request.method === "PATCH") {
        const body: { addresses: ContactAddressInput[] } = await request.json();
        state.saves.push(body);
        if (state.holdSave) await new Promise<void>((resolve) => (releaseSave = resolve));
        if (state.saveStatus !== 200)
          return Response.json(
            { message: state.saveStatus === 409 ? "Kontakt wurde inzwischen geändert" : "Speichern fehlgeschlagen" },
            { status: state.saveStatus },
          );
        const updated = {
          ...storedContact,
          addresses: body.addresses.map((address, index) => {
            const previous = storedContact.addresses[index];
            if (!previous) throw new Error("The focused address fixture cannot append addresses");
            return {
              ...previous,
              ...address,
              location: address.location
                ? { status: "found" as const, ...address.location }
                : (storedContact.addresses.find((previous) => addressLocationKey(previous) === addressLocationKey(address))?.location ??
                  null),
            };
          }),
          updatedAt: "2026-10-22T10:01:00.000Z",
        };
        savedContacts.set(storedContact.id, updated);
        return Response.json(updated);
      }
      if (storedContact) return Response.json(storedContact);
      if (url.pathname.startsWith("/api/contacts/favorites/")) return Response.json({ favorite: false });
      if (url.pathname.endsWith("/notes")) return Response.json({ items: [], page: 1, perPage: 30, total: 0, hasNext: false });
      if (url.pathname === "/api/geo/style")
        return Response.json({
          version: 8,
          sources: {},
          layers: [
            {
              id: "land",
              type: "background",
              paint: { "background-color": url.searchParams.get("theme") === "dark" ? "#20252a" : "#f1efe9" },
            },
          ],
        });
      if (/^\/map-view-worker(?:-[a-z0-9]+)?\.js$/.test(url.pathname))
        return new Response(Bun.file(resolve(ui, "dist/browser/content/map-view-worker.js")), {
          headers: { "Content-Type": "application/javascript" },
        });
      const asset = assets.get(url.pathname.slice(1));
      return asset ? new Response(asset, { headers: { "Content-Type": "application/javascript" } }) : Response.json({}, { status: 404 });
    },
  });
  return {
    url: (name: string, scenario: Scenario) => {
      scenarios.set(name, scenario);
      return `${server.url.origin}/?scenario=${encodeURIComponent(name)}&contact=${scenario.contact.id}&contactBook=team${scenario.initialAddressId ? `&address=${scenario.initialAddressId}` : ""}`;
    },
    state,
    reset: () => {
      savedContacts.clear();
      scenarios.clear();
    },
    setContact: (contact: Contact) => savedContacts.set(contact.id, contact),
    releaseLocate: () => releaseLocate(),
    releaseSave: () => releaseSave(),
    stop: async () => {
      releaseLocate();
      releaseSave();
      await server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    },
  };
};
