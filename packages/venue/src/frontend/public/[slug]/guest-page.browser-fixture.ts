// Invented venues for the guest page's render and browser tests and their pictures, as the approved mockup draws them.
// The fixture day is Saturday, 28 November 2026, in Europe/Berlin; each state is the same venue at another instant,
// and the hero's facts come from the real availability rules, so the tests read what the server would send.
import { buildPublicAvailability } from "../../../availability";
import type { DateOverride, OpeningRule, PublicSection, PublicStatus, Venue } from "../../../contracts";

const stamp = "2026-11-01T09:00:00.000Z";
const zone = "Europe/Berlin";

/** A local time on the fixture day (UTC+1 in November) as an instant. */
export const saturdayAt = (time: string) => new Date(`2026-11-28T${time}:00+01:00`);

const svg = (markup: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

const cafeLogo = svg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#fff"/><circle cx="32" cy="32" r="24" fill="#c2410c"/><path d="M21 27h18v8a8 8 0 0 1-8 8h-2a8 8 0 0 1-8-8z" fill="#fff"/><path d="M39 29h3a4 4 0 0 1 0 8h-3" fill="none" stroke="#fff" stroke-width="3"/></svg>',
);
const plate = (food: string, ground: string) =>
  svg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${ground}"/><circle cx="32" cy="34" r="25" fill="#fafaf9"/><circle cx="32" cy="34" r="18" fill="${food}"/><circle cx="25" cy="30" r="5" fill="#fff" opacity=".55"/></svg>`,
  );

const venue = (id: string, fields: Partial<Venue> & Pick<Venue, "name" | "accentColor">): Venue => ({
  id,
  slug: id.toLowerCase(),
  icon: "ti ti-building-store",
  description: null,
  timezone: zone,
  openMode: "regular",
  signupMode: "both",
  publicEnabled: true,
  feedbackEnabled: true,
  logoBase64: null,
  bannerBase64: null,
  permission: "none",
  createdAt: stamp,
  updatedAt: stamp,
  ...fields,
});

/** The week as the admin entered it, Monday first: each day's windows as `HH:MM–HH:MM`, with an optional note. */
const week = (venueId: string, days: readonly (readonly string[])[]): OpeningRule[] =>
  days.flatMap((windows, index) =>
    windows.map((window, position) => {
      const [range, note] = window.split(" · ");
      const [startTime, endTime] = range!.split("–") as [string, string];
      return {
        id: `R${venueId.slice(0, 2)}${index}${position}x`.slice(0, 6),
        venueId,
        weekday: (index + 1) % 7,
        startTime,
        endTime,
        note: note ?? null,
        position,
        createdAt: stamp,
        updatedAt: stamp,
      };
    }),
  );

const change = (venueId: string, date: string, kind: "closed" | "open", note: string, window?: string): DateOverride => {
  const [startTime, endTime] = window ? (window.split("–") as [string, string]) : [null, null];
  return {
    id: `O${date.slice(5).replace("-", "")}x`.slice(0, 6),
    venueId,
    date,
    kind,
    startTime,
    endTime,
    note,
    createdAt: stamp,
    updatedAt: stamp,
  };
};

let sectionCount = 0;
const section = (venueId: string, kind: PublicSection["kind"], title: string, content: Record<string, unknown>): PublicSection => {
  sectionCount += 1;
  return {
    id: `S${String(sectionCount).padStart(5, "0")}`,
    venueId,
    kind,
    title,
    content,
    enabled: true,
    position: sectionCount,
    createdAt: stamp,
    updatedAt: stamp,
  };
};

type Fixture = { venue: Venue; rules: OpeningRule[]; changes: DateOverride[]; sections: PublicSection[] };

/** The status the server would send for `fixture` at `now`. */
export const statusAt = (fixture: Fixture, now: Date, overrides: Partial<PublicStatus> = {}): PublicStatus => {
  const availability = buildPublicAvailability({
    venue: fixture.venue,
    openingRules: fixture.rules,
    overrides: fixture.changes,
    templates: [],
    assignments: [],
    now,
    days: 14,
    locale: "de",
  });
  return {
    venue: fixture.venue,
    ...availability,
    statusLabel: availability.open ? "Geöffnet" : "Geschlossen",
    openingRules: fixture.rules,
    sections: fixture.sections,
    ...overrides,
  };
};

