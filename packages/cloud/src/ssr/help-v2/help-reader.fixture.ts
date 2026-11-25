import type { HelpDocumentManifest } from "../../shared/help";
import type { HelpReaderProps } from "./HelpReader";

/** Invented Help of an invented Spaces, for the v2 reader's render and browser tests. */
const documents: HelpDocumentManifest[] = [
  { id: "share", title: "Share a Space", description: "Invite people.", kind: "task" as const, icon: "ti ti-share" },
  { id: "tasks", title: "Plan tasks", description: "Board, list and calendar.", kind: "task" as const, icon: "ti ti-checklist" },
  { id: "roles", title: "Roles", description: "Who may do what.", kind: "reference" as const },
  { id: "start", title: "First steps", kind: "start" as const },
  { id: "sync", title: "Calendar does not sync", kind: "troubleshoot" as const },
].map((topic, order) => ({
  ...topic,
  order,
  url: `/api/help/v1/spaces/documents/${topic.id}`,
  searchUrl: "/api/help/v1/spaces/search",
  locale: "en",
}));

export const helpReaderFixture: HelpReaderProps = {
  surface: "panel",
  documents,
  app: { id: "spaces", name: "Spaces", icon: "ti ti-layout-kanban" },
  view: ["share"],
  pageBase: "/help/apps/spaces",
  platform: "other",
  initialArticle: {
    payload: {
      id: "share",
      title: "Share a Space",
      locale: "en",
      markdown: "Invite a person by name.\n\n## Invite\n\n1. Open the Space.\n2. Choose Share.",
      kind: "task",
      needs: "manage",
      related: [
        {
          appId: "spaces",
          appName: "Spaces",
          documentId: "roles",
          title: "Roles",
          description: "Who may do what.",
          url: "/help/apps/spaces/roles",
        },
      ],
    },
    parts: {
      lead: "<p>Invite a person by name.</p>",
      body: '<h2 id="invite">Invite</h2><div class="help-steps"><ol><li>Open the Space.</li><li>Choose Share.</li></ol></div>',
      sections: [{ id: "invite", label: "Invite" }],
      steps: 2,
    },
  },
  sections: [
    {
      id: "code",
      icon: "code",
      title: "Use in Code",
      summary: "What your Code can do in Spaces.",
      code: { label: "Import", value: 'import { spaces } from "@sdk";' },
      groups: [
        {
          title: "Operations",
          rows: [
            { title: "spaces.items.list", text: "List the items of a space.", state: { label: "Automatic", tone: "ok" } },
            { title: "spaces.items.delete", state: { label: "Never", tone: "bad" } },
          ],
        },
      ],
    },
  ],
  shortcuts: {
    seed: [
      { id: "cloud.search", title: "Open global search", shortcut: "mod+k" },
      { id: "cloud.help", title: "Open Help", shortcut: "shift+/" },
      { id: "spaces.new", title: "New task", shortcut: "n" },
    ],
    read: () => [],
    subscribe: () => () => {},
  },
};

const long = "Freigabeeinstellungen für Gäste, Gruppen und Dienstkonten in Donaudampfschifffahrtsgesellschaftsräumen 🚢";

/** The worst case (break-ui): 120 articles, long and unbreakable titles, no descriptions, non-Latin text, emoji. */
export const worstCaseHelpReaderFixture: Partial<HelpReaderProps> = {
  documents: Array.from({ length: 120 }, (_, index) => ({
    id: `topic-${index}`,
    title: index % 3 === 0 ? `${long} ${index}` : index % 3 === 1 ? `${"x".repeat(90)}${index}` : `共有の設定 ${index}`,
    ...(index % 2 ? { description: `${long} – ${long}` } : {}),
    kind: (["task", "reference", "start", "troubleshoot"] as const)[index % 4],
    order: index,
    url: `/api/help/v1/spaces/documents/topic-${index}`,
    searchUrl: "/api/help/v1/spaces/search",
    locale: "en",
  })),
  view: ["topic-0", "topic-1", "topic-2"],
  app: { id: "spaces", name: "Kundenbeziehungsmanagementwerkzeugkasten", icon: "ti ti-layout-kanban" },
  initialArticle: undefined,
};
