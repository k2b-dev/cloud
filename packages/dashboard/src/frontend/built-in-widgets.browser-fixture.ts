import type { DashboardWidgetSize, WidgetBlock, WidgetListItem, WidgetResponse } from "@k2b/cloud/contracts";

/**
 * What each built-in widget answers in each size it offers, with invented data, in German, whose labels run longest.
 * Each fixture follows its handler's composition for that size: the blocks, the rows a size holds, the header meta,
 * and every empty, failed and all-clear answer. Apps cannot be imported here, so a handler that changes what a size
 * shows changes its fixture too.
 */
export type BuiltInWidgetFixture = { key: string; size: DashboardWidgetSize; variant: string; response: WidgetResponse };

const rows = (count: number, row: (index: number) => WidgetListItem): WidgetListItem[] => Array.from({ length: count }, (_, i) => row(i));

const task = (index: number): WidgetListItem => ({
  icon: index % 3 === 0 ? "ti ti-flame" : "ti ti-flag-3",
  iconTone: index % 3 === 0 ? "red" : "amber",
  label: ["Angebot für die Ausstellung im Frühjahr fertig machen", "Lieferschein prüfen", "Rückruf Werkstatt"][index % 3]!,
  sub: ["Projekt Nordlicht", "Einkauf", "Werkstatt"][index % 3]!,
  meta: index === 0 ? "überfällig" : "Mo., 26. Okt.",
  href: `/app/spaces/s${index}/items/i${index}`,
});
const event = (index: number): WidgetListItem => ({
  icon: "ti ti-clock",
  iconTone: "blue",
  label: ["Teamrunde", "Abholung Restaurierung"][index % 2]!,
  sub: "Projekt Nordlicht",
  meta: "10:00–11:30",
  href: `/app/spaces/s1/items/e${index}`,
});
const note = (index: number): WidgetListItem => ({
  icon: "ti ti-notebook",
  label: ["Protokoll der Teamrunde vom Donnerstag mit allen offenen Punkten", "Ideen Herbstkatalog", "(ohne Titel)"][index % 3]!,
  sub: "Arbeit",
  meta: "vor 3 Stunden",
  href: `/app/notebooks/n1/notes/m${index}`,
});
const place = (index: number): WidgetListItem => ({
  icon: "ti ti-cloud-filled",
  iconTone: "blue",
  label: ["Hamburg", "Garmisch-Partenkirchen", "Berlin", "Köln", "Leipzig", "Freiburg im Breisgau", "Kiel"][index % 7]!,
  sub: "Teilweise bewölkt",
  meta: "14°C",
});

const spacesToday = (size: DashboardWidgetSize): BuiltInWidgetFixture[] => {
  const count = size === "large" ? 6 : 2;
  const base = { title: "Heute", icon: "ti ti-checklist", href: "/app/spaces" };
  return [
    {
      key: "spaces/today",
      size,
      variant: "tasks and events",
      response: {
        ...base,
        meta: "2 heute · 14 offen · 3 dringend",
        blocks: [{ kind: "list", items: [...rows(2, event), ...rows(count, task)].slice(0, count) }],
      },
    },
    {
      key: "spaces/today",
      size,
      variant: "one space",
      response: { ...base, title: "Heute · Projekt Nordlicht", meta: "5 offen", blocks: [{ kind: "list", items: rows(count, task) }] },
    },
    {
      key: "spaces/today",
      size,
      variant: "nothing on",
      response: {
        ...base,
        blocks: [
          {
            kind: "hero",
            icon: "ti ti-circle-check",
            tone: "emerald",
            title: "Heute steht nichts an",
            subtitle: "Keine Termine und keine offenen Aufgaben",
          },
        ],
      },
    },
  ];
};

const recentNotes = (size: DashboardWidgetSize): BuiltInWidgetFixture[] => {
  const base = { title: "Letzte Notizen", icon: "ti ti-notebook", href: "/app/notebooks" };
  return [
    {
      key: "notebooks/recent",
      size,
      variant: "notes",
      response: { ...base, blocks: [{ kind: "list", items: rows(size === "large" ? 5 : 2, note), grow: true }] },
    },
    {
      key: "notebooks/recent",
      size,
      variant: "no notes",
      response: {
        ...base,
        blocks: [
          {
            kind: "hero",
            icon: "ti ti-notebook",
            tone: "blue",
            title: "Noch keine Notizen",
            subtitle: "Erstelle ein Notizbuch, um zu beginnen",
          },
        ],
      },
    },
  ];
};

