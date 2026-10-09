import type { ChatDictationState, ChatMention } from "@k2b/ui";
import {
  Button,
  Chat,
  type ChatTimelineItem,
  CodeDisplay,
  EmojiPicker,
  MessageRow,
  ProgressBar,
  ProgressRing,
  rememberEmoji,
  Toolbar,
} from "@k2b/ui";
import { createSignal, For, onCleanup } from "solid-js";
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
          mentions={mentions()}
          onMentionsChange={setMentions}
          accessory={
            <Chat.Tasks
              items={[{ id: "draft", content: "Draft the release notes", status: "in_progress" }]}
              open={tasksOpen()}
              onOpenChange={setTasksOpen}
              label="Tasks"
              progressLabel="0/1"
              statusLabels={{ pending: "Pending", in_progress: "In progress", completed: "Completed", cancelled: "Cancelled" }}
            />
          }
          models={[
            { id: "fast", label: "Fast", image: "/assets/logo.svg" },
            { id: "deep", label: "Deep", description: "More reasoning" },
          ]}
          selectedModelId={model()}
          onModelChange={setModel}
          modelDetails={
            <Chat.ContextPopup
              aria-label="Usage: 35%"
              content={
                <Chat.ContextPanel title="Usage">
                  <section>
                    <dl>
                      <div>
                        <dt>Used</dt>
                        <dd>35%</dd>
                      </div>
                    </dl>
                    <ProgressBar value={35} size="xs" label="Usage" />
                    <p>Resets in 5 hours</p>
                  </section>
                </Chat.ContextPanel>
              }
            >
              <ProgressRing value={35} />
            </Chat.ContextPopup>
          }
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
            {
              name: "release-notes",
              label: "Release notes",
              description: "Skill · Write concise release notes",
              icon: "ti ti-sparkles",
              mention: { id: "release-notes", name: "Release notes", kind: "resource", icon: "ti ti-sparkles" },
            },
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
            const reply = `demo-reply-${messages().length}`;
            setMessages((current) => [
              ...current,
              {
                kind: "message",
                id: `demo-${current.length}`,
                role: "user",
                content: <p>{text}</p>,
                timeLabel: "now",
              },
              { kind: "message", id: reply, role: "assistant", status: "streaming", content: <p>Reading the message.</p> },
            ]);
            // A record with the same id updates its row in place: the reply keeps its element when it completes.
            setTimeout(() => {
              setMessages((current) =>
                current.map((item) =>
                  item.id === reply
                    ? {
                        kind: "message",
                        id: reply,
                        role: "assistant",
                        content: <p>Noted. The host owns what happens next.</p>,
                        actions: [{ id: "copy", label: "Copy", icon: "ti ti-copy", copyText: "Noted. The host owns what happens next." }],
                      }
                    : item,
                ),
              );
            }, 1200);
          }}
        />
      </Chat>
    </DemoCard>
  );
};

