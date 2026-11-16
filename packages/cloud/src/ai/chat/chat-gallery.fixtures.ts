import type { AssistantContentBlock } from "@k2b/nessi/ai";
import type { AiActiveTurn } from "../client/projection";
import type { AiTurnBlock } from "../protocol";
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

const app = (
  appId: string,
  appName: string,
  appIcon: string,
  appAccent: string,
  title: string,
  doneTitle?: string,
): AiToolPresentation => ({
  kind: "capability",
  appId,
  appName,
  appIcon,
  appAccent,
  title,
  capabilityKind: "query",
  ...(doneTitle ? { doneTitle } : {}),
});

const mail = (title: string, doneTitle?: string) => app("mail", "Mail", "ti ti-mail", "var(--app-mail, #1d4ed8)", title, doneTitle);
const files = (title: string, doneTitle?: string) => app("files", "Dateien", "ti ti-folder", "var(--app-files, #b45309)", title, doneTitle);
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
          presentation: mail("In Mail suchen", "In Mail gesucht"),
        },
        {
          id: "call-read",
          name: "mail__query__thread",
          args: { title: "Messestand Köln" },
          result: { ref: messestandThread, href: "/open/mail.thread/~messestand-koeln", title: "Messestand Köln · Jana Berger" },
          presentation: mail("Unterhaltung lesen", "Unterhaltung gelesen"),
        },
        {
          id: "call-file",
          name: "files__query__read",
          args: { title: "Angebot-2026-118.pdf" },
          result: { ref: angebotFile, href: "/open/files.file/~angebot-2026-118", title: "Angebot-2026-118.pdf", summary: "4 Seiten" },
          presentation: files("Datei lesen", "Datei gelesen"),
        },
        {
          id: "call-space",
          name: "spaces__query__tasks",
          args: { title: "Messe" },
          result: "FORBIDDEN: Kein Zugriff auf den Space Messe.",
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

/** `#g-anhaenge`: a photo and a PDF go along with the question. */
const attachmentChat = (): AiStoredMessage[] => {
  seq = 0;
  return [
    stored({
      role: "user",
      content: [
        { type: "text", text: '<attachment path="/uploads/vase.jpg" media-type="image/jpeg" size="482133" />' },
        { type: "text", text: '<attachment path="/uploads/Nachlass-Liste.pdf" media-type="application/pdf" size="126204" />' },
        { type: "text", text: "Was ist diese Vase wert? Sie steht auf Seite 2 der Liste." },
      ],
    }),
  ];
};

const QUESTION = "Was hat Jana zum Angebot für den Messestand gefragt? Und was kostet uns die Beleuchtung?";

/** A live turn that started `seconds` ago with these blocks. */
const live = (blocks: AiTurnBlock[], seconds: number): AiActiveTurn => ({
  turnId: "turn-live",
  attempt: 1,
  seq: 10,
  status: "running",
  blocks,
  modelId: "fictional-model",
  createdAt: new Date(Date.now() - seconds * 1000).toISOString(),
});

const searchBlock: AiTurnBlock = {
  id: "tool-search",
  kind: "tool",
  callId: "call-search",
  name: "mail__query__search",
  args: { query: "Messestand" },
  status: "completed",
  result: { summary: "3 Unterhaltungen gefunden" },
  presentation: mail("In Mail suchen", "In Mail gesucht"),
};

const readingBlock: AiTurnBlock = {
  id: "tool-file",
  kind: "tool",
  callId: "call-file",
  name: "files__query__read",
  args: { title: "Angebot-2026-118.pdf" },
  status: "running",
  presentation: files("Datei lesen", "Datei gelesen"),
};

export type GalleryChat = { messages: AiStoredMessage[]; active?: AiActiveTurn };

/** The answer cut short: by the person (stopped) or by the model service (failed), after the first paragraph. */
const cutAnswer = (ending: "stopped" | "failed"): AiStoredMessage[] => {
  const chat = answerChat();
  const last = chat.at(-1)!;
  const message = last.message;
  if (message.role !== "assistant") return chat;
  return [
    ...chat.slice(0, -1),
    {
      ...last,
      message: { ...message, content: [{ type: "text", text: "Jana Berger fragt zwei Dinge [1](/open/mail.thread/~messestand-koeln):" }] },
      loopDoneReason: ending === "stopped" ? "aborted" : "error",
      meta: ending === "failed" ? { turnError: { code: "model_unavailable" } } : {},
    },
  ];
};

/** Opened work with folded rows: housekeeping, one file read in three parts, and steps of their own. */
const stepsChat = (): AiStoredMessage[] => {
  seq = 0;
  const part = (id: string, offset: number): Call => ({
    id,
    name: "read_file",
    args: { path: "/Angebote/Angebot-2026-118.pdf", offset, length: 4000 },
    result: { content: "…" },
  });
  return [
    user("Was kostet uns die Beleuchtung am Messestand?"),
    ...turn(
      "turn-steps",
      [
        { id: "call-tools", name: "search_tools", args: { query: "mail" }, result: { tools: [] } },
        { id: "call-load", name: "load_tools", args: { names: ["mail__query__search"] }, result: { loaded: 1 } },
        {
          id: "call-search",
          name: "mail__query__search",
          args: { query: "Messestand" },
          result: { summary: "3 Unterhaltungen gefunden" },
          presentation: mail("In Mail suchen", "In Mail gesucht"),
        },
        part("call-part-1", 0),
        part("call-part-2", 4000),
        part("call-part-3", 8000),
      ],
      "Die Beleuchtung ist Position 4 und kostet **480,00 €** netto.",
      "Ich suche das Angebot und lese die Preise.",
    ),
  ];
};

/** `#summe/neu` (Feinschliff 4): Gustav prepares a new automation and tries it on three examples. Fictional data. */
const automationChat = (): AiStoredMessage[] => {
  seq = 0;
  const codeId = "lieferavise";
  const examples = {
    passed: 3,
    total: 3,
    summary: "3 von 3 Beispielen erfolgreich",
    explanation: "Erfolgreich heißt: Die Automation hat getan, was Gustav für den Fall erwartet hat.",
    items: ["Lieferavis von Holzhandel Nord", "Rechnung von Lackfabrik Süd", "Lieferavis ohne Nummer"].map((name) => ({
      name,
      state: "succeeded",
      status: "Erfolgreich",
      sentence: "Wie erwartet einsortiert",
      differences: [],
    })),
  };
  return [
    user("Sortiere neue Lieferavise im Postfach info@ automatisch in den Ordner „Wareneingang“."),
    ...turn(
      "turn-automation",
      [
        {
          id: "code-init",
          name: "code_init",
          args: { title: "Lieferavise sortieren" },
          result: { config: { codeId, baseVersionId: null } },
        },
        { id: "code-write", name: "code_write", args: { codeId }, result: { version: 1, draft: { codeId, baseVersionId: null } } },
        {
          id: "code-check",
          name: "code_check",
          args: { codeId },
          result: { words: { mayDo: [{ text: "Mail im Postfach info@ lesen und verschieben", isNew: true }] } },
        },
        { id: "code-test", name: "code_test", args: { codeId }, result: { ok: true, words: { notices: [], examples } } },
      ],
      "Die Automation ist fertig und wartet auf deine Freigabe. Sie verschiebt nur Mails, die ein Lieferavis sind.",
    ),
  ];
};

export const galleryScenes = {
  /** Opened work with folded rows (housekeeping, a file read in parts). */
  schritte: () => ({ messages: stepsChat() }),
  /** `#g-antwort/gestoppt` */
  gestoppt: () => ({ messages: cutAnswer("stopped") }),
  /** `#g-antwort/fehler` */
  fehler: () => ({ messages: cutAnswer("failed") }),
  /** `#g-anhaenge` */
  anhaenge: () => ({ messages: attachmentChat() }),
  antwort: () => ({ messages: answerChat() }),
  routine: () => ({ messages: routineChat() }),
  /** `#summe/neu`: the work line names a prepared automation and its examples. */
  automation: () => ({ messages: automationChat() }),
  /** `#g-antwort/denkt`: the turn started and Gustav thinks. */
  denkt: () => {
    seq = 0;
    return { messages: [user(QUESTION)], active: live([], 4) };
  },
  /** `#g-antwort/arbeitet`: Gustav searched Mail and reads the offer. */
  arbeitet: () => {
    seq = 0;
    return {
      messages: [user(QUESTION)],
      active: live([{ id: "thinking-1", kind: "thinking", text: "Ich suche die Mail und das Angebot." }, searchBlock, readingBlock], 7),
    };
  },
} satisfies Record<string, () => GalleryChat>;

export type GalleryScene = keyof typeof galleryScenes;
