import type { Block } from "./schema";

/**
 * Fictional, bound views for render and browser tests and the screenshots of the capability views: an art inspector,
 * a travel app, a finance overview, and a Grids table. Images are app paths a test serves itself.
 */

const vases = [
  {
    id: "m_12",
    title: "Jugendstil-Vase mit Zinnmontierung",
    meta: "um 1905 · Auktion München, 03/2025",
    source: "artprice",
    hammer: "1.850 €",
    image: "/kunst/images/m_12.svg",
    url: "https://artprice.com/m_12",
  },
  {
    id: "m_31",
    title: "Jugendstil-Vase, Montierung Messing",
    meta: "um 1908 · Auktion Berlin, 09/2025",
    source: "artprice",
    hammer: "1.400 €",
    image: "/kunst/images/m_31.svg",
    url: "https://artprice.com/m_31",
  },
  {
    id: "m_07",
    title: "Vase, Steinzeug, florales Dekor",
    meta: "um 1902 · Auktion Wien, 11/2024",
    source: "artprice",
    hammer: "2.300 €",
    image: "/kunst/images/m_07.svg",
    url: "https://artprice.com/m_07",
  },
];

const categories = [
  { id: "cat_jug", label: "Jugendstil-Vase mit Metallmontierung", hint: "5 von 8 Treffern" },
  { id: "cat_deco", label: "Art-déco-Vase", hint: "2 von 8 Treffern" },
  { id: "cat_hist", label: "Pokalvase, Historismus", hint: "1 von 8 Treffern" },
];

export const artView: Block[] = [
  {
    kind: "Cards",
    title: "Ähnliche Objekte",
    items: vases.slice(0, 2),
    card: {
      id: ["id"],
      title: ["title"],
      subtitle: ["meta"],
      image: ["image"],
      badges: ["badges"],
      facts: [{ label: "Zuschlag", value: ["hammer"] }],
      href: ["url"],
    },
  },
  {
    kind: "Choice",
    id: "category",
    title: "Welche Kategorie passt am besten?",
    description: "Die Suche geht dann nur in dieser Kategorie weiter.",
    mode: "one",
    options: categories,
    option: { id: ["id"], title: ["label"], subtitle: ["hint"] },
    submit: "Vertiefen",
    then: { query: "kunst.query.search-similar", input: { objectId: "o_81" }, field: "categoryId" },
  },
];

export const artFollowUp: Block[] = [
  {
    kind: "Detail",
    title: "Einschätzung",
    items: [
      { label: "Vergleichbare Zuschläge", value: "5 seit 2023" },
      { label: "Median", value: "1.850 €" },
      { label: "Spanne", value: "1.400 € – 2.300 €" },
      { label: "Marke am Boden", value: "Nicht erkannt, Foto von unten fehlt" },
    ],
  },
  {
    kind: "Cards",
    title: "Engste Treffer",
    items: vases,
    card: {
      id: ["id"],
      title: ["title"],
      subtitle: ["meta"],
      image: ["image"],
      facts: [{ label: "Zuschlag", value: ["hammer"] }],
      href: ["url"],
    },
  },
];

const restaurants = [
  {
    id: "lucia",
    name: "Trattoria Lucia",
    kind: "Toskanisch",
    rating: "4,6 (312)",
    price: "€€",
    distance: "350 m",
    image: "/reisen/images/lucia.svg",
  },
  {
    id: "pozzo",
    name: "Osteria del Pozzo",
    kind: "Hausmannskost",
    rating: "4,4 (189)",
    price: "€",
    distance: "600 m",
    image: "/reisen/images/pozzo.svg",
  },
  {
    id: "cortile",
    name: "Il Cortile",
    kind: "Fisch, Saisonal",
    rating: "4,7 (95)",
    price: "€€€",
    distance: "1,1 km",
    image: "/reisen/images/cortile.svg",
  },
  {
    id: "nello",
    name: "Da Nello",
    kind: "Pizza, Pasta",
    rating: "4,3 (540)",
    price: "€",
    distance: "250 m",
    image: "/reisen/images/nello.svg",
  },
];

export const travelView: Block[] = [
  {
    kind: "Cards",
    title: "Für Freitag, 14.11., ab 19:00",
    items: restaurants,
    card: {
      id: ["id"],
      title: ["name"],
      subtitle: ["kind"],
      image: ["image"],
      rating: ["rating"],
      price: ["price"],
      facts: [{ label: "Zu Fuß", value: ["distance"] }],
    },
    choose: "restaurant",
  },
  {
    kind: "Choice",
    id: "restaurant",
    title: "Wo möchtest du essen?",
    mode: "one",
    options: restaurants,
    option: { id: ["id"], title: ["name"] },
    submit: "Tisch anfragen",
  },
];

