import type { ChatMention } from "@k2b/ui";
import { Chat, CodeDisplay, type ChatTimelineItem } from "@k2b/ui";
import { createSignal } from "solid-js";
import { DemoCard } from "../DemoCard";
import { DemoGrid, type DemoSection } from "./types";

const initialItems = (): ChatTimelineItem[] => [
  {
    kind: "message",
    id: "question",
    role: "user",
    content: <p>Which component should own the empty state?</p>,
    timeLabel: "09:41",
    attachments: [
      {
        id: "wireframe",
        name: "empty-state.png",
        kind: "image",
        previewUrl: "/assets/logo.svg",
        alt: "Example attachment",
      },
    ],
    actions: [
      {
        id: "copy-question",
        label: "Copy",
        icon: "ti ti-copy",
        copyText: "Which component should own the empty state?",
      },
    ],
  },
  {
    kind: "activity",
    id: "search",
    label: "Searching component exports",
    description: "search_components · @k2b/ui",
    tone: "ai",
    icon: "ti ti-search",
    trailing: (
      <>
        <i class="ti ti-loader-2 k2b-spin" aria-hidden="true" />
        <span class="k2b-sr-only">Running</span>
      </>
    ),
  },
  {
    kind: "activity",
    id: "inspection",
    label: "Read component source",
    description: "read_file · 3 files · 18 ms",
    tone: "success",
    icon: "ti ti-file-search",
    defaultOpen: true,
    content: (
      <CodeDisplay
        title="Tool result"
        language="text"
        lineNumbers={false}
        code={`Placeholder
  state="empty"
  title="No records"
  description="Create the first record."`}
      />
    ),
  },
  {
    kind: "activity",
    id: "failed-tool",
    label: "Could not read release notes",
    description: "fetch_url · Request returned 404",
    tone: "danger",
    icon: "ti ti-world-x",
    content: <p>The application can render recovery actions or the raw tool error here.</p>,
  },
  {
    kind: "message",
    id: "answer",
    role: "assistant",
    content: <p>Keep the state in the application and render it with the portable Placeholder.</p>,
    timeLabel: "09:42",
    actions: [
      {
        id: "copy-answer",
        label: "Copy",
        icon: "ti ti-copy",
        copyText: "Keep the state in the application and render it with the portable Placeholder.",
      },
    ],
  },
];

const ChatDemo = () => {
  const [draft, setDraft] = createSignal("");
  const [mentions, setMentions] = createSignal<readonly ChatMention[]>([]);
  const [tasksOpen, setTasksOpen] = createSignal(false);
  const [messages, setMessages] = createSignal(initialItems());
  const [model, setModel] = createSignal("fast");
  return (
    <DemoCard
      id="chat"
      chip={[
        { kind: "component", name: "Chat", from: "@k2b/ui" },
        { kind: "component", name: "Chat.Timeline", from: "@k2b/ui" },
        { kind: "component", name: "Chat.Composer", from: "@k2b/ui" },
      ]}
      description="Portable, controlled chat presentation with generic tool activity. The host owns protocol, persistence, uploads, and model execution."
      code={`<Chat>
  <Chat.Timeline items={items()} conversationKey="fibel-demo" />
  <Chat.Composer
    value={draft()}
    onValueChange={setDraft}
    mentions={mentions()}
    onMentionsChange={setMentions}
    accessory={<Chat.Tasks items={tasks} open={tasksOpen()} onOpenChange={setTasksOpen} />}
    placeholder="Write a message…"
    onSubmit={sendMessage}
    models={models}
    selectedModelId={model()}
    onModelChange={setModel}
    fileSelection={{ onSelect: addFiles }}
    menuActions={menuActions}
    commands={commands}
    contextUsage={{ usage: usage(), contextWindow: 128_000 }}
  />
</Chat>`}
    >
      <Chat class="ui-chat-demo">
        <Chat.Timeline items={messages()} conversationKey="fibel-demo" />
        <Chat.Composer
          value={draft()}
          onValueChange={setDraft}
          placeholder="Try: Please use /release-notes"
          mentions={mentions()} onMentionsChange={setMentions}
          accessory={<Chat.Tasks items={[{ id: "draft", content: "Draft the release notes", status: "in_progress" }]} open={tasksOpen()} onOpenChange={setTasksOpen} label="Tasks" progressLabel="0/1" statusLabels={{pending:"Pending",in_progress:"In progress",completed:"Completed",cancelled:"Cancelled"}} />}
          models={[
            { id: "fast", label: "Fast", image: "/assets/logo.svg" },
            { id: "deep", label: "Deep", description: "More reasoning" },
          ]}
          selectedModelId={model()}
          onModelChange={setModel}
          modelDetails={<Chat.ContextPopup aria-label="Model details" class="text-xs text-muted" content={<div style="width:16rem"><strong>Model details</strong><p>The host can explain availability or allowance here.</p></div>}>Details</Chat.ContextPopup>}
          fileSelection={{ onSelect: () => undefined }}
          menuActions={[
            {
              id: "new-chat",
              label: "New chat",
              icon: "ti ti-message-plus",
              onSelect: () => undefined,
            },
          ]}
          commands={[
            { name: "release-notes", label: "Release notes", description: "Skill · Write concise release notes", icon: "ti ti-sparkles", mention: { id: "release-notes", name: "Release notes", kind: "resource", icon: "ti ti-sparkles" } },
            {
              name: "summarize",
              description: "Summarize the current conversation",
              action: ({ setValue }) => setValue("Summarize this conversation"),
            },
          ]}
          contextUsage={{
            modelLabel: model() === "fast" ? "Fast" : "Deep",
            usage: { input: 3_040, output: 180, total: 3_220 },
            contextWindow: 128_000,
          }}
          onSubmit={({ text }) => {
            if (!text) return false;
            setMessages((current) => [
              ...current,
              {
                kind: "message",
                id: `demo-${current.length}`,
                role: "user",
                content: <p>{text}</p>,
                timeLabel: "now",
              },
            ]);
          }}
        />
      </Chat>
    </DemoCard>
  );
};

const ContextUsageDemo = () => (
  <DemoCard
    id="context-usage"
    chip={{ kind: "component", name: "Chat.ContextUsage", from: "@k2b/ui" }}
    description="A compact percentage with an accessible summary and detailed token disclosure in its tooltip."
    code={`<Chat.ContextUsage
  modelLabel="Deep"
  usage={{ input: 18_420, output: 2_140, total: 20_560 }}
  loopUsage={{ total: 31_800 }}
  contextWindow={128_000}
/>`}
  >
    <Chat.ContextUsage
      modelLabel="Deep"
      usage={{ input: 18_420, output: 2_140, total: 20_560 }}
      loopUsage={{ total: 31_800 }}
      contextWindow={128_000}
    />
  </DemoCard>
);

const demos: DemoSection = {
  chat: () => (
    <DemoGrid columns="one">
      <ChatDemo />
    </DemoGrid>
  ),
  "context-usage": () => (
    <DemoGrid columns="one">
      <ContextUsageDemo />
    </DemoGrid>
  ),
};

export default demos;