const weather = (size: DashboardWidgetSize): BuiltInWidgetFixture[] => {
  const base = { title: "Wetter", icon: "ti ti-cloud", href: "/app/weather" };
  const shown = { small: 1, medium: 2, large: 7 }[size];
  const fixtures: BuiltInWidgetFixture[] = [
    {
      key: "weather/current",
      size,
      variant: "no places",
      response: {
        ...base,
        blocks: [
          {
            kind: "hero",
            icon: "ti ti-map-pin-plus",
            tone: "blue",
            title: "Noch keine Orte gespeichert",
            ...(size === "small" ? {} : { subtitle: "Füge in Wetter einen Ort hinzu, um hier Vorhersagen zu sehen" }),
          },
        ],
      },
    },
    {
      key: "weather/current",
      size,
      variant: "places failed",
      response: {
        ...base,
        blocks: [
          {
            kind: "status",
            tone: "error",
            title: "Wetter nicht verfügbar",
            message: "Gespeicherte Orte konnten nicht geladen werden.",
            icon: "ti ti-alert-circle",
            grow: true,
          },
        ],
      },
    },
    {
      key: "weather/current",
      size,
      variant: "one place",
      response: {
        ...base,
        icon: "ti ti-cloud-filled",
        meta: "1 von 3",
        blocks: [
          { kind: "hero", icon: "ti ti-cloud-filled", tone: "blue", title: "14°C · Teilweise bewölkt", subtitle: "Garmisch-Partenkirchen" },
          ...(size === "large"
            ? ([
                {
                  kind: "pills",
                  pills: [
                    { label: "Wind", value: "18 km/h" },
                    { label: "Luftfeuchte", value: "72 %" },
                    { label: "hPa", value: "1.013" },
                  ],
                },
              ] satisfies WidgetBlock[])
            : []),
        ],
      },
    },
    {
      key: "weather/current",
      size,
      variant: "forecast failed",
      response: {
        ...base,
        meta: "1 von 3",
        blocks: [
          {
            kind: "hero",
            icon: "ti ti-cloud-off",
            title: "Vorhersage nicht verfügbar",
            subtitle: size === "small" ? "Garmisch-Partenkirchen" : "Für Garmisch-Partenkirchen sind derzeit keine Wetterdaten verfügbar",
          },
        ],
      },
    },
  ];
  if (shown > 1)
    fixtures.push({
      key: "weather/current",
      size,
      variant: "places",
      response: { ...base, meta: `${shown} von 9`, blocks: [{ kind: "list", items: rows(shown, place), grow: true }] },
    });
  return fixtures;
};

const adminQueue = (size: DashboardWidgetSize): BuiltInWidgetFixture[] => {
  const base = { title: "Administrationsaufgaben", icon: "ti ti-users-group", href: "/app/accounts" };
  const large = size === "large";
  const pills = (queue: boolean): WidgetBlock[] =>
    size === "small"
      ? []
      : [
          {
            kind: "pills",
            pills: [
              { label: "Konten", value: 14 },
              { label: "Gruppen", value: 19 },
              ...(queue ? [{ label: "Aufgaben", value: 3, tone: "amber" as const }] : []),
            ],
          },
        ];
  const requests: WidgetBlock = {
    kind: "stat",
    grow: true,
    value: 3,
    label: "Offene Anfragen",
    sub: "zu prüfen",
    valueClass: "text-amber-600 dark:text-amber-400",
    accent: { tone: "amber", icon: "ti ti-clock", text: "Offen" },
  };
  const expiring: WidgetBlock = {
    kind: "status",
    tone: "warn",
    grow: !large,
    title: "4 Konten laufen innerhalb von 30 Tagen ab",
    message: large ? "2 FreeIPA · 1 lokal · 1 Gast" : undefined,
    icon: "ti ti-calendar-due",
  };
  return [
    {
      key: "accounts/admin-queue",
      size,
      variant: "requests and expiring",
      response: { ...base, blocks: [requests, ...(large ? [expiring] : []), ...pills(true)] },
    },
    { key: "accounts/admin-queue", size, variant: "expiring", response: { ...base, blocks: [expiring, ...pills(false)] } },
    {
      key: "accounts/admin-queue",
      size,
      variant: "all clear",
      response: {
        ...base,
        blocks: [
          {
            kind: "hero",
            icon: "ti ti-circle-check",
            tone: "emerald",
            title: "Alles erledigt",
            subtitle: large ? "Keine offenen Anfragen und keine Zugangsdaten, die bald ablaufen" : undefined,
          },
          ...pills(false),
        ],
      },
    },
  ];
};

