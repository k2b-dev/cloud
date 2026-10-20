import { type CloudSearchTag, cloudCommandMenu, createCloudComposerCatalog } from "@k2b/cloud/browser/composer-insert";
import { Chat, type ChatMention, LocaleProvider } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import { render } from "solid-js/web";
import {
  assistantBuiltInCommands,
  assistantCommandScopes,
  assistantCommandSections,
  assistantComposerCommands,
  assistantDraftRefs,
  assistantInsertCommands,
  assistantRecentCommands,
  createAssistantCommandSession,
  createAssistantRecentResources,
  createAssistantTaskRunKeys,
} from "./composer-commands";
import { assistantCopyFor } from "./ui-copy";

/**
 * The Assistant's slash list with its real Insert rows, sections and scopes, for a browser test that answers
 * `/api/search` itself. `?full` fills the message with 16 attachments; `?running` runs a response. `?recent` loads the
 * checked recent references, Skills and routines from the test server, as the workspace does when the composer appears.
 */
const params = new URLSearchParams(location.search);
const locale = document.documentElement.lang || "de";
const copy = assistantCopyFor(locale);
const tags: CloudSearchTag[] = [
  {
    appId: "notebooks",
    appName: "Notebooks",
    appIcon: "ti ti-notebook",
    tag: "note",
    title: "Notizen",
    description: "",
    aliases: ["notes", "markdown"],
  },
  {
    appId: "notebooks",
    appName: "Notebooks",
    appIcon: "ti ti-notebook",
    tag: "notebook",
    title: "Notizbücher",
    description: "",
    aliases: ["notebooks"],
  },
  {
    appId: "contacts",
    appName: "Kontakte",
    appIcon: "ti ti-address-book",
    tag: "contact",
    title: "Kontakte",
    description: "",
    aliases: ["addressbook"],
  },
  {
    appId: "spaces",
    appName: "Spaces",
    appIcon: "ti ti-layout-kanban",
    tag: "task",
    title: "Aufgaben",
    description: "",
    aliases: ["tasks", "kanban"],
  },
];
const [value, setValue] = createSignal(params.get("text") ?? "Ja, nimm die Preise aus ");
const [mentions, setMentions] = createSignal<readonly ChatMention[]>([]);
const attachmentCount = params.has("full") ? 16 : 0;
const running = params.has("running");
const models = [{ id: "standard", label: "Für die meisten Aufgaben" }];
const insert = createMemo(() =>
  assistantInsertCommands({
    copy,
    locale,
    tags,
    partCount: () => attachmentCount + mentions().length,
    excludeRefs: () => [],
    fileSelectionDisabled: running,
  }),
);
const catalog = createCloudComposerCatalog();
if (params.has("commands")) {
  const shell = document.createElement("script");
  shell.id = "cloud-shell-data";
  shell.textContent = JSON.stringify({
    apps: ["spaces", "notebooks", "contacts", "mail", "assistant"].map((id) => ({ id })),
    appId: "assistant",
  });
  document.body.append(shell);
}
const appCommands = createMemo(() =>
  cloudCommandMenu({
    locale,
    commands: catalog.commands(),
    state: catalog.state(),
    section: "apps",
    before: async () => {},
    returnTo: () => "/app/assistant?conversation=chat01",
  }),
);
const failed = () => Promise.reject(new Error("Not part of this page"));
const withRecent = params.has("recent");
const recent = createAssistantRecentResources();
if (withRecent) recent.ensure(locale);
const sessionLoader = createAssistantCommandSession();
const runKeys = createAssistantTaskRunKeys();
const partCount = () => attachmentCount + mentions().length;
const draftRefs = () => assistantDraftRefs([], mentions());
Object.assign(window, { harness: { value, mentions, recentLoaded: () => recent.items() !== undefined } });

render(
  () => (
    <LocaleProvider locale={locale}>
      <div style={{ "max-width": "44rem", margin: "0 auto", "padding-top": "calc(100dvh - 9rem)" }}>
        <Chat.Composer
          value={value()}
          onValueChange={setValue}
          mentions={mentions()}
          onMentionsChange={setMentions}
          commandSections={assistantCommandSections(copy, params.has("commands") && appCommands().pending)}
          commandScopes={[...assistantCommandScopes(copy, locale), ...insert().scopes]}
          commandFallback={insert().fallback}
          commands={[
            ...assistantRecentCommands({ items: recent.items(), excludeRefs: draftRefs(), partCount, locale }),
            ...insert().commands,
            ...(params.has("commands") ? appCommands().commands : []),
            ...assistantBuiltInCommands({
              copy,
              projectComposer: false,
              running,
              recording: false,
              hasMessages: true,
              hasAssistantMessage: true,
              models,
              selectedModelId: "standard",
              searchChat: () => {},
              compact: failed,
              fork: failed,
              newChat: failed,
            }),
          ]}
          searchCommands={async (query, signal, search) => {
            if (params.has("commands")) await catalog.ready(query, search, locale);
            if (!withRecent) return [];
            const recentAtOpening = recent.opened(search, locale);
            return assistantComposerCommands({
              query,
              scope: search.scope,
              session: search.opening,
              sessionLoader,
              runKeys,
              models,
              selectedModelId: "standard",
              chooseModel: () => {},
              isRunning: () => running,
              signal,
              locale,
              projects: [],
              assignProject: async () => {},
              running,
              recent: recent.items(),
              recentAtOpening,
              excludeRefs: draftRefs(),
              partCount,
            });
          }}
          fileSelection={{ onSelect: () => {}, choose: async () => [], disabled: running }}
          models={models}
          selectedModelId="standard"
          state={running ? "running" : "idle"}
          onSubmit={() => {}}
        />
      </div>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
