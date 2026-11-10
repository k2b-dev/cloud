import type { AiConversation, AiOpenQuestion, AiStoredMessage, AiTurnBlock } from "@k2b/cloud/ai";
import type { AiPeopleModels } from "@k2b/cloud/shared";
import { ButtonLink, LocaleProvider, MobileShell, Placeholder, TabBar, type TabBarItem } from "@k2b/ui";
import { render } from "solid-js/web";
import AssistantPwa, { type AssistantPwaProps } from "./AssistantPwa.island";
import { type PwaAddress, pwaAddress } from "./paths";

/**
 * Test fixture, not product code: the Assistant part in the Cloud app's frame as `PwaLayout` composes it, with
 * invented data and the network replaced. `?screen=` picks the state; `window.harness` lets a test change the
 * network's answers. Every person, chat and file here is made up.
 */
const params = new URLSearchParams(location.search);
const screen = params.get("screen") ?? "start";
const has = (...names: string[]) => names.includes(screen);
type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

const NOW = "2026-11-04T09:41:00.000Z";
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

// ---------------------------------------------------------------- data (invented)
const chat = (id: string, title: string, minutes: number, extra: Partial<AiConversation> = {}): AiConversation => ({
  id,
  shortId: id,
  title,
  titleSource: "user",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: ago(minutes),
  archivedAt: null,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], revision: 0, updatedAt: null },
  createdByUserId: "robin",
  createdAt: ago(minutes + 30),
  updatedAt: ago(minutes),
  ...extra,
});
const CHATS: AiConversation[] = [
  chat("weber", "Angebot Polsterei Weber", 1, {
    runStatus: "running",
    activity: { completed: 2, total: 4, step: "Ich stelle das Angebot aus den Mails und dem Stoffmuster zusammen …", tool: null },
  }),
  chat("retro", "Retro am Freitag absagen", 12, { runStatus: "needs_attention" }),
  chat("urlaub", "Urlaubsplan Dezember", 70, {
    unreadCompletion: true,
    description: "Drei Wochen sind doppelt belegt. Ich habe sie markiert.",
  }),
  chat("rechnung", "Rechnung 2026-118 prüfen", 190, { runStatus: "failed", runError: "Die Datei ließ sich nicht lesen." }),
  chat("lieferanten", "Lieferanten für Leinen", 60 * 26, {
    pinnedAt: ago(60 * 48),
    description: "Hier sind fünf Anbieter mit Mindestmenge und Lieferzeit.",
  }),
  chat("messe", "Messe Köln: Standplan", 60 * 50, { description: "Der Plan passt auf 24 m² mit zwei Sitzinseln." }),
  chat("pflege", "Pflegehinweise für Samt", 60 * 74, { description: "Kurz gesagt: nur trocken bürsten, nie reiben." }),
];

const OLDER: AiConversation[] = [
  chat("kalk", "Kalkulation Eckbank", 60 * 24 * 9, { description: "Material 412 €, Arbeit 9 Stunden." }),
  chat("azubi", "Einarbeitung neue Auszubildende", 60 * 24 * 12, { description: "Plan für die ersten zwei Wochen." }),
  chat("website", "Texte für die Website", 60 * 24 * 20, { description: "Drei Varianten für die Startseite." }),
];
const ALL = [...CHATS, ...OLDER];
const search = (query: string) =>
  ALL.filter((entry) => `${entry.title} ${entry.description}`.toLocaleLowerCase("de").includes(query.toLocaleLowerCase("de")));

declare global {
  interface Window {
    assistantPwaQuestion: ToolBlock;
  }
}
const retroQuestion = window.assistantPwaQuestion;
const retroUser = "Die Retro am Freitag fällt aus, nimm sie raus.";
const retroAssistant = "Die Retro steht einmal im Kalender, nicht als Serie.";
const question: AiOpenQuestion = {
  id: "req-del",
  conversationId: "retro",
  conversationTitle: "Retro am Freitag absagen",
  anchor: retroQuestion.id,
  short: "Termin Retro am 17.10. löschen",
  app: { name: "Spaces", icon: "ti ti-layout-kanban", accent: "#4d7c0f" },
  createdAt: ago(12),
};