const ipaHosts = (size: DashboardWidgetSize): BuiltInWidgetFixture[] => {
  const base = { title: "IPA-Hosts", icon: "ti ti-server", href: "/admin/ipa-hosts" };
  return [
    {
      key: "ipa-hosts/sync",
      size,
      variant: "ungrouped",
      response: {
        ...base,
        blocks: [
          {
            kind: "status",
            grow: true,
            tone: "warn",
            title: "12 nicht gruppierte Hosts",
            message: "Von 1.248 gespiegelten Hosts",
            icon: "ti ti-server",
          },
          ...(size === "small"
            ? []
            : ([
                {
                  kind: "pills",
                  pills: [
                    { label: "Gruppen", value: 37, tone: "blue" },
                    { label: "In Gruppen", value: 1236 },
                    { label: "Nicht gruppiert", value: 12, tone: "amber" },
                  ],
                },
              ] satisfies WidgetBlock[])),
        ],
      },
    },
    {
      key: "ipa-hosts/sync",
      size,
      variant: "empty mirror",
      response: {
        ...base,
        blocks: [
          {
            kind: "hero",
            icon: "ti ti-server-off",
            tone: "blue",
            title: "Leerer Spiegel",
            subtitle: size === "small" ? undefined : "Starte eine Synchronisierung, um Hosts und Hostgruppen aus FreeIPA zu importieren",
          },
        ],
      },
    },
  ];
};

const platformHealth = (size: DashboardWidgetSize): BuiltInWidgetFixture[] => [
  {
    key: "gateway/health",
    size,
    variant: "all operational",
    response: {
      title: "Plattformzustand",
      icon: "ti ti-heartbeat",
      href: "/admin/gateway",
      blocks: [
        {
          kind: "status",
          grow: true,
          tone: "ok",
          title: "Alle Systeme betriebsbereit",
          message: "24 Apps registriert · keine Momentaufnahme des Gateway-Routers",
        },
        ...(size === "small"
          ? []
          : ([
              {
                kind: "pills",
                pills: [
                  { label: "Apps", value: "24/24", tone: "emerald" },
                  { label: "Routen", value: "0" },
                  { label: "Anfragen", value: "0" },
                ],
              },
            ] satisfies WidgetBlock[])),
      ],
    },
  },
  {
    key: "gateway/health",
    size,
    variant: "apps need attention",
    response: {
      title: "Plattformzustand",
      icon: "ti ti-heartbeat",
      href: "/admin/gateway",
      blocks: [
        {
          kind: "status",
          grow: true,
          tone: "warn",
          title: "2 von 24 Apps erfordern einen Eingriff",
          message: size === "small" ? undefined : "Gateway läuft seit 3 Tagen, 4 Stunden · 24 Apps registriert",
        },
        ...(size === "small"
          ? []
          : ([
              {
                kind: "pills",
                pills: [
                  { label: "Apps", value: "22/24", tone: "amber" },
                  { label: "Routen", value: "312" },
                  { label: "Anfragen", value: "1.284.551" },
                  { label: "Nicht zugeordnet", value: "17", tone: "amber" },
                ],
              },
            ] satisfies WidgetBlock[])),
      ],
    },
  },
];

