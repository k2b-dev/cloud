import type { ChatCommand, ChatDictationState, ChatMention } from "@k2b/ui";
import {
  Button,
  Chat,
  type ChatDecisionState,
  type ChatTimelineItem,
  CodeDisplay,
  EmojiPicker,
  MessageRow,
  ProgressBar,
  ProgressRing,
  ReferenceChip,
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

const demoSkills: ChatCommand[] = [
  {
    id: "release-notes",
    name: "release-notes",
    label: "Release notes",
    section: "skills",
    description: "Write concise release notes",
    icon: "ti ti-sparkles",
    mention: { id: "release-notes", name: "Release notes", kind: "resource", icon: "ti ti-sparkles" },
  },
];
const demoSections = [
  { id: "skills", label: "Skills", searched: true },
  { id: "chat", label: "This chat" },
];
const demoScopes = [{ id: "skill", title: "Skills", words: ["skill", "skills"] }];

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
    commandSections={sections}
    commandScopes={scopes}
    searchCommands={async (query, signal, { scope }) => findCommands(query, signal, scope)}
    contextUsage={{ usage: usage(), contextWindow: 128_000 }}
  />
</Chat>`}
    >
      <Chat class="ui-chat-demo">
        <Chat.Timeline items={messages()} conversationKey="fibel-demo" />
        <Chat.Composer
          value={draft()}
          onValueChange={setDraft}
          placeholder="Try / or /skill release"
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
          commandSections={demoSections}
          commandScopes={demoScopes}
          searchCommands={async (query, _signal, { scope }) =>
            !scope || scope === "skill" ? demoSkills.filter((row) => row.label?.toLowerCase().includes(query.toLowerCase())) : []
          }
          commands={[
            { name: "skills", label: "Choose a skill", description: "Search the Skills list", section: "chat", scope: "skill" },
            {
              name: "summarize",
              label: "Summarize chat",
              description: "Summarize the current conversation",
              section: "chat",
              reason: "Available once the chat has more messages",
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
      description='The conversation variant: one row with attach, a pill field that grows from one line to a third of its size container, and Send. "Aa" opens Bold, Italic and List in a row above the field, emoji and microphone sit inside it, and a hint line never moves it. Type :tada: or :dau for emoji. Tap the microphone to dictate, hold it for a voice message.'
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

const MailDecisionDemo = () => {
  const [state, setState] = createSignal<ChatDecisionState>("open");
  const [current, setCurrent] = createSignal("running");
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const send = () => {
    setCurrent("running");
    setState("sending");
    timer = setTimeout(() => {
      setCurrent("done");
      setState("decided");
    }, 1200);
  };
  return (
    <DemoCard
      id="chat-mail-decision"
      chip={{ kind: "component", name: "Chat.Decision", from: "@k2b/ui" }}
      description="Review the actual draft, then answer. Sending collapses the question immediately; completion keeps the next paragraph still."
      code={`<Chat.Decision
  state={state()}
  sentence={<>Send <ReferenceChip kind="object" title="Workshop delivery" href="#draft" /> to <ReferenceChip kind="person" name="Lea Berg" />?</>}
  reason={{ text: "You asked to check mail before sending." }}
  preview={<Chat.Preview>
    <Chat.Preview.Header rows={[
      { label: "To", people: [{ name: "Lea Berg", address: "lea@example.com" }] },
      { label: "Bcc", emphasis: true, people: [{ address: "archive@example.com" }] },
    ]} note="Sends immediately after your answer." />
    <Chat.Preview.Title meta="Draft · version 3">Workshop delivery</Chat.Preview.Title>
    <Chat.Preview.Excerpt>Hello Lea, the report is ready for Friday.</Chat.Preview.Excerpt>
    <Chat.Preview.Line icon="ti ti-file-type-pdf" meta="PDF · 240 KB">Delivery report.pdf</Chat.Preview.Line>
    <Chat.Preview.ReadMore href="#draft">Read full draft</Chat.Preview.ReadMore>
  </Chat.Preview>}
  confirm={{ label: "Send to Lea", icon: "ti ti-send", onSelect: send }}
  decline={{ label: "Keep draft", onSelect: () => { setCurrent("declined"); setState("decided"); } }}
  outcome={<Chat.Outcome current={current()} lines={{
    running: { tone: "running", text: "Sending the mail to Lea." },
    done: { tone: "done", text: "Sent the mail to Lea.", time: "09:41" },
    declined: { tone: "off", text: "Kept the draft.", detail: "You declined." },
  }} />}
/>`}
    >
      <Chat.Decision
        state={state()}
        sentence={
          <>
            Send <ReferenceChip kind="object" title="Workshop delivery" icon="ti ti-mail" href="#draft" /> to{" "}
            <ReferenceChip kind="person" name="Lea Berg" />?
          </>
        }
        reason={{ text: "You asked to check mail before sending." }}
        preview={
          <Chat.Preview>
            <Chat.Preview.Header
              rows={[
                { label: "From", people: [{ name: "Robin Example", address: "robin@example.com" }] },
                { label: "To", people: [{ name: "Lea Berg", address: "lea@example.com" }] },
                { label: "Cc", people: [{ name: "Tom Weber", address: "tom@example.com" }] },
                { label: "Bcc", emphasis: true, people: [{ address: "archive@example.com" }] },
              ]}
              note="Sends immediately after your answer."
            />
            <Chat.Preview.Title meta="Draft · version 3">Workshop delivery</Chat.Preview.Title>
            <Chat.Preview.Excerpt>
              {
                "Hello Lea,\nThe delivery is ready for Friday.\nThe report includes the revised quantities.\nPlease check the attached list."
              }
            </Chat.Preview.Excerpt>
            <Chat.Preview.Line icon="ti ti-file-type-pdf" accent="var(--k2b-reference-pdf)" meta="PDF · 240 KB">
              Delivery report.pdf
            </Chat.Preview.Line>
            <Chat.Preview.Line icon="ti ti-alert-triangle" tone="warning">
              The draft includes outside content.
            </Chat.Preview.Line>
            <Chat.Preview.ReadMore href="#chat-mail-decision" title="Open this version of the draft">
              Read full draft
            </Chat.Preview.ReadMore>
            <Chat.Preview.Lines label="What happens next">
              <Chat.Preview.Line icon="ti ti-send" mark="added">
                Lea receives the revised report.
              </Chat.Preview.Line>
              <Chat.Preview.Line icon="ti ti-x" mark="removed" tone="muted">
                The previous attachment is removed.
              </Chat.Preview.Line>
            </Chat.Preview.Lines>
          </Chat.Preview>
        }
        confirm={{ label: "Send to Lea", icon: "ti ti-send", onSelect: send }}
        decline={{
          label: "Keep draft",
          onSelect: () => {
            setCurrent("declined");
            setState("decided");
          },
        }}
        outcome={
          <Chat.Outcome
            current={current()}
            lines={{
              running: { tone: "running", text: "Sending the mail to Lea." },
              done: { tone: "done", text: "Sent the mail to Lea.", time: "09:41" },
              declined: { tone: "off", text: "Kept the draft.", detail: "You declined." },
            }}
          />
        }
      />
      <p>The conversation continues here.</p>
      <Button
        size="sm"
        variant="subtle"
        onClick={() => {
          clearTimeout(timer);
          setState("open");
        }}
      >
        Try again
      </Button>
    </DemoCard>
  );
};

const DecisionPoliciesDemo = () => {
  const [deleteResult, setDeleteResult] = createSignal("done");
  const [deleted, setDeleted] = createSignal(false);
  const [disabledDeclined, setDisabledDeclined] = createSignal(false);
  const [policy, setPolicy] = createSignal("open");
  const [routine, setRoutine] = createSignal("open");
  return (
    <DemoCard
      id="chat-decision-policies"
      chip={{ kind: "component", name: "Chat.Preview", from: "@k2b/ui" }}
      description="Deletion, unavailable answers, a host-owned remember policy, and a routine with visible changes. Each question has its own answer."
      code={`<Chat.Decision state={deleted() ? "decided" : "open"}
  sentence="Delete the old report?"
  reason={{ text: "This permanently deletes the file.", tone: "danger", icon: "ti ti-trash" }}
  confirm={{ label: "Delete report", variant: "danger", onSelect: () => { setDeleted(true); } }}
  decline={{ label: "Keep report", onSelect: keepReport }}
  outcome={<Chat.Outcome current="done" lines={{ done: { tone: "done", text: "Deleted the old report." } }} />}
/>
<Chat.Preview.Sentence>Every <Chat.Mark change="added">Friday</Chat.Mark>, send the report.</Chat.Preview.Sentence>
<Chat.Preview.People people={[{ name: "Lea Berg" }, { name: "Tom Weber" }]}>Lea Berg and Tom Weber</Chat.Preview.People>`}
    >
      <div style={{ display: "grid", gap: "2rem" }}>
        <Chat.Decision
          state={deleted() ? "decided" : "open"}
          sentence="Delete the old report?"
          reason={{ text: "This permanently deletes the file.", tone: "danger", icon: "ti ti-trash" }}
          confirm={{
            label: "Delete report",
            variant: "danger",
            onSelect: () => {
              setDeleted(true);
            },
          }}
          decline={{
            label: "Keep report",
            onSelect: () => {
              setDeleted(true);
              setDeleteResult("kept");
            },
          }}
          outcome={
            <Chat.Outcome
              current={deleteResult()}
              lines={{ done: { tone: "done", text: "Deleted the old report." }, kept: { tone: "off", text: "Kept the old report." } }}
            />
          }
        />
        <Chat.Decision
          state={disabledDeclined() ? "decided" : "open"}
          sentence="Send the draft to Lea?"
          reason={{ text: "You asked to check first." }}
          unavailable={{ text: "Lea no longer has access to the attachment.", tone: "warning", icon: "ti ti-lock" }}
          confirm={{ label: "Send to Lea", onSelect: () => undefined }}
          decline={{
            label: "Keep draft",
            onSelect: () => {
              setDisabledDeclined(true);
            },
          }}
          remember={{ label: "Send without asking next time", onSelect: () => undefined }}
          outcome={<Chat.Outcome current="declined" lines={{ declined: { tone: "off", text: "Kept the draft." } }} />}
        />
        <Chat.Decision
          state={policy() === "open" ? "open" : "decided"}
          sentence="Ask before sharing the report?"
          reason={{ text: "Choose the policy for this chat." }}
          confirm={{
            label: "Ask first",
            variant: "primary",
            onSelect: () => {
              setPolicy("ask");
            },
          }}
          decline={{
            label: "Keep current policy",
            onSelect: () => {
              setPolicy("kept");
            },
          }}
          remember={{
            label: "Yes, and remember for this chat",
            onSelect: () => {
              setPolicy("remembered");
            },
          }}
          outcome={
            <Chat.Outcome
              current={policy()}
              lines={{
                ask: { tone: "done", text: "Will ask before sharing." },
                kept: { tone: "off", text: "Kept the current policy." },
                remembered: { tone: "done", text: "Will ask before sharing in this chat." },
              }}
            />
          }
        />
        <Chat.Decision
          state={routine() === "open" ? "open" : "decided"}
          sentence="Change the weekly report routine?"
          reason={{ text: "Check the new schedule and permissions." }}
          preview={
            <Chat.Preview>
              <Chat.Preview.Title>Weekly report</Chat.Preview.Title>
              <Chat.Preview.Sentence>
                Every <Chat.Mark change="removed">Monday</Chat.Mark> <Chat.Mark change="added">Friday</Chat.Mark>, send the report to{" "}
                <ReferenceChip kind="person" name="Lea Berg" />.
              </Chat.Preview.Sentence>
              <Chat.Preview.People people={[{ name: "Lea Berg" }, { name: "Tom Weber" }]}>Lea Berg and Tom Weber</Chat.Preview.People>
              <Chat.Preview.Lines label="Routine permissions">
                <Chat.Preview.Line icon="ti ti-send" mark="added">
                  May send the weekly report.
                </Chat.Preview.Line>
                <Chat.Preview.Line icon="ti ti-lock" tone="muted">
                  Cannot delete files.
                </Chat.Preview.Line>
              </Chat.Preview.Lines>
            </Chat.Preview>
          }
          confirm={{
            label: "Change routine",
            onSelect: () => {
              setRoutine("done");
            },
          }}
          decline={{
            label: "Keep routine",
            onSelect: () => {
              setRoutine("declined");
            },
          }}
          outcome={
            <Chat.Outcome
              current={routine()}
              lines={{ done: { tone: "done", text: "Changed the weekly routine." }, declined: { tone: "off", text: "Kept the routine." } }}
            />
          }
        />
      </div>
    </DemoCard>
  );
};

const OutcomeStatesDemo = () => {
  const [expiredResult, setExpiredResult] = createSignal("done");
  const [expired, setExpired] = createSignal<ChatDecisionState>("expired");
  const [waiting, setWaiting] = createSignal("waiting");
  const [check, setCheck] = createSignal("failed");
  return (
    <DemoCard
      id="chat-outcome-states"
      chip={{ kind: "component", name: "Chat.Outcome", from: "@k2b/ui" }}
      description="History and recovery: done, declined, expired, answer lost, error, waiting, and a failed check. Each outcome reserves only the lines its own flow can reach."
      code={`<Chat.Outcome current="done" lines={{ done: { tone: "done", text: "Sent the report.", time: "09:41" } }} />
<Chat.Outcome current="declined" lines={{ declined: { tone: "off", text: "Kept the draft.", detail: "You declined." } }} />
<Chat.Outcome current="lost" lines={{ lost: { tone: "warning", text: "Your answer could not be confirmed.", detail: "Check the sent folder before trying again." } }} />
<Chat.Outcome current="error" lines={{ error: { tone: "error", text: "The mail could not be sent.", detail: "The mail service is unavailable." } }} />`}
    >
      <div style={{ display: "grid", gap: "1rem" }}>
        <Chat.Outcome current="done" lines={{ done: { tone: "done", text: "Sent the report.", time: "09:41" } }} />
        <Chat.Outcome current="declined" lines={{ declined: { tone: "off", text: "Kept the draft.", detail: "You declined." } }} />
        <Chat.Decision
          state={expired()}
          sentence="Send the report now?"
          reason={{ text: "The previous question expired." }}
          confirm={{
            label: "Send report",
            onSelect: () => {
              setExpired("decided");
            },
          }}
          decline={{
            label: "Keep draft",
            onSelect: () => {
              setExpiredResult("declined");
              setExpired("decided");
            },
          }}
          outcome={
            <Chat.Outcome
              current={expired() === "expired" ? "expired" : expiredResult()}
              lines={{
                expired: {
                  tone: "off",
                  icon: "ti ti-clock-x",
                  text: "This question expired.",
                  action: {
                    label: "Ask again",
                    onSelect: () => {
                      setExpired("open");
                    },
                  },
                },
                done: { tone: "done", text: "Sent the report." },
                declined: { tone: "off", text: "Kept the draft." },
              }}
            />
          }
        />
        <Chat.Outcome
          current="lost"
          lines={{
            lost: { tone: "warning", text: "Your answer could not be confirmed.", detail: "Check the sent folder before trying again." },
          }}
        />
        <Chat.Outcome
          current="error"
          lines={{ error: { tone: "error", text: "The mail could not be sent.", detail: "The mail service is unavailable." } }}
        />
        <Chat.Outcome
          current={waiting()}
          lines={{
            waiting: {
              tone: "waiting",
              text: "Waiting for Lea to answer.",
              action: {
                label: "Withdraw",
                onSelect: () => {
                  setWaiting("withdrawn");
                },
              },
            },
            withdrawn: { tone: "off", text: "Withdrew the question." },
          }}
        />
        <Chat.Outcome
          current={check()}
          lines={{
            failed: {
              tone: "warning",
              text: "The attachment check failed.",
              actions: (
                <>
                  <Button size="sm" variant="subtle" onClick={() => setCheck("checked")}>
                    Check again
                  </Button>
                  <Button size="sm" variant="subtle" onClick={() => setCheck("cancelled")}>
                    Keep draft
                  </Button>
                </>
              ),
            },
            checked: { tone: "done", text: "The attachment passed the check." },
            cancelled: { tone: "off", text: "Kept the draft." },
          }}
        />
      </div>
    </DemoCard>
  );
};

const ReferenceChipsDemo = () => (
  <DemoCard
    id="chat-reference-chips"
    chip={{ kind: "component", name: "ReferenceChip", from: "@k2b/ui" }}
    description="Objects, places, people, times, a gone object, and a long title cut in the middle. The full title remains the link's accessible name."
    code={`<ReferenceChip kind="object" title="Delivery report.pdf" icon="ti ti-file-type-pdf" href="#report" />
<ReferenceChip kind="place" title="Workshop" icon="ti ti-folder" href="#workshop" />
<ReferenceChip kind="person" name="Lea Berg" href="#lea" />
<ReferenceChip kind="time" label="Friday, 09:00" dateTime="2026-10-16T09:00:00Z" />
<ReferenceChip kind="object" title="Old draft" gone />
<ReferenceChip kind="object" title="Quarterly delivery report for the entire workshop team October 2026.pdf" href="#report" />`}
  >
    <p style={{ display: "flex", "flex-wrap": "wrap", gap: "0.5rem" }}>
      <ReferenceChip
        kind="object"
        title="Delivery report.pdf"
        icon="ti ti-file-type-pdf"
        accent="var(--k2b-reference-pdf)"
        href="#chat-reference-chips"
      />
      <ReferenceChip kind="place" title="Workshop" icon="ti ti-folder" href="#chat-reference-chips" />
      <ReferenceChip kind="person" name="Lea Berg" href="#chat-reference-chips" />
      <ReferenceChip kind="time" label="Friday, 09:00" dateTime="2026-10-16T09:00:00Z" />
      <ReferenceChip kind="object" title="Old draft" gone />
      <ReferenceChip
        kind="object"
        title="Quarterly delivery report for the entire workshop team October 2026.pdf"
        href="#chat-reference-chips"
      />
    </p>
  </DemoCard>
);

const demos: DemoSection = {
  chat: () => (
    <DemoGrid columns="one">
      <MailDecisionDemo />
      <DecisionPoliciesDemo />
      <OutcomeStatesDemo />
      <ReferenceChipsDemo />
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