const ConversationComposerDemo = () => {
  const [draft, setDraft] = createSignal("");
  const [sent, setSent] = createSignal<string[]>([]);
  const [dictation, setDictation] = createSignal<ChatDictationState | null>(null);
  const [hint, setHint] = createSignal<string | undefined>();
  const [sendKey, setSendKey] = createSignal<"enter" | "mod-enter">("enter");
  const [emojiTarget, setEmojiTarget] = createSignal<{ anchor: HTMLElement; insert: (text: string) => void }>();
  const [recent, setRecent] = createSignal<readonly string[]>([]);
  const remember = (emoji: string) => setRecent(rememberEmoji(recent(), emoji));
  let original = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  // Stands in for live dictation: the application owns the audio, the text, and the refinement.
  const dictate = () => {
    if (dictation() !== "listening") {
      original = draft();
      setDraft(`${original}${original ? " " : ""}so we can unload the new saw at seven`);
      setDictation("listening");
      return;
    }
    setDictation("refining");
    timer = setTimeout(() => {
      setDraft(`${original}${original ? " " : ""}So we can unload the new saw at 7:00.`);
      setDictation("refined");
    }, 900);
  };
  return (
    <DemoCard
      id="chat-conversation-composer"
      chip={{ kind: "component", name: "Chat.Composer", from: "@k2b/ui" }}
      description='The conversation variant: one row with attach, a pill field that grows from one line to a third of its size container, and Send. "Aa" opens one formatting row above the field, emoji and microphone sit inside it, and a hint line never moves it. Type :tada: or :dau for emoji. Tap the microphone to dictate, hold it for a voice message.'
      code={`<Chat.Composer
  variant="conversation"
  value={draft()}
  onValueChange={setDraft}
  onSubmit={({ text }) => send(text)}
  sendKey={settings.sendKey}
  formatting
  emoji={{ onOpen: setEmojiTarget, onPick: remember }}
  microphone={{ onDictate: dictation.toggle, onVoiceMessage: recordVoiceMessage, dictation: dictation.state(), onRestoreOriginal: dictation.restore }}
  hint={hint()}
  placeholder="Message Workshop"
/>
<EmojiPicker.Popover
  anchor={emojiTarget()?.anchor}
  recent={recent()}
  onPick={(emoji) => {
    emojiTarget()?.insert(emoji);
    remember(emoji);
  }}
  onClose={() => setEmojiTarget(undefined)}
/>`}
    >
      <div style={{ display: "flex", "flex-direction": "column", gap: "0.75rem" }}>
        <Toolbar label="Composer settings" wrap>
          <Button size="sm" variant="subtle" onClick={() => setHint(hint() ? undefined : "People without access see only “No access”.")}>
            Toggle a hint
          </Button>
          <Button size="sm" variant="subtle" onClick={() => setDictation(dictation() === "interrupted" ? null : "interrupted")}>
            Interrupt dictation
          </Button>
          <Button size="sm" variant="subtle" onClick={() => setSendKey(sendKey() === "enter" ? "mod-enter" : "enter")}>
            {sendKey() === "enter" ? "Enter sends" : "Ctrl/⌘+Enter sends"}
          </Button>
        </Toolbar>
        <div style={{ display: "flex", "flex-direction": "column", height: "26rem", "container-type": "size" }}>
          <div style={{ flex: "1", "min-height": "0", overflow: "auto" }}>
            <For each={sent()}>{(text) => <MessageRow author={{ name: "Robin Example" }} own text={text} time="now" groupStart />}</For>
          </div>
          <Chat.Composer
            variant="conversation"
            value={draft()}
            onValueChange={(value) => {
              setDraft(value);
              if (dictation() !== "listening" && dictation() !== "refining") setDictation(null);
            }}
            onSubmit={({ text }) => {
              if (!text.trim()) return false;
              setSent((current) => [...current, text]);
              setDictation(null);
            }}
            sendKey={sendKey()}
            formatting
            fileSelection={{ onSelect: () => undefined }}
            emoji={{ onOpen: setEmojiTarget, onPick: remember }}
            microphone={{
              onDictate: dictate,
              onVoiceMessage: () => setHint("A voice message would start recording now."),
              dictation: dictation(),
              onRestoreOriginal: () => {
                setDraft(`${original}${original ? " " : ""}so we can unload the new saw at seven`);
                setDictation(null);
              },
            }}
            hint={hint()}
            placeholder="Message Workshop"
          />
          <EmojiPicker.Popover
            anchor={emojiTarget()?.anchor}
            recent={recent()}
            onPick={(emoji) => {
              emojiTarget()?.insert(emoji);
              remember(emoji);
            }}
            onClose={() => setEmojiTarget(undefined)}
          />
        </div>
      </div>
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
      <ConversationComposerDemo />
    </DemoGrid>
  ),
  "context-usage": () => (
    <DemoGrid columns="one">
      <ContextUsageDemo />
    </DemoGrid>
  ),
};

export default demos;