export const financeView: Block[] = [
  {
    kind: "Stats",
    items: [
      { label: "Girokonto", value: 2481.2, format: { style: "currency", currency: "EUR" }, icon: "ti ti-building-bank" },
      { label: "Tagesgeld", value: 12050, format: { style: "currency", currency: "EUR" }, icon: "ti ti-pig-money" },
      { label: "Haushaltstopf", value: 640, format: { style: "currency", currency: "EUR" }, icon: "ti ti-home" },
      { label: "Kreditkarte", value: -312.45, format: { style: "currency", currency: "EUR" }, icon: "ti ti-credit-card" },
    ],
  },
  {
    kind: "Chart",
    width: "half",
    description: {
      kind: "line",
      title: "Gesamtsaldo",
      area: true,
      series: [
        {
          label: "Saldo",
          data: [
            { x: "2026-06-01", y: 13300 },
            { x: "2026-07-01", y: 13900 },
            { x: "2026-08-01", y: 12900 },
            { x: "2026-09-01", y: 14000 },
            { x: "2026-10-01", y: 14800 },
            { x: "2026-11-01", y: 15400 },
          ],
        },
      ],
    },
  } as Block,
  {
    kind: "Table",
    title: "Anstehende Zahlungen",
    subtitle: "bis 30.11., alle vom Girokonto",
    width: "half",
    columns: [
      { path: ["date"], label: "Datum" },
      { path: ["payee"], label: "Empfänger" },
      { path: ["amount"], label: "Betrag", type: "amount", format: { style: "currency", currency: "EUR" } },
    ],
    rows: [
      { date: "15.11.", payee: "Miete", amount: -980 },
      { date: "18.11.", payee: "Stadtwerke", amount: -74 },
      { date: "20.11.", payee: "Kita Sonnenhof", amount: -210 },
      { date: "28.11.", payee: "Hausratversicherung", amount: -41.2 },
    ],
  },
];

export const gridsView: Block[] = [
  {
    kind: "Table",
    title: "Knappe Artikel · Lager Nord",
    columns: [
      { path: ["sku"], label: "Artikel" },
      { path: ["place"], label: "Lagerort" },
      { path: ["stock"], label: "Bestand", type: "number" },
      {
        path: ["state"],
        label: "Status",
        type: "status",
        states: { low: { label: "Knapp", tone: "warning" }, out: { label: "Leer", tone: "error" } },
      },
    ],
    rows: [
      { sku: "Vitrinenglas 40 × 60", place: "N-02", stock: 3, state: "low" },
      { sku: "Samtkissen, grün", place: "N-04", stock: 0, state: "out" },
      { sku: "Messingständer klein", place: "N-02", stock: 2, state: "low" },
    ],
  },
];

/** An SVG stand-in for an app image: a vase or a plate in one quiet colour. */
export const fixtureImage = (path: string): string => {
  const palette: Record<string, [string, string]> = {
    m_12: ["#eceee6", "#5f8a6f"],
    m_31: ["#f1e8de", "#8b5a3c"],
    m_07: ["#e6ebf0", "#3f5f7f"],
    lucia: ["#f3e6d4", "#d9a441"],
    pozzo: ["#eef1e6", "#9bb27a"],
    cortile: ["#f5e9e7", "#d98a7a"],
    nello: ["#eceff2", "#b9a07a"],
  };
  const key = path
    .split("/")
    .at(-1)!
    .replace(/\.svg$/, "");
  const [ground, ink] = palette[key] ?? ["#eee", "#888"];
  const vase = path.includes("/kunst/");
  return vase
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120"><rect width="160" height="120" fill="${ground}"/><path d="M70 18h20v10c18 10 24 30 18 52-4 14-12 22-18 24H70c-6-2-14-10-18-24-6-22 0-42 18-52z" fill="${ink}"/><rect x="68" y="14" width="24" height="6" rx="2" fill="#9aa3a8"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120"><rect width="160" height="120" fill="${ground}"/><circle cx="80" cy="60" r="38" fill="#fff"/><circle cx="80" cy="60" r="28" fill="${ink}"/><rect x="24" y="30" width="5" height="60" rx="2" fill="#fff"/><rect x="131" y="30" width="5" height="60" rx="2" fill="#fff"/></svg>`;
};