const mark = (text: string, color: string) => ({ kind: "mark" as const, text, color });
const models: AiPeopleModels = {
  status: "ok",
  selection: null,
  effectiveDefault: { class: "balanced" },
  classes: [
    { class: "fast", variantId: "small" },
    { class: "balanced", variantId: "oss" },
  ],
  options: [
    { id: "small", label: "Mistral Small", description: "Kurze Antworten, schnell", icon: mark("CO", "#0f766e"), classes: ["fast"] },
    {
      id: "oss",
      label: "GPT-OSS",
      variantLabel: "Ausgewogen",
      description: "Für die meisten Aufgaben",
      icon: mark("CO", "#0f766e"),
      classes: ["balanced"],
    },
  ],
};

const stored = (conversationId: string, seq: number, message: AiStoredMessage["message"], loopId = "turn-1"): AiStoredMessage => ({
  id: `${conversationId}-m${seq}`,
  shortId: `${conversationId}-m${seq}`,
  conversationId,
  seq,
  kind: "message",
  message,
  loopId,
  modelId: null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: message.role === "assistant" ? "stop" : null,
  compactedAt: null,
  meta: null,
  createdAt: ago(60),
});
const capability = (appId: string, appName: string, appIcon: string, appAccent: string, title: string) => ({
  kind: "capability" as const,
  appId,
  appName,
  appIcon,
  appAccent,
  title,
  capabilityKind: "query" as const,
});
const tool = (
  id: string,
  name: string,
  presentation: ReturnType<typeof capability>,
  status: ToolBlock["status"],
  extra: Partial<ToolBlock> = {},
): ToolBlock => ({
  id: `tool-${id}`,
  kind: "tool",
  callId: id,
  name,
  args: {},
  status,
  presentation,
  ...(status === "completed" || status === "failed" ? { at: ago(1) } : {}),
  ...extra,
});
const MAIL = capability("mail", "Mail", "ti ti-mail", "#0f766e", "Mails suchen");
const FILES = capability("files", "Dateien", "ti ti-folder", "#1d4ed8", "Datei lesen");
const SPACES = capability("spaces", "Spaces", "ti ti-layout-kanban", "#4d7c0f", "Aufgaben lesen");
const text = (id: string, value: string): AiTurnBlock => ({ id, kind: "text", text: value });
const LONG_TEXT =
  "Kurz gesagt: Samt nur trocken pflegen und nie reiben.\n\n" +
  "1. **Staub** bürstest du einmal pro Woche mit einer weichen Bürste in Strichrichtung ab.\n" +
  "2. **Flecken** tupfst du sofort mit einem trockenen, hellen Tuch ab. Nicht reiben, sonst bricht der Flor.\n" +
  "3. **Druckstellen** verschwinden, wenn du sie mit Dampf aus 10 cm Abstand anhebst und danach gegen den Strich bürstest.\n" +
  "4. **Wasser** vermeidest du ganz. Ein feuchter Fleck lässt einen Rand.\n" +
  "5. **Sonne** bleicht Samt aus. Stell die Stühle nicht direkt ans Fenster.\n\n" +
  "Für die Kundschaft kann ich daraus eine kurze Karte zum Ausdrucken machen. Sie passt auf A6 und liegt dann jedem Auftrag bei.";
const STREAM_TEXT =
  "Hier ist ein Entwurf für das Angebot an die Polsterei Weber. Ich habe die Maße aus der Mail vom Montag genommen und den Stoff aus deinem Foto erkannt: **Samt „Moos 14“**.\n\n" +
  "| Posten | Menge | Preis |\n|---|---:|---:|\n| Stühle neu beziehen | 12 | 1.140 € |\n| Stoff Samt Moos 14 | 9 m | 486 € |\n| Abholen und Liefern | 1 | 60 € |\n\n" +
  "Für die Lieferzeit schaue ich noch, was in Spaces für die Werkstatt";