const logs = (size: DashboardWidgetSize): BuiltInWidgetFixture[] => [
  {
    key: "gateway/errors",
    size,
    variant: "errors",
    response: {
      title: "Protokolle",
      icon: "ti ti-list-tree",
      href: "/admin/observability/logs",
      meta: "letzte 24 Std.",
      blocks: [
        {
          kind: "stat",
          grow: true,
          value: "1.204",
          label: "Fehler · letzte 24 Std.",
          sub: "Prüfung erforderlich",
          valueClass: "text-red-500",
          accent: { tone: "red", icon: "ti ti-alert-circle" },
        },
        ...(size === "small"
          ? []
          : ([
              {
                kind: "pills",
                pills: [
                  { label: "Warnungen", value: "3.410", tone: "amber" },
                  { label: "Einträge", value: "88.112" },
                ],
              },
            ] satisfies WidgetBlock[])),
      ],
    },
  },
];

const quote = (size: DashboardWidgetSize): BuiltInWidgetFixture[] => [
  {
    key: "quotes/quote",
    size,
    variant: "quote",
    response: {
      title: "Zitat der Stunde",
      icon: "ti ti-quote",
      blocks: [
        {
          kind: "hero",
          title: "Wer immer tut, was er schon kann, bleibt immer das, was er schon ist.",
          subtitle: "— Henry Ford",
        },
      ],
    },
  },
  {
    key: "quotes/quote",
    size,
    variant: "provider down",
    response: {
      title: "Zitat der Stunde",
      icon: "ti ti-quote",
      blocks: [
        {
          kind: "placeholder",
          icon: "ti ti-cloud-off",
          title: "Derzeit kein Zitat",
          description: "Der Anbieter ist nicht erreichbar. Versuche es in einer Minute erneut.",
        },
      ],
    },
  },
];

const venueToday = (size: DashboardWidgetSize): BuiltInWidgetFixture[] => {
  const base = { title: "Galerie am Hafen", icon: "ti ti-building-carousel", href: "/app/venue/v1", meta: "Geöffnet bis 18:00" };
  const status: WidgetBlock = {
    kind: "status",
    tone: "ok",
    title: "Geöffnet bis 18:00",
    message: size === "medium" ? undefined : "Heute keine regelmäßigen Öffnungszeiten",
    icon: "ti ti-door-gate-open",
    grow: size === "small",
  };
  const stat: WidgetBlock[] =
    size === "small"
      ? []
      : [
          {
            kind: "stat",
            label: "Freie Plätze",
            value: 4,
            sub: "Personen noch benötigt",
            accent: { tone: "amber", icon: "ti ti-user-plus" },
          },
        ];
  if (size !== "large") return [{ key: "venue/today", size, variant: "open", response: { ...base, blocks: [status, ...stat] } }];
  return [
    {
      key: "venue/today",
      size,
      variant: "next shift",
      response: {
        ...base,
        blocks: [
          status,
          ...stat,
          {
            kind: "list",
            items: [{ icon: "ti ti-calendar-event", label: "Deine nächste Schicht", sub: "Sa., 24. Okt., 14:00", href: "/app/venue/v1" }],
          },
        ],
      },
    },
    {
      key: "venue/today",
      size,
      variant: "no shift",
      response: {
        ...base,
        blocks: [status, ...stat, { kind: "placeholder", title: "Keine anstehenden Schichten", icon: "ti ti-calendar-off" }],
      },
    },
  ];
};

/** Every built-in widget, the sizes it declares, and its answers in each of them. */
export const builtInWidgets: {
  key: string;
  sizes: DashboardWidgetSize[];
  fixtures: (size: DashboardWidgetSize) => BuiltInWidgetFixture[];
}[] = [
  { key: "spaces/today", sizes: ["medium", "large"], fixtures: spacesToday },
  { key: "notebooks/recent", sizes: ["medium", "large"], fixtures: recentNotes },
  { key: "weather/current", sizes: ["small", "medium", "large"], fixtures: weather },
  { key: "accounts/admin-queue", sizes: ["small", "medium", "large"], fixtures: adminQueue },
  { key: "ipa-hosts/sync", sizes: ["small", "medium"], fixtures: ipaHosts },
  { key: "gateway/health", sizes: ["small", "medium"], fixtures: platformHealth },
  { key: "gateway/errors", sizes: ["small", "medium"], fixtures: logs },
  { key: "quotes/quote", sizes: ["medium"], fixtures: quote },
  { key: "venue/today", sizes: ["small", "medium", "large"], fixtures: venueToday },
];
