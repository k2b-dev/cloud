import type { CloudSearchTag } from "@k2b/cloud/browser/composer-insert";
import { Chat, type ChatMention, LocaleProvider } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { assistantBuiltInCommands, assistantCommandScopes, assistantCommandSections, assistantInsertCommands } from "./composer-commands";
import { assistantCopyFor } from "./ui-copy";

/**
 * The Assistant's slash list with its real Insert rows, sections and scopes, for a browser test that answers
 * `/api/search` itself. `?full` fills the message with 16 attachments; `?running` runs a response.
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
    attachmentCount,
    partCount: attachmentCount + mentions().length,
    excludeRefs: () => [],
    fileSelectionDisabled: running,
  }),
);
const failed = () => Promise.reject(new Error("Not part of this page"));
Object.assign(window, { harness: { value, mentions } });

render(
  () => (
    <LocaleProvider locale={locale}>
      <div style={{ "max-width": "44rem", margin: "0 auto", "padding-top": "calc(100dvh - 9rem)" }}>
        <Chat.Composer
          value={value()}
          onValueChange={setValue}
          mentions={mentions()}
          onMentionsChange={setMentions}
          commandSections={assistantCommandSections(copy)}
          commandScopes={[...assistantCommandScopes(copy, locale), ...insert().scopes]}
          commandFallback={insert().fallback}
          commands={[
            ...insert().commands,
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
          searchCommands={async () => []}
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