/** Core's switch-on preview on a phone: switching on waits for a computer, the targets show here as well. */
const CODE_VERSION = {
  codeId: "c_rechnung",
  title: "Rechnungen ablegen",
  ownerKind: "person",
  automations: [{ entrypoint: "morning", title: "Jeden Morgen um 7 Uhr" }],
  versionId: "33333333-3333-4333-8333-333333333333",
  number: 3,
  running: 2,
  latest: 3,
  activated: null,
  allowed: { allowed: false, reason: "phone" },
  readiness: { state: "ready" },
  place: null,
  targets: [
    {
      target: {
        key: "filesv2.folder\u0000fo_rechnungen",
        ref: { type: "filesv2.folder", id: "fo_rechnungen" },
        title: null,
        typeTitle: "Ordner",
        icon: "ti ti-folder",
        own: false,
        href: null,
      },
      operations: ["filesv2.file.import"],
      isNew: true,
    },
    { target: null, operations: ["mail.message.read"], isNew: false },
  ],
};
type Detail = NonNullable<AssistantPwaProps["initialDetail"]>;
const detailOf = (id: string): Detail | null => {
  const conversation = CHATS.find((entry) => entry.id === id);
  if (!conversation) return null;
  // `serverDraft=1`: the chat keeps a draft saved elsewhere, such as on the web.
  const draft = params.get("serverDraft")
    ? { content: [{ type: "text" as const, text: "Vom Web" }], revision: 2, updatedAt: ago(5) }
    : conversation.draft;
  const base = { conversation: { ...conversation, draft, unreadCompletion: false }, hasMoreMessages: false, timeline: [] };
  // `code=1`: Gustav submitted a Code version and asks one question before it goes on.
  if (id === "pflege" && params.get("code"))
    return {
      ...base,
      messages: [
        stored(id, 1, { role: "user", content: [{ type: "text", text: "Leg Rechnungen aus der Mail jeden Morgen in Dateien ab." }] }, "turn-c"),
      ],
      activeTurn: {
        turnId: "turn-c",
        attempt: 1,
        status: "waiting_for_action",
        seq: 3,
        modelId: "oss",
        createdAt: ago(4),
        waitingSince: ago(1),
        blocks: [
          {
            id: "tool-submit",
            kind: "tool",
            callId: "submit",
            name: "code_submit",
            args: { codeId: "c_rechnung" },
            status: "completed",
            at: ago(2),
            result: { version: 1, submission: { version: { id: CODE_VERSION.versionId, number: CODE_VERSION.number } } },
          },
          text("t1", "Version 3 ist eingereicht. Eine Frage noch:"),
          {
            id: "tool-survey",
            kind: "tool",
            callId: "survey",
            name: "survey",
            frontendMode: "client_interaction",
            status: "awaiting_client",
            args: {
              title: "Ablage",
              submitLabel: "Antworten",
              questions: [{ id: "folder", type: "text", label: "In welchen Ordner?", placeholder: "Ordnername" }],
            },
          },
        ],
      },
    };
  if (id === "pflege")
    return {
      ...base,
      messages: [
        stored(id, 1, { role: "user", content: [{ type: "text", text: "Wie pflege ich Samtbezüge?" }] }),
        stored(id, 2, { role: "assistant", content: [{ type: "text", text: LONG_TEXT }] }),
      ],
      activeTurn: null,
    };
  if (id === "weber")
    return {
      ...base,
      messages: [
        stored(
          id,
          1,
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Schreib mir ein Angebot für die Polsterei Weber: 12 Stühle neu beziehen, mit dem Stoff auf dem Foto.",
              },
            ],
          },
          "turn-w",
        ),
      ],
      activeTurn: {
        turnId: "turn-w",
        attempt: 1,
        status: "running",
        seq: 4,
        modelId: "oss",
        createdAt: ago(1),
        blocks: [
          tool("m1", "mail__query__message_dot_search", MAIL, "completed", { result: { data: { count: 4 } } }),
          tool("f1", "files__query__file_dot_read", FILES, "completed", { result: { data: {} } }),
          tool("s1", "spaces__query__task_dot_list", SPACES, "running", { progress: "Liest 3 von 8 Aufgaben" }),
          text("t1", STREAM_TEXT),
        ],
      },
    };
  if (id === "retro" && params.get("approval")) {
    // The question after an answer: running, done, declined, or with an outcome nobody knows.
    const state = params.get("approval");
    const decided = { ...retroQuestion, approval: undefined, approved: true as const };
    const block: ToolBlock =
      state === "running"
        ? { ...decided, status: "running" }
        : state === "done"
          ? { ...decided, status: "completed", at: ago(0), result: { data: {} } }
          : state === "declined"
            ? { ...decided, approved: undefined, status: "rejected", isError: true, result: "Rejected", at: ago(0) }
            : {
                ...decided,
                status: "failed",
                isError: true,
                at: ago(0),
                result: "ACTION_OUTCOME_UNKNOWN: Die Antwort ging verloren; nicht automatisch erneut ausführen.",
                check: { state: "pending", at: ago(0) },
              };
    const blocks = [text("t1", retroAssistant), block];
    if (state === "done")
      blocks.push(text("t2", "Erledigt. Die Retro ist aus dem Kalender von Team Ops. Soll ich den sechs Leuten kurz absagen?"));
    return {
      ...base,
      messages: [stored(id, 1, { role: "user", content: [{ type: "text", text: retroUser }] }, "turn-r")],
      // The turn goes on after the answer; a finished turn would come back as stored messages instead.
      activeTurn: { turnId: "turn-r", attempt: 1, status: "running", seq: 3, modelId: "oss", createdAt: ago(12), blocks },
    };
  }
  if (id === "retro")
    return {
      ...base,
      messages: [stored(id, 1, { role: "user", content: [{ type: "text", text: retroUser }] }, "turn-r")],
      activeTurn: {
        turnId: "turn-r",
        attempt: 1,
        status: "waiting_for_action",
        seq: 2,
        modelId: "oss",
        createdAt: ago(12),
        waitingSince: ago(12),
        blocks: [text("t1", retroAssistant), retroQuestion],
      },
    };
  if (id === "rechnung")
    return {
      ...base,
      messages: [
        stored(id, 1, { role: "user", content: [{ type: "text", text: "Prüf die Rechnung 2026-118 gegen die Bestellung." }] }, "turn-x"),
      ],
      activeTurn: {
        turnId: "turn-x",
        attempt: 1,
        status: "running",
        seq: 3,
        modelId: "oss",
        createdAt: ago(3),
        blocks: [
          tool("m2", "mail__query__message_dot_search", MAIL, "completed", { result: { data: { count: 1 } } }),
          tool("f2", "files__query__file_dot_read", FILES, "failed", {
            isError: true,
            result: "FILE_TOO_LARGE: Rechnung-2026-118.pdf ist größer als 25 MB und lässt sich nicht lesen.",
          }),
          text("t2", "Die Rechnung selbst konnte ich nicht lesen: Die Datei ist größer als 25 MB."),
        ],
      },
    };
  return { ...base, messages: [], activeTurn: null };
};

