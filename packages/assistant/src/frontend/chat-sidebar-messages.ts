import { i18n } from "@k2b/stdlib";

const plural = (count: number, one: string, other: string) => `${count} ${count === 1 ? one : other}`;
/** Up to three titles in the language's quotation marks, then an ellipsis. */
const titles = (values: readonly string[], open: string, close: string) =>
  values
    .slice(0, 3)
    .map((value) => `${open}${value}${close}`)
    .join(", ") + (values.length > 3 ? ", …" : "");

/** Copy of the chat sidebar ("In this chat"). */
export const chatSidebarMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "In this chat",
      search: "Search this chat",
      searchLabel: "Search results, files, and sources in this chat",
      clearSearch: "Close search",
      noMatches: ({ query }: { query: string }) => `Nothing found for “${query}”.`,
      loading: "Loading…",
      couldNotLoad: "Could not load this chat’s content",
      retry: "Retry",

      taskNeedsAttention: ({ title }: { title: string }) => `Routine “${title}” needs attention`,
      appRunFailed: ({ title }: { title: string }) => `The last run of “${title}” failed`,

      results: "Results",
      resultsEmpty: "Files, apps, and visualizations that Gustav creates for you appear here.",
      newResults: ({ count }: { count: number }) => `New · ${count}`,
      showNewResults: ({ count }: { count: number }) => `Show ${plural(count, "new result", "new results")}`,
      updates: "Update",
      showUpdates: "Show the latest changes",
      moreFromTurn: ({ count }: { count: number }) => `${count} more from this turn`,
      showInChat: "Show in chat",
      showInChatNamed: ({ title }: { title: string }) => `Show “${title}” in the chat`,
      open: "Open",
      openNamed: ({ title }: { title: string }) => `Open ${title}`,
      preview: "Preview",
      previewNamed: ({ title }: { title: string }) => `Preview ${title}`,
      download: "Download",
      downloadNamed: ({ title }: { title: string }) => `Download ${title}`,
      copyLink: "Copy link",
      linkCopied: "Link copied",
      visualization: "Visualization",
      runFailed: "last run failed",
      runRunning: "running",

      yourFiles: "Your files",
      files: "Files",
      older: "Older",
      voiceRecordings: "Voice recordings",

      sources: "Sources",
      all: ({ count }: { count: number }) => `All ${count}`,
      searched: ({ query }: { query: string }) => `Searched: “${query}”`,
      webSearch: "Web search",
      loadMore: "Load more",
      cloudItems: "Cloud items",

      workingFiles: "Working files",
      workingFor: ({ title }: { title: string }) => `for ${title}`,
      workingOther: "Other",
      workingHint: "Intermediate steps of Gustav, in the chat folder temp/.",
      storage: ({ used, max }: { used: string; max: string }) => `${used} of ${max} used`,
      deleteGroup: "Delete group",
      deleteGroupNamed: ({ name }: { name: string }) => `Delete the group “${name}”?`,
      deleteGroupDetail: ({ count, results }: { count: number; results: readonly string[] }) =>
        `This deletes ${plural(count, "file", "files")} from this chat` +
        (results.length === 0
          ? "."
          : results.length === 1
            ? `, including the result ${titles(results, "“", "”")}.`
            : `, including ${results.length} results: ${titles(results, "“", "”")}.`),
      hiddenGroups: ({ count }: { count: number }) =>
        `${plural(count, "older group is", "older groups are")} not listed. Search finds their files.`,
      moreFiles: ({ count }: { count: number }) => `${plural(count, "more file is", "more files are")} not listed. Search finds them.`,
      groupActions: ({ name }: { name: string }) => `Actions for ${name}`,
      fileActions: ({ name }: { name: string }) => `Actions for ${name}`,
      showMoreFiles: "Show more",
      scriptRuns: "Script runs",
      kindHtml: ({ count }: { count: number }) => plural(count, "HTML page", "HTML pages"),
      kindImage: ({ count }: { count: number }) => plural(count, "image", "images"),
      kindTable: ({ count }: { count: number }) => plural(count, "table", "tables"),
      kindPdf: ({ count }: { count: number }) => plural(count, "PDF", "PDFs"),
      kindScript: ({ count }: { count: number }) => plural(count, "script", "scripts"),
      kindText: ({ count }: { count: number }) => plural(count, "text file", "text files"),
      kindOther: ({ count }: { count: number }) => plural(count, "other file", "other files"),

      context: "Context",
      project: ({ name }: { name: string }) => `Project ${name}`,
      skills: ({ count }: { count: number }) => plural(count, "skill", "skills"),
      memories: ({ count }: { count: number }) => plural(count, "memory", "memories"),
      projectInstructions: "Project instructions",
      noProjectInstructions: "No Project instructions yet.",
      projectKnowledge: "Project knowledge",
      projectReferences: "Project references",
      skillsUsed: "Skills used",
      skillTurns: ({ count }: { count: number }) => `${count}×`,
      memoriesFromChat: "Remembered from this chat",
      secrets: "Secrets & approvals",

      today: "Today",
      yesterday: "Yesterday",

      boxEmpty: "Results, sources, and automations of this chat appear here.",
      boxFailed: "“In this chat” could not be loaded.",
      boxFailedDetail: "The chat itself is not affected.",
      boxNone: "None yet",
      boxShowAll: "Show all",
      boxShowAllNamed: ({ label }: { label: string }) => `Show all ${label.toLowerCase()} in a tab`,
      boxOpenAsTab: "Open as tab",
      boxNew: ({ count }: { count: number }) => (count > 0 ? `New · ${count}` : "New"),
      boxShowNew: "Show what is new",
      boxSources: "Sources",
      boxContext: "Context",
      boxSourcesSummary: ({
        named,
        pages,
        searches,
        items,
      }: {
        named: readonly string[];
        pages: number;
        searches: number;
        items: number;
      }) =>
        [
          ...named,
          items
            ? plural(items, named.length ? "other item" : "item from your Cloud", named.length ? "other items" : "items from your Cloud")
            : null,
          pages ? plural(pages, "web page", "web pages") : null,
          searches ? plural(searches, "search", "searches") : null,
        ]
          .filter(Boolean)
          .join(", "),
      boxContextSummary: ({
        project,
        skills,
        memories,
        routines,
      }: {
        project: string | null;
        skills: number;
        memories: number;
        routines: number;
      }) =>
        [
          project ? `Project ${project}` : null,
          skills ? plural(skills, "skill", "skills") : null,
          memories ? plural(memories, "memory", "memories") : null,
          routines ? plural(routines, "routine", "routines") : null,
        ]
          .filter(Boolean)
          .join(", "),
      downloadNamedShort: ({ name }: { name: string }) => `Download “${name}”`,
      openRow: ({ title }: { title: string }) => `Open “${title}” as a tab`,
      jumpRow: ({ title }: { title: string }) => `Show “${title}” in the chat`,
    },
    de: {
      title: "In diesem Chat",
      search: "In diesem Chat suchen",
      searchLabel: "Ergebnisse, Dateien und Quellen dieses Chats durchsuchen",
      clearSearch: "Suche schließen",
      noMatches: ({ query }: { query: string }) => `Nichts gefunden für »${query}«.`,
      loading: "Wird geladen…",
      couldNotLoad: "Inhalte dieses Chats konnten nicht geladen werden",
      retry: "Erneut versuchen",

      taskNeedsAttention: ({ title }: { title: string }) => `Routine „${title}“ braucht Aufmerksamkeit`,
      appRunFailed: ({ title }: { title: string }) => `Der letzte Lauf von „${title}“ ist fehlgeschlagen`,

      results: "Ergebnisse",
      resultsEmpty: "Dateien, Apps und Visualisierungen, die Gustav für dich erstellt, erscheinen hier.",
      newResults: ({ count }: { count: number }) => `Neu · ${count}`,
      showNewResults: ({ count }: { count: number }) => `${count} ${count === 1 ? "neues Ergebnis" : "neue Ergebnisse"} anzeigen`,
      updates: "Aktualisieren",
      showUpdates: "Neueste Änderungen anzeigen",
      moreFromTurn: ({ count }: { count: number }) => `${count} weitere aus dieser Runde`,
      showInChat: "Im Chat zeigen",
      showInChatNamed: ({ title }: { title: string }) => `„${title}“ im Chat zeigen`,
      open: "Öffnen",
      openNamed: ({ title }: { title: string }) => `${title} öffnen`,
      preview: "Vorschau",
      previewNamed: ({ title }: { title: string }) => `Vorschau von ${title}`,
      download: "Herunterladen",
      downloadNamed: ({ title }: { title: string }) => `${title} herunterladen`,
      copyLink: "Link kopieren",
      linkCopied: "Link kopiert",
      visualization: "Visualisierung",
      runFailed: "letzter Lauf fehlgeschlagen",
      runRunning: "läuft",

      yourFiles: "Deine Dateien",
      files: "Dateien",
      older: "Ältere",
      voiceRecordings: "Sprachaufnahmen",

      sources: "Quellen",
      all: ({ count }: { count: number }) => `Alle ${count}`,
      searched: ({ query }: { query: string }) => `Gesucht: »${query}«`,
      webSearch: "Websuche",
      loadMore: "Weitere laden",
      cloudItems: "Cloud-Inhalte",

      workingFiles: "Arbeitsdateien",
      workingFor: ({ title }: { title: string }) => `für ${title}`,
      workingOther: "Weitere",
      workingHint: "Zwischenschritte von Gustav, im Chat-Ordner temp/.",
      storage: ({ used, max }: { used: string; max: string }) => `${used} von ${max} belegt`,
      deleteGroup: "Gruppe löschen",
      deleteGroupNamed: ({ name }: { name: string }) => `Gruppe „${name}“ löschen?`,
      deleteGroupDetail: ({ count, results }: { count: number; results: readonly string[] }) =>
        `Damit ${count === 1 ? "wird 1 Datei" : `werden ${count} Dateien`} aus diesem Chat gelöscht` +
        (results.length === 0
          ? "."
          : results.length === 1
            ? `, darunter das Ergebnis ${titles(results, "„", "“")}.`
            : `, darunter ${results.length} Ergebnisse: ${titles(results, "„", "“")}.`),
      hiddenGroups: ({ count }: { count: number }) =>
        `${count} ${count === 1 ? "ältere Gruppe ist" : "ältere Gruppen sind"} nicht aufgeführt. Die Suche findet ihre Dateien.`,
      moreFiles: ({ count }: { count: number }) =>
        `${count} weitere ${count === 1 ? "Datei ist" : "Dateien sind"} nicht aufgeführt. Die Suche findet sie.`,
      groupActions: ({ name }: { name: string }) => `Aktionen für ${name}`,
      fileActions: ({ name }: { name: string }) => `Aktionen für ${name}`,
      showMoreFiles: "Weitere anzeigen",
      scriptRuns: "Skriptläufe",
      kindHtml: ({ count }: { count: number }) => `${count} ${count === 1 ? "HTML-Seite" : "HTML-Seiten"}`,
      kindImage: ({ count }: { count: number }) => `${count} ${count === 1 ? "Bild" : "Bilder"}`,
      kindTable: ({ count }: { count: number }) => `${count} ${count === 1 ? "Tabelle" : "Tabellen"}`,
      kindPdf: ({ count }: { count: number }) => `${count} ${count === 1 ? "PDF" : "PDFs"}`,
      kindScript: ({ count }: { count: number }) => `${count} ${count === 1 ? "Skript" : "Skripte"}`,
      kindText: ({ count }: { count: number }) => `${count} ${count === 1 ? "Textdatei" : "Textdateien"}`,
      kindOther: ({ count }: { count: number }) => `${count} ${count === 1 ? "weitere Datei" : "weitere Dateien"}`,

      context: "Kontext",
      project: ({ name }: { name: string }) => `Projekt ${name}`,
      skills: ({ count }: { count: number }) => `${count} ${count === 1 ? "Skill" : "Skills"}`,
      memories: ({ count }: { count: number }) => `${count} ${count === 1 ? "Erinnerung" : "Erinnerungen"}`,
      projectInstructions: "Projektanweisungen",
      noProjectInstructions: "Noch keine Projektanweisungen.",
      projectKnowledge: "Projektwissen",
      projectReferences: "Projektreferenzen",
      skillsUsed: "Verwendete Skills",
      skillTurns: ({ count }: { count: number }) => `${count}×`,
      memoriesFromChat: "Aus diesem Chat gemerkt",
      secrets: "Secrets & Freigaben",

      today: "Heute",
      yesterday: "Gestern",

      boxEmpty: "Ergebnisse, Quellen und Automationen dieses Chats erscheinen hier.",
      boxFailed: "„In diesem Chat“ konnte nicht geladen werden.",
      boxFailedDetail: "Der Chat selbst ist davon nicht betroffen.",
      boxNone: "Noch keine",
      boxShowAll: "Alle anzeigen",
      boxShowAllNamed: ({ label }: { label: string }) => `Alle ${label} in einem Tab anzeigen`,
      boxOpenAsTab: "Als Tab öffnen",
      boxNew: ({ count }: { count: number }) => (count > 0 ? `Neu · ${count}` : "Neu"),
      boxShowNew: "Neues anzeigen",
      boxSources: "Quellen",
      boxContext: "Kontext",
      boxSourcesSummary: ({
        named,
        pages,
        searches,
        items,
      }: {
        named: readonly string[];
        pages: number;
        searches: number;
        items: number;
      }) =>
        [
          ...named,
          items
            ? plural(
                items,
                named.length ? "weiterer Eintrag" : "Eintrag aus deiner Cloud",
                named.length ? "weitere Einträge" : "Einträge aus deiner Cloud",
              )
            : null,
          pages ? plural(pages, "Webseite", "Webseiten") : null,
          searches ? plural(searches, "Suche", "Suchen") : null,
        ]
          .filter(Boolean)
          .join(", "),
      boxContextSummary: ({
        project,
        skills,
        memories,
        routines,
      }: {
        project: string | null;
        skills: number;
        memories: number;
        routines: number;
      }) =>
        [
          project ? `Projekt ${project}` : null,
          skills ? plural(skills, "Skill", "Skills") : null,
          memories ? plural(memories, "Erinnerung", "Erinnerungen") : null,
          routines ? plural(routines, "Routine", "Routinen") : null,
        ]
          .filter(Boolean)
          .join(", "),
      downloadNamedShort: ({ name }: { name: string }) => `„${name}“ herunterladen`,
      openRow: ({ title }: { title: string }) => `„${title}“ als Tab öffnen`,
      jumpRow: ({ title }: { title: string }) => `„${title}“ im Chat zeigen`,
    },
  },
});

export type ChatSidebarCopy = ReturnType<typeof chatSidebarMessages.resolve>["t"];
