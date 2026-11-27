import { i18n } from "@k2b/stdlib";

/** Words of the AI area's Skills and Projects screens that the shared settings catalog does not have. */
export const aiContentMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      skillsLead: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: `${count} shared Skill`, other: `${count} shared Skills` }),
      projectsLead: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: `${count} shared Project`, other: `${count} shared Projects` }),
      matches: ({ count, search }: { count: number; search: string }) =>
        i18n.plural(count, "en", { one: `${count} match for “${search}”`, other: `${count} matches for “${search}”` }),
      accessAfter: "access entries",
      pageOf: ({ page, pages }: { page: number; pages: number }) => `page ${page} of ${pages}`,
      previousPage: "Previous page",
      nextPage: "Next page",
      skillsUnmanaged: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: "1 Skill without an admin", other: `${count} Skills without an admin` }),
      projectsUnmanaged: ({ count }: { count: number }) =>
        i18n.plural(count, "en", { one: "1 Project without an admin", other: `${count} Projects without an admin` }),
      unmanagedText: "Nobody can change their access. Open one and add an admin under Permissions.",
      noAdminTitle: "No admin",
      skillNoAdminText: "Nobody can change who uses this Skill. Add an admin under Permissions.",
      projectNoAdminText: "Nobody can change who works in this Project. Add an admin under Permissions.",
      updateText: "The app ships a newer version. Compare to see what would change.",
      entries: ({ count }: { count: number }) => i18n.plural(count, "en", { one: "1 entry", other: `${count} entries` }),
      references: "Reference files",
      created: "Created",
      id: "ID",
      state: "State",
      closeDetail: "Close",
      skillsList: "Skills",
      projectsList: "Projects",
      issuesCount: ({ count }: { count: number }) => i18n.plural(count, "en", { one: "1 app Skill", other: `${count} app Skills` }),
      diffLabel: "Differences to the app version",
      details: "Details",
      showAll: "Show all",
    },
    de: {
      skillsLead: ({ count }) => i18n.plural(count, "de", { one: `${count} geteilter Skill`, other: `${count} geteilte Skills` }),
      projectsLead: ({ count }) => i18n.plural(count, "de", { one: `${count} geteiltes Projekt`, other: `${count} geteilte Projekte` }),
      matches: ({ count, search }) =>
        i18n.plural(count, "de", { one: `${count} Treffer für „${search}“`, other: `${count} Treffer für „${search}“` }),
      accessAfter: "Freigaben",
      pageOf: ({ page, pages }) => `Seite ${page} von ${pages}`,
      previousPage: "Vorige Seite",
      nextPage: "Nächste Seite",
      skillsUnmanaged: ({ count }) => i18n.plural(count, "de", { one: "1 Skill ohne Administration", other: `${count} Skills ohne Administration` }),
      projectsUnmanaged: ({ count }) =>
        i18n.plural(count, "de", { one: "1 Projekt ohne Administration", other: `${count} Projekte ohne Administration` }),
      unmanagedText: "Niemand kann ihren Zugriff ändern. Öffne eines und trage unter Berechtigungen eine Administration ein.",
      noAdminTitle: "Keine Administration",
      skillNoAdminText: "Niemand kann ändern, wer diesen Skill nutzt. Trage unter Berechtigungen eine Administration ein.",
      projectNoAdminText: "Niemand kann ändern, wer in diesem Projekt arbeitet. Trage unter Berechtigungen eine Administration ein.",
      updateText: "Die App liefert eine neuere Fassung. Vergleiche, um zu sehen, was sich ändern würde.",
      entries: ({ count }) => i18n.plural(count, "de", { one: "1 Eintrag", other: `${count} Einträge` }),
      references: "Referenzdateien",
      created: "Angelegt",
      id: "ID",
      state: "Stand",
      closeDetail: "Schließen",
      skillsList: "Skills",
      projectsList: "Projekte",
      issuesCount: ({ count }) => i18n.plural(count, "de", { one: "1 App-Skill", other: `${count} App-Skills` }),
      diffLabel: "Unterschiede zur App-Fassung",
      details: "Angaben",
      showAll: "Alle zeigen",
    },
  },
});

export type AiContentMessages = ReturnType<typeof aiContentMessages.resolve>["t"];