// ---------------------------------------------------------------- the screen's starting point
const allQuery = params.get("q") ?? "";
const screenAddress: PwaAddress =
  screen.startsWith("chat-") || screen === "noai-chat" || screen.startsWith("menu")
    ? { level: "chat", id: params.get("chat") ?? (screen === "chat-noaccess" ? "fremd" : "pflege") }
    : screen === "new"
      ? { level: "new" }
      : screen.startsWith("all")
        ? { level: "all", archived: screen === "all-archive", query: allQuery }
        : { level: "start" };
// A reload uses the real address, as the server does; explicit screens still select invented fixture states.
const address = params.has("screen") ? screenAddress : (pwaAddress(new URL(location.href)) ?? screenAddress);
const noAi = has("noai", "noai-admin", "noai-chat");
// `mic=blocked`: the device refuses the microphone, as after a person said no.
if (params.get("mic") === "blocked")
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")),
      enumerateDevices: () => Promise.resolve([]),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
// `record=1`: an audio model is set up, and the microphone hears a steady tone instead of a person.
const recording = Boolean(params.get("record"));
if (recording)
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        const context = new AudioContext();
        const tone = context.createOscillator();
        const output = context.createMediaStreamDestination();
        tone.connect(output);
        tone.start();
        return output.stream;
      },
      enumerateDevices: () => Promise.resolve([]),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
