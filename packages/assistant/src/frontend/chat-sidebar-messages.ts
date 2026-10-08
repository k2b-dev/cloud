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
      show: "Show what is in this chat",
      close: "Close the sidebar",
      search: "Search this chat",
      searchLabel: "Search results, files, and sources in this chat",
      clearSearch: "Close search",
      noMatches: ({ query }: { query: string }) => `Nothing found for “${query}”.`,
      loading: "Loading…",
      couldNotLoad: "Could not load this chat’s content",
      retry: "Retry",

      attention: "Needs attention",
      taskNeedsAttention: ({ title }: { title: string }) => `Scheduled task “${title}” needs attention`,
      appRunFailed: ({ title }: { title: string }) => `The last run of “${title}” failed`,

      results: "Results",
      resultsEmpty: "Files, apps, and visualizations that the assistant creates for you appear here.",
      newResults: ({ count }: { count: number }) => `New · ${count}`,
      showNewResults: ({ count }: { count: number }) => `Show ${plural(count, "new result", "new results")}`,
      updates: "Update",
      showUpdates: "Show the latest changes",
      moreFromTurn: ({ count }: { count: number }) => `${count} more from this turn`,
      showInChat: "Show in chat",
      showInChatNamed: ({ title }: { title: string }) => `Show “${title}” in the chat`,
      open: "Open",
      openNamed: ({ title }: { title: string }) => `Open ${title}`,
      download: "Download",
      downloadNamed: ({ title }: { title: string }) => `Download ${title}`,
      copyLink: "Copy link",
      linkCopied: "Link copied",
      studioApp: "Studio app",
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
      workingHint: "Intermediate steps of the assistant, in the chat folder temp/.",
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
      tasks: ({ count }: { count: number }) => plural(count, "scheduled task", "scheduled tasks"),
      projectInstructions: "Project instructions",
      noProjectInstructions: "No Project instructions yet.",
      projectKnowledge: "Project knowledge",
      projectReferences: "Project references",
      skillsUsed: "Skills used",
      skillTurns: ({ count }: { count: number }) => `${count}×`,
      memoriesFromChat: "Remembered from this chat",
      scheduled: "Scheduled tasks",
      secrets: "Secrets",

      today: "Today",
      yesterday: "Yesterday",
    },
    de: {
      title: "In diesem Chat",
      show: "Zeigen, was in diesem Chat ist",
      close: "Seitenleiste schließen",
      search: "In diesem Chat suchen",
      searchLabel: "Ergebnisse, Dateien und Quellen dieses Chats durchsuchen",
      clearSearch: "Suche schließen",
      noMatches: ({ query }: { query: string }) => `Nichts gefunden für »${query}«.`,
      loading: "Wird geladen…",
      couldNotLoad: "Inhalte dieses Chats konnten nicht geladen werden",
      retry: "Erneut versuchen",

      attention: "Braucht Aufmerksamkeit",
      taskNeedsAttention: ({ title }: { title: string }) => `Geplante Aufgabe „${title}“ braucht Aufmerksamkeit`,
      appRunFailed: ({ title }: { title: string }) => `Der letzte Lauf von „${title}“ ist fehlgeschlagen`,

      results: "Ergebnisse",
      resultsEmpty: "Dateien, Apps und Visualisierungen, die der Assistent für dich erstellt, erscheinen hier.",
      newResults: ({ count }: { count: number }) => `Neu · ${count}`,
      showNewResults: ({ count }: { count: number }) => `${count} ${count === 1 ? "neues Ergebnis" : "neue Ergebnisse"} anzeigen`,
      updates: "Aktualisieren",
      showUpdates: "Neueste Änderungen anzeigen",
      moreFromTurn: ({ count }: { count: number }) => `${count} weitere aus dieser Runde`,
      showInChat: "Im Chat zeigen",
      showInChatNamed: ({ title }: { title: string }) => `„${title}“ im Chat zeigen`,
      open: "Öffnen",
      openNamed: ({ title }: { title: string }) => `${title} öffnen`,
      download: "Herunterladen",
      downloadNamed: ({ title }: { title: string }) => `${title} herunterladen`,
      copyLink: "Link kopieren",
      linkCopied: "Link kopiert",
      studioApp: "Studio-App",
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
      workingHint: "Zwischenschritte des Assistenten, im Chat-Ordner temp/.",
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
      tasks: ({ count }: { count: number }) => `${count} ${count === 1 ? "geplante Aufgabe" : "geplante Aufgaben"}`,
      projectInstructions: "Projektanweisungen",
      noProjectInstructions: "Noch keine Projektanweisungen.",
      projectKnowledge: "Projektwissen",
      projectReferences: "Projektreferenzen",
      skillsUsed: "Verwendete Skills",
      skillTurns: ({ count }: { count: number }) => `${count}×`,
      memoriesFromChat: "Aus diesem Chat gemerkt",
      scheduled: "Geplante Aufgaben",
      secrets: "Secrets",

      today: "Heute",
      yesterday: "Gestern",
    },
  },
});

export type ChatSidebarCopy = ReturnType<typeof chatSidebarMessages.resolve>["t"];
