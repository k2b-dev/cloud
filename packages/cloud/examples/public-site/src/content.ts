export const LOCALES = ["en", "de"] as const;
export type Locale = (typeof LOCALES)[number];

export type PageContent = {
  path: string;
  title: string;
  description: string;
  heading: string;
  intro: string;
  hoursTitle: string;
  hours: readonly [day: string, time: string][];
  addressTitle: string;
  share: string;
  copied: string;
  switchLabel: string;
};

/** Fictional business. Each locale is one canonical page; both name each other through hreflang. */
export const PAGES: Record<Locale, PageContent> = {
  en: {
    path: "/",
    title: "Lindenhof Bakery – sourdough bread in Lindenau",
    description: "Sourdough bread, pastries and coffee in Lindenau. Opening hours, address and today's bakes.",
    heading: "Lindenhof Bakery",
    intro: "We bake sourdough bread from regional grain every morning, with long-fermented doughs and no additives.",
    hoursTitle: "Opening hours",
    hours: [
      ["Monday to Friday", "7:00–18:00"],
      ["Saturday", "7:00–13:00"],
      ["Sunday", "Closed"],
    ],
    addressTitle: "Address",
    share: "Share this page",
    copied: "Link copied",
    switchLabel: "Deutsch",
  },
  de: {
    path: "/de/",
    title: "Bäckerei Lindenhof – Sauerteigbrot in Lindenau",
    description: "Sauerteigbrot, Gebäck und Kaffee in Lindenau. Öffnungszeiten, Adresse und das heutige Backwerk.",
    heading: "Bäckerei Lindenhof",
    intro: "Wir backen jeden Morgen Sauerteigbrot aus regionalem Getreide, mit lang geführten Teigen und ohne Zusätze.",
    hoursTitle: "Öffnungszeiten",
    hours: [
      ["Montag bis Freitag", "7:00–18:00"],
      ["Samstag", "7:00–13:00"],
      ["Sonntag", "Geschlossen"],
    ],
    addressTitle: "Adresse",
    share: "Seite teilen",
    copied: "Link kopiert",
    switchLabel: "English",
  },
};

export const ADDRESS = { street: "Lindenstraße 12", postalCode: "04177", city: "Leipzig", country: "DE" } as const;
