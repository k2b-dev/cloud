import type { AssistantContentBlock } from "@k2b/nessi/ai";
import type { AiStoredMessage, AiToolPresentation } from "../types";

/**
 * Invented chats for the chat gallery: the states of the Gustav chat in one place, for browser tests and screenshots.
 * Names, mails, and amounts are fictional.
 */

type Part = AiStoredMessage["message"];

let seq = 0;
const at = (minute: number) => `2026-11-13T09:${String(minute).padStart(2, "0")}:00.000Z`;

const stored = (message: Part, options: { loopId?: string; minute?: number; meta?: AiStoredMessage["meta"] } = {}): AiStoredMessage => {
  seq += 1;
  const entry: AiStoredMessage = {
    id: `gallery-${seq}`,
    shortId: `g${seq}`,
    conversationId: "gallery",
    seq,
    kind: "message",
    message,
    loopId: options.loopId ?? null,
    modelId: "fictional-model",
    providerModel: "fictional-model",
    usage: null,
    stopReason: message.role === "assistant" ? "stop" : null,
    loopAggregate: null,
    loopDoneReason: message.role === "assistant" ? "stop" : null,
    compactedAt: null,
    meta: options.meta ?? {},
    createdAt: at(options.minute ?? seq),
  };
  return entry;
};

const user = (text: string) => stored({ role: "user", content: [{ type: "text", text }] });

const app = (appId: string, appName: string, appIcon: string, appAccent: string, title: string): AiToolPresentation => ({
  kind: "capability",
  appId,
  appName,
  appIcon,
  appAccent,
  title,
  capabilityKind: "query",
});

const mail = (title: string) => app("mail", "Mail", "ti ti-mail", "var(--app-mail, #1d4ed8)", title);
const files = (title: string) => app("files", "Dateien", "ti ti-folder", "var(--app-files, #b45309)", title);
const spaces = (title: string) => app("spaces", "Spaces", "ti ti-layout-kanban", "var(--app-spaces, #0f766e)", title);

type Call = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  isError?: boolean;
  presentation?: AiToolPresentation;
};

/** One assistant turn: thinking, the calls with their results, and the answer. */
const turn = (loopId: string, calls: Call[], answer: string, thinking?: string): AiStoredMessage[] => {
  const presentations = Object.fromEntries(calls.flatMap((call) => (call.presentation ? [[call.id, call.presentation]] : [])));
  const content: AssistantContentBlock[] = [
    ...(thinking ? [{ type: "thinking" as const, thinking }] : []),
    ...calls.map((call) => ({ type: "tool_call" as const, id: call.id, name: call.name, args: call.args })),
  ];
  return [
    stored({ role: "assistant", content }, { loopId, meta: { toolPresentations: presentations } }),
    ...calls.map((call) =>
      stored({ role: "tool_result", callId: call.id, name: call.name, result: call.result, isError: call.isError ?? false }, { loopId }),
    ),
    stored({ role: "assistant", content: [{ type: "text", text: answer }] }, { loopId }),
  ];
};

const messestandThread = { type: "mail.thread", id: "messestand-koeln" };
const angebotFile = { type: "files.file", id: "angebot-2026-118" };

/** `#g-antwort`: a question, five steps (one without access), an answer with two sources. */
export const answerChat = (): AiStoredMessage[] => {
  seq = 0;
  return [
    user("Was hat Jana zum Angebot für den Messestand gefragt? Und was kostet uns die Beleuchtung?"),
    ...turn(
      "turn-answer",
      [
        {
          id: "call-search",
          name: "mail__query__search",
          args: { query: "Messestand" },
          result: { summary: "3 Unterhaltungen gefunden" },
          presentation: mail("In Mail suchen"),
        },
        {
          id: "call-read",
          name: "mail__query__thread",
          args: { title: "Messestand Köln" },
          result: { ref: messestandThread, href: "/open/mail.thread/~messestand-koeln", title: "Messestand Köln · Jana Berger" },
          presentation: mail("Unterhaltung lesen"),
        },
        {
          id: "call-file",
          name: "files__query__read",
          args: { title: "Angebot-2026-118.pdf" },
          result: { ref: angebotFile, href: "/open/files.file/~angebot-2026-118", title: "Angebot-2026-118.pdf", summary: "4 Seiten" },
          presentation: files("Datei lesen"),
        },
        {
          id: "call-space",
          name: "spaces__query__tasks",
          args: { title: "Messe" },
          result: { error: "forbidden" },
          isError: true,
          presentation: spaces("Aufgaben suchen"),
        },
      ],
      [
        "Jana Berger fragt zwei Dinge [1](/open/mail.thread/~messestand-koeln):",
        "",
        "- ob der Aufbau am **Sonntag, 15.11.** möglich ist",
        "- ob die Beleuchtung im Preis enthalten ist",
        "",
        "## Was im Angebot steht",
        "",
        "Der Aufbau ist ab Samstag möglich. Die Beleuchtung ist Position 4 und kostet **480,00 €** netto [2](/open/files.file/~angebot-2026-118).",
        "",
        "Soll ich ihr eine kurze Antwort entwerfen und das Angebot anhängen?",
      ].join("\n"),
      "Jana fragt nach dem Messestand. Ich suche die Mail und das Angebot.",
    ),
  ];
};

/** An answer, then a routine's result delivered into the same chat: only the answer can be given again. */
export const routineChat = (): AiStoredMessage[] => [
  ...answerChat(),
  stored(
    { role: "assistant", content: [{ type: "text", text: "Wochenbericht: 3 neue Anfragen zum Messestand." }] },
    {
      loopId: "turn-routine",
      meta: {
        scheduledTask: {
          taskId: "wochenbericht",
          occurrenceId: "wochenbericht-46",
          scheduledFor: "2026-11-13T10:00:00.000Z",
          trigger: "scheduled",
        },
      },
    },
  ),
];

export const galleryScenes = {
  antwort: answerChat,
  routine: routineChat,
} satisfies Record<string, () => AiStoredMessage[]>;

export type GalleryScene = keyof typeof galleryScenes;