// `standalone=1`: the page runs as the installed app, without browser chrome.
if (params.get("standalone")) {
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query: string) =>
    query === "(display-mode: standalone)" ? Object.create(original(query), { matches: { value: true } }) : original(query);
}
const offline = has("offline", "chat-offline", "chat-approval-offline", "all-offline", "menu-offline", "chat-attach-offline");
if (offline) Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
const empty = has("start-empty");

// ---------------------------------------------------------------- the network: answers a test can change
type Harness = { requests: string[]; fail: Set<string>; hold: Set<string>; release: () => void };
const pending: Array<() => void> = [];
const harness: Harness = {
  requests: [],
  fail: new Set(params.get("fail")?.split(",").filter(Boolean) ?? []),
  hold: new Set(params.get("hold")?.split(",").filter(Boolean) ?? []),
  release: () => {
    for (const resume of pending.splice(0)) resume();
  },
};
(window as unknown as { harness: Harness }).harness = harness;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A stream that stays open and says nothing, like a chat whose answer has not moved on yet. */
const quietStream = () =>
  new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "text/event-stream" } });
let created = 0;
let lost = false;
const dictations: Array<{
  id: string;
  sourcePath: string;
  operationId: string;
  status: string;
  disposition: string;
  text: string | null;
}> = [];
const answer = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  const method = (init?.method ?? "GET").toUpperCase();
  const key = `${method} ${url.pathname}`;
  harness.requests.push(key);
  if (!navigator.onLine) throw new TypeError("Failed to fetch");
  for (const pattern of harness.hold) if (key.includes(pattern)) await new Promise<void>((resolve) => pending.push(resolve));
  // `pattern:status` refuses with that status, such as 422; a bare pattern fails as the server would, with 500.
  for (const entry of harness.fail) {
    const [pattern, status] = entry.split(":");
    if (!pattern || !key.includes(pattern)) continue;
    // `pattern:net` stands for an answer that never comes back.
    if (status === "net") throw new TypeError("Failed to fetch");
    return json({ message: "Invented failure" }, Number(status ?? 500));
  }
  if (url.pathname.endsWith("/stream")) return quietStream();
  if (url.pathname === "/api/code/activation/preview") return json({ data: CODE_VERSION });
  if (url.pathname === "/api/assistant/workspace/sidebar")
    return json({
      conversations: empty ? [] : CHATS,
      projects: [],
      doneCount: 0,
      questions: empty ? { items: [], count: 0 } : { items: [question], count: 1 },
    });
  if (url.pathname === "/api/ai/conversations/page") {
    const perPage = Number(url.searchParams.get("perPage") ?? 20);
    const archived = url.searchParams.get("archived") === "true";
    const query = url.searchParams.get("q") ?? "";
    if (perPage === 1) return json({ total: archived ? 12 : 48, page: 1, perPage, hasNext: true, items: [] });
    const items = archived ? OLDER : query ? search(query) : ALL;
    return json({ total: query ? items.length : 48, page: Number(url.searchParams.get("page") ?? 1), perPage, hasNext: !query, items });
  }
  if (/\/(archive|restore|pin)$/.test(url.pathname)) return json(ALL.find((entry) => url.pathname.includes(`/${entry.id}/`)) ?? {});
  if (method === "POST" && url.pathname === "/api/ai/conversations") {
    created += 1;
    return json(chat(`neu-${created}`, "Neuer Chat", 0));
  }
  const detail = /^\/api\/ai\/conversations\/([^/]+)$/.exec(url.pathname);
  if (detail) {
    const found = detailOf(decodeURIComponent(detail[1]!));
    return found ? json(found) : json({ message: "Not found" }, 404);
  }
  // A recording becomes this text; `transcribe=hold` keeps it on the way, `transcribe=fail` fails it.
  if (/\/dictations$/.test(url.pathname) && method === "POST") {
    const mode = params.get("transcribe");
    const form = init?.body instanceof FormData ? init.body : null;
    dictations.push({
      id: `d${dictations.length + 1}`,
      sourcePath: "/Aufnahme.wav",
      operationId: String(form?.get("operationId") ?? ""),
      status: mode === "hold" ? "running" : mode === "fail" ? "failed" : "succeeded",
      disposition: "pending",
      text: mode ? null : "Verschick sie an alle.",
    });
    return json(dictations.at(-1));
  }
  if (/\/dictations$/.test(url.pathname)) return json({ items: dictations, nextCursor: null });
  const one = /\/dictations\/(d\d+)$/.exec(url.pathname);
  if (one) {
    const found = dictations.find((entry) => entry.id === one[1]);
    return found ? json(found) : json({ message: "Not found" }, 404);
  }
  const applied = /\/dictations\/([^/]+)\/apply$/.exec(url.pathname);
  if (applied) {
    const found = dictations.find((entry) => entry.id === applied[1]);
    const body = JSON.parse(String(init?.body)) as { content: Array<{ type: string; text?: string }> };
    if (found) found.disposition = "applied";
    // `apply=lost`: the first insertion commits, but its answer never comes back.
    if (params.get("apply") === "lost" && !lost) {
      lost = true;
      throw new TypeError("Failed to fetch");
    }
    const text = [...body.content.flatMap((part) => (part.text ? [part.text] : [])), found?.text].filter(Boolean).join("\n\n");
    return json({ disposition: "applied", draft: { content: [{ type: "text", text }], revision: 3, updatedAt: NOW } });
  }
  if (/\/dictations\/discard$/.test(url.pathname)) {
    for (const entry of dictations) entry.disposition = "discarded";
    return json({ disposition: "discarded" });
  }
  if (/\/draft$/.test(url.pathname)) return json({ content: [], revision: 1, updatedAt: NOW });
  if (/\/turns$/.test(url.pathname)) return json({ turn: { id: "turn-new", status: "queued" }, message: null });
  if (/\/viewed$/.test(url.pathname)) return json({});
  return json({});
};
window.fetch = Object.assign(answer, { preconnect: () => {} });
// Uploads report their progress over XMLHttpRequest; `upload=progress` stops at 64 %, `upload=fail` fails.
class FakeUpload extends EventTarget {}
class FakeRequest extends EventTarget {
  upload = new FakeUpload();
  status = 0;
  response: unknown = null;
  responseType = "";
  open() {}
  send(form: FormData) {
    const file = form.get("file");
    const mode = params.get("upload") ?? "ok";
    const size = file instanceof File ? file.size : 1;
    setTimeout(() => {
      if (!navigator.onLine || mode === "fail") {
        this.dispatchEvent(new Event("error"));
        return;
      }
      this.upload.dispatchEvent(Object.assign(new Event("progress"), { lengthComputable: true, loaded: size * 0.64, total: size }));
      if (mode === "progress") return;
      this.status = 200;
      this.response = { file: { path: `/${file instanceof File ? file.name : "file"}`, mediaType: "image/jpeg", size, version: 1 } };
      this.dispatchEvent(new Event("load"));
    }, 50);
  }
  abort() {}
}
(window as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeRequest;
// Live updates connect to Core's socket; here it never opens.
class QuietSocket extends EventTarget {
  readyState = 0;
  send() {}
  close() {}
}
(window as unknown as { WebSocket: unknown }).WebSocket = QuietSocket;

// ---------------------------------------------------------------- the frame, as PwaLayout composes it
const name = params.get("name") ?? "Assistent";
const icon = "ti ti-sparkles";
const parts = (): TabBarItem[] => [
  ...(has("noaccess") ? [] : [{ id: "assistant", label: name, icon, href: "/pwa/assistant", badge: empty || noAi ? undefined : "1" }]),
  { id: "chat", label: "Chat", icon: "ti ti-messages", href: "/pwa/chat", badge: "3" },
  { id: "spaces", label: "Spaces", icon: "ti ti-layout-kanban", href: "/pwa/spaces" },
];
const current = has("noaccess") ? "" : "assistant";
const props: AssistantPwaProps = {
  userId: "robin",
  name,
  icon,
  status: {
    ...models,
    enabled: !noAi,
    visionModelConfigured: true,
    liveDictationAvailable: Boolean(params.get("dictation")),
    audioModelConfigured: recording,
    ...(noAi ? { options: [] } : {}),
  },
  canConfigure: has("noai-admin"),
  timeZone: "Europe/Berlin",
  renderedAt: NOW,
  initialLiveCursor: "0",
  initialAddress: address,
  initialSidebar: has("start-error")
    ? null
    : { conversations: empty ? [] : CHATS, questions: empty ? { items: [], count: 0 } : { items: [question], count: 1 } },
  initialTotal: empty ? 0 : 48,
  initialAll:
    address.level === "all" && !has("all-loading")
      ? {
          query: allQuery,
          page: has("all-error")
            ? null
            : {
                total: allQuery ? search(allQuery).length : 48,
                page: 1,
                perPage: 20,
                hasNext: !allQuery,
                items: address.archived ? OLDER : allQuery ? search(allQuery) : ALL,
              },
          archived: address.archived ? null : 12,
        }
      : null,
  initialDetail: address.level === "chat" ? detailOf(address.id) : null,
};
const screenOfItsOwn = address.level === "chat" || address.level === "new";

render(
  () => (
    <LocaleProvider locale="de">
      <MobileShell
        header={<MobileShell.Header title={name} />}
        scroll={has("noaccess")}
        screen={screenOfItsOwn}
        footer={
          <TabBar
            label="Bereiche"
            items={[
              { id: "start", label: "Start", title: "Robin & Co.", icon: "ti ti-home", href: "/pwa/", current: current === "" },
              ...parts().map((part) => ({ ...part, current: part.id === current })),
            ]}
          />
        }
        sidebar={
          <MobileShell.Sidebar
            label="Bereiche"
            title="Robin & Co."
            items={[{ id: "start", label: "Start", icon: "ti ti-home", href: "/pwa/", current: current === "" }]}
            sections={[{ title: "Apps", items: parts().map((part) => ({ ...part, current: part.id === current })) }]}
            footer={[{ id: "settings", label: "Einstellungen", icon: "ti ti-settings", href: "/pwa/settings" }]}
          />
        }
      >
        {has("noaccess") ? (
          // The platform's 403 page of a part, as PageError renders it for a person without the part's role.
          <Placeholder
            state="empty"
            icon="ti ti-lock"
            title={`${name} ist für dich nicht freigegeben`}
            description={`Wer ${name} nutzen darf, legt die Verwaltung fest. Frag dort nach, wenn du es brauchst.`}
            action={
              <ButtonLink href="/pwa/" variant="secondary">
                Zum Start
              </ButtonLink>
            }
          />
        ) : (
          <AssistantPwa {...props} />
        )}
      </MobileShell>
    </LocaleProvider>
  ),
  document.getElementById("root")!,
);
document.body.dataset.ready = "true";