export const cafe: Fixture = (() => {
  const id = "Cafe01";
  return {
    venue: venue(id, { name: "Campus-Café Nord", accentColor: "#c2410c", icon: "ti ti-cup", logoBase64: cafeLogo }),
    rules: week(id, [["08:00–18:00"], ["08:00–18:00"], ["08:00–18:00"], ["08:00–18:00"], ["08:00–16:00"], ["10:00–15:00"], []]),
    changes: [
      change(id, "2026-12-03", "closed", "Personalversammlung"),
      change(id, "2026-12-11", "open", "Weihnachtsmarkt am Campus", "18:00–23:00"),
      change(id, "2026-12-24", "closed", "Heiligabend"),
    ],
    sections: [
      section(id, "notice", "Ab 1. Dezember nur noch Pfandbecher", {
        text: "Kaffee zum Mitnehmen gibt es dann im Mehrwegbecher für 1 € Pfand. Eigene Becher bleiben willkommen.",
      }),
      section(id, "menu", "Heute auf der Karte", {
        items: [
          {
            name: "Linsen-Dal mit Basmatireis",
            description: "Rote Linsen, Kokosmilch, frischer Koriander",
            info: "vegan · Allergene: 9",
            price: "4,20 €",
            image: plate("#ea9a2b", "#fde7c7"),
          },
          {
            name: "Ofenkartoffel mit Kräuterquark",
            description: "Rosmarin, Schnittlauch, kleiner Gurkensalat",
            info: "vegetarisch · Allergene: G",
            price: "3,80 €",
            image: plate("#d6b48a", "#efe4d3"),
          },
          {
            name: "Hähnchen-Wrap Sweet Chili",
            description: "Salat, Paprika, Joghurtsoße",
            info: "Allergene: A, G, 3",
            price: "5,10 €",
            image: plate("#e7c98f", "#f5ecd9"),
          },
          { name: "Tagessuppe: Kürbis-Ingwer", description: "mit Kürbiskernen und Brot", info: "vegan · Allergene: A", price: "2,90 €" },
        ],
      }),
      section(id, "menu", "Kaffee und Getränke", {
        items: [
          { name: "Espresso", price: "1,60 €" },
          { name: "Cappuccino", description: "Hafermilch ohne Aufpreis", price: "2,40 €" },
          { name: "Filterkaffee", description: "Nachfüllen gratis", price: "1,80 €" },
          { name: "Chai Latte", price: "2,80 €" },
          { name: "Hausgemachte Zitronenlimo", description: "0,4 l, im Pfandglas", price: "2,50 €" },
        ],
      }),
      section(id, "markdown", "Über uns", {
        markdown:
          "Das Campus-Café Nord wird von rund **40 Studierenden** ehrenamtlich betrieben. Alles, was übrig bleibt, geht abends an die Tafel.\n\n- Steckdosen an jedem Fenstertisch\n- Ruhiger Lernraum im Obergeschoss\n- Eigener Becher? 20 Cent günstiger.",
      }),
      section(id, "links", "Kontakt und Wege", {
        links: [
          { label: "Lageplan: Gebäude N2, Erdgeschoss", href: "https://campus.example.org/lageplan/n2" },
          { label: "Anrufen", href: "tel:+493012345678" },
          { label: "E-Mail an das Team", href: "mailto:cafe-nord@example.org" },
          { label: "Instagram", href: "https://instagram.example/campuscafenord" },
        ],
      }),
    ],
  };
})();

export const bar: Fixture = (() => {
  const id = "Bar001";
  return {
    venue: venue(id, { name: "Kellerbar", accentColor: "#9333ea", icon: "ti ti-glass-full" }),
    rules: week(id, [[], [], ["19:00–24:00"], ["20:00–24:00"], ["20:00–24:00"], ["20:00–24:00"], []]),
    changes: [
      change(id, "2026-12-02", "closed", "Geschlossene Gesellschaft"),
      change(id, "2026-12-06", "open", "Nikolaus-Quiz", "18:00–24:00"),
    ],
    sections: [
      section(id, "markdown", "Heute: Kneipenquiz", {
        markdown: "Ab **21:00** raten wir wieder. Teams bis sechs Leute, Anmeldung an der Theke. Der Gewinn: eine Runde aufs Haus.",
      }),
      section(id, "menu", "Getränke", {
        items: [
          { name: "Pils vom Fass", description: "0,3 l", price: "2,80 €" },
          { name: "Weinschorle", description: "0,4 l, weiß oder rot", price: "3,50 €" },
          { name: "Mate", description: "0,5 l Flasche", price: "2,50 €" },
          { name: "Hausmischung „Kellerlicht“", description: "Ingwer, Zitrone, Tonic – ohne Alkohol", price: "3,90 €" },
        ],
      }),
      section(id, "notice", "Einlass ab 18", {
        text: "Bitte bring einen Ausweis mit. Ohne Ausweis können wir dich leider nicht reinlassen.",
      }),
      section(id, "links", "Kontakt", {
        links: [
          { label: "Programm und Fotos", href: "https://kellerbar.example.org" },
          { label: "Raum mieten", href: "mailto:kontakt@kellerbar.example.org" },
        ],
      }),
    ],
  };
})();

/** The worst case: a long name, no logo, split days, a special opening today, eight sections, a long link, emoji. */
export const worst: Fixture = (() => {
  const id = "Worst1";
  return {
    venue: venue(id, {
      name: "Studentisches Kultur- und Begegnungszentrum „Alte Mensa“ – Café, Bar & Veranstaltungsraum im Erdgeschoss",
      accentColor: "#eab308",
      icon: "ti ti-building-community",
      description: "Café am Tag, Bar am Abend, Bühne am Wochenende 🎶 – offen für alle, auch ohne Studierendenausweis.",
    }),
    rules: week(id, [
      ["11:30–14:00 · Mittagstisch", "17:00–22:00"],
      ["11:30–14:00", "17:00–22:00"],
      ["11:30–14:00", "17:00–23:30"],
      ["11:30–14:00", "17:00–22:00"],
      ["11:30–24:00"],
      ["14:00–24:00"],
      ["10:00–13:00"],
    ]),
    changes: [
      change(
        id,
        "2026-11-28",
        "open",
        "Lange Nacht der Wissenschaften – mit Live-Musik im Innenhof und Führungen durch das Haus",
        "18:00–23:00",
      ),
      change(id, "2026-11-30", "closed", "Grundreinigung"),
      change(id, "2026-12-01", "closed", "Grundreinigung"),
      change(id, "2026-12-09", "open", "Frühstück für Erstsemester", "08:00–10:00"),
      change(id, "2026-12-24", "closed", "Heiligabend"),
      change(id, "2026-12-25", "closed", "Weihnachten"),
    ],
    sections: [
      section(
        id,
        "notice",
        "Aufzug außer Betrieb bis voraussichtlich Mitte Dezember – der Veranstaltungsraum im Obergeschoss ist nur über die Treppe erreichbar",
        {
          text: "Wir bitten um Entschuldigung. Für Gäste mit Rollstuhl öffnen wir auf Wunsch den Seiteneingang am Innenhof; ruf uns dafür kurz an.",
        },
      ),
      section(id, "menu", "Mittagstisch", {
        items: [
          {
            name: "Vegane Rote-Bete-Lasagne mit Cashew-Béchamel, Walnüssen und einem kleinen Feldsalat mit Senf-Honig-Dressing",
            description: "Dazu Focaccia vom Bäcker nebenan",
            info: "vegan · Allergene: A, H, 10",
            price: "12,90 €",
            image: plate("#b4235a", "#fbe3ec"),
          },
          {
            name: "Phở",
            description: "Reisnudeln, Brühe, Kräuter",
            info: "Allergene: 6, 9",
            price: "8,50 €",
            image: plate("#d9a441", "#faf0d7"),
          },
          { name: "Brot", price: "1 €" },
        ],
      }),
      section(id, "menu", "Kuchen 🍰", {
        items: [
          { name: "Käsekuchen ohne Boden", price: "2,60 €" },
          { name: "Apfelstreusel", price: "2,40 €" },
        ],
      }),
      section(id, "markdown", "Veranstaltungen", {
        markdown:
          "Das ganze Programm steht im Veranstaltungskalender. Diese Woche: **Lesung** am Mittwoch, **Siebdruck-Workshop** am Donnerstag.",
      }),
      section(id, "links", "Links", {
        links: [
          {
            label: "https://kultur.example.org/veranstaltungen/2026/wintersemester/programm?kategorie=alle&ansicht=liste",
            href: "https://kultur.example.org/veranstaltungen/2026/wintersemester/programm?kategorie=alle&ansicht=liste",
          },
          { label: "Seiteneingang anfragen", href: "tel:+493098765432" },
        ],
      }),
      section(id, "markdown", "Hausordnung", {
        markdown: "Bitte räum dein Geschirr selbst ab. Hunde sind willkommen, nur nicht im Veranstaltungsraum.",
      }),
      section(id, "markdown", "Barrierefreiheit", {
        markdown: "Stufenloser Zugang über den Innenhof, eine barrierefreie Toilette im Erdgeschoss.",
      }),
      section(id, "links", "Spenden", { links: [{ label: "Fördermitglied werden", href: "https://foerderverein.example.org" }] }),
    ],
  };
})();

/** The guest page's states of the mockup, each as the status the server would send. */
export const guestStates = {
  open: () => statusAt(cafe, saturdayAt("12:00")),
  later: () => statusAt(cafe, saturdayAt("08:30")),
  closed: () => statusAt(cafe, saturdayAt("16:00")),
  exception: () =>
    statusAt({ ...cafe, changes: [change(cafe.venue.id, "2026-11-28", "closed", "Inventur"), ...cafe.changes] }, saturdayAt("12:00")),
  nosections: () => statusAt({ ...cafe, sections: [] }, saturdayAt("12:00")),
  nobrand: () => statusAt({ ...cafe, venue: { ...cafe.venue, logoBase64: null } }, saturdayAt("12:00")),
  nofeedback: () => statusAt({ ...cafe, venue: { ...cafe.venue, feedbackEnabled: false } }, saturdayAt("12:00")),
  bar: () => statusAt(bar, saturdayAt("18:00")),
  worst: () => statusAt(worst, saturdayAt("19:00")),
} as const;
export type GuestState = keyof typeof guestStates;
