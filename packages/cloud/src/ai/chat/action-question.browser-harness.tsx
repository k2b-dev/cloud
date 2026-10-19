import { Chat, type ChatTimelineItem, LocaleProvider } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { AiActionCheck } from "../action-review";
import type { AiTurnBlock } from "../protocol";
import { type ActionFixtureLocale, actionFixtureReceipts, actionFixtures, FIXTURE_AT } from "./action-question.fixtures";
import { AiReaderTimeZoneProvider } from "./action-sentences";
import { AiChatActionsProvider } from "./presentation";
import { createAiToolDisclosureState } from "./tool-disclosure";
import { type AiTurnPhase, layoutAiTurn } from "./turn-layout";
import { AiTurnView } from "./turn-view";

/**
 * Card v4 questions in the real turn view, for browser tests and screenshots. Query: `lang` (de, en), `scenarios`
 * (comma list of fixture keys), `state` (open, running, done, declined, expired, elsewhere, error, checking, found,
 * notfound, pending, checkfail, nocheck), `col` (column width, such as `22rem`), `history` (earlier turns before
 * them), `fail=1` (answers do not arrive), `slow=1` (answers wait until `window.release()`).
 * `window.patch(key, patch)` changes a block, `window.approvals` lists the answers, `window.continued` the messages.
 */
type ToolBlock = Extract<AiTurnBlock, { kind: "tool" }>;

const params = new URLSearchParams(location.search);
const lang = (params.get("lang") === "en" ? "en" : "de") as ActionFixtureLocale;
const fixtures = actionFixtures(lang);
const state = params.get("state") ?? "open";
/** Each entry is `fixture` or `fixture:state`; its id is unique even when one fixture shows in several states. */
const entries = (params.get("scenarios") ?? "mail")
  .split(",")
  .map((value, index) => {
    const [key = "", entryState] = value.split(":");
    return { id: index === 0 && !entryState ? key : `${key}-${index}`, key, state: entryState ?? state };
  })
  .filter((entry) => entry.key in fixtures);
const keys = entries.map((entry) => entry.id);
const fixtureOf = (id: string) => fixtures[entries.find((entry) => entry.id === id)!.key]!;
const historyTurns = Number(params.get("history") ?? 0);
document.documentElement.lang = lang;

const de = lang === "de";
const receipts = actionFixtureReceipts(lang);

const withState = (key: string, block: ToolBlock, value: string): { block: ToolBlock; phase: AiTurnPhase } => {
  const decided = { ...block, approval: undefined, approved: true as const, at: FIXTURE_AT };
  const unknownError = de
    ? "ACTION_OUTCOME_UNKNOWN: Die Antwort ging verloren; nicht automatisch erneut ausführen."
    : "ACTION_OUTCOME_UNKNOWN: The Action response was lost; do not retry automatically.";
  switch (value) {
    case "running":
      return { block: { ...decided, status: "running", at: undefined }, phase: "running" };
    case "done":
      return {
        block: { ...decided, status: "completed", result: key.startsWith("del") ? { data: {}, receipt: receipts.del } : { data: {} } },
        phase: "completed",
      };
    case "declined":
      return { block: { ...decided, approved: undefined, status: "rejected", isError: true, result: "Rejected" }, phase: "completed" };
    case "expired":
      return { block: { ...decided, at: undefined, approved: false, status: "running" }, phase: "completed" };
    case "error":
      return {
        block: {
          ...decided,
          status: "failed",
          isError: true,
          result: de
            ? "BAD_INPUT: Der Mailserver kennt lea.berg@exmaple.com nicht. Es ging nichts raus."
            : "BAD_INPUT: The mail server doesn't know lea.berg@exmaple.com. Nothing went out.",
        },
        phase: "completed",
      };
    case "checking":
      return { block: { ...decided, status: "running", at: undefined, check: { state: "checking" } }, phase: "running" };
    case "found":
      return {
        block: { ...decided, status: "completed", result: { data: null }, check: { state: "done", at: FIXTURE_AT } },
        phase: "completed",
      };
    case "notfound":
      return {
        block: {
          ...decided,
          status: "failed",
          isError: true,
          result: "ACTION_NOT_DONE: The app's check showed nothing happened.",
          check: { state: "not_done", at: FIXTURE_AT },
        },
        phase: "completed",
      };
    case "pending":
    case "checkfail":
      return {
        block: {
          ...decided,
          status: "failed",
          isError: true,
          result: unknownError,
          check: { state: value === "pending" ? "pending" : "failed", at: FIXTURE_AT } satisfies AiActionCheck,
        },
        phase: "completed",
      };
    case "nocheck": {
      const review = decided.review && "sentence" in decided.review ? { ...decided.review, check: undefined } : decided.review;
      return { block: { ...decided, review, status: "failed", isError: true, result: unknownError }, phase: "completed" };
    }
    default:
      return { block, phase: "waiting" };
  }
};

const [blocks, setBlocks] = createSignal<Record<string, { block: ToolBlock; phase: AiTurnPhase }>>(
  Object.fromEntries(
    entries.map((entry) => [
      entry.id,
      withState(entry.key, fixtures[entry.key]!.block, entry.state === "elsewhere" ? "open" : entry.state),
    ]),
  ),
);
const approvals: unknown[] = [];
const continued: string[] = [];
const checks: string[] = [];
let release: (() => void) | null = null;
Object.assign(window, {
  approvals,
  continued,
  checks,
  release: () => release?.(),
  patch: (key: string, patch: Partial<ToolBlock> & { phase?: AiTurnPhase }) =>
    setBlocks((current) => {
      const { phase, ...blockPatch } = patch;
      const entry = current[key]!;
      return { ...current, [key]: { block: { ...entry.block, ...blockPatch } as ToolBlock, phase: phase ?? entry.phase } };
    }),
  state: (key: string, value: string) => setBlocks((current) => ({ ...current, [key]: withState(key, fixtureOf(key).block, value) })),
});
for (const entry of entries)
  if (entry.state === "elsewhere")
    setTimeout(() => setBlocks((current) => ({ ...current, [entry.id]: withState(entry.key, current[entry.id]!.block, "done") })), 150);

const turnItems = (key: string, disclosure: ReturnType<typeof createAiToolDisclosureState>): ChatTimelineItem[] => {
  const fixture = fixtureOf(key);
  const entry = () => blocks()[key]!;
  const turnBlocks = (): AiTurnBlock[] => [{ id: `text-${key}`, kind: "text", text: fixture.assistant }, entry().block];
  return [
    { kind: "message", id: `user-${key}`, role: "user", content: fixture.user },
    {
      kind: "message",
      id: `turn-${key}`,
      role: "assistant",
      class: "ai-chat-message-wide",
      content: (
        <AiTurnView
          segment={() => ({
            id: `turn-${key}`,
            turnId: `turn-${key}`,
            phase: entry().phase,
            layout: layoutAiTurn(turnBlocks(), { phase: entry().phase }),
            earlier: false,
            duration: () => null,
          })}
          disclosureState={disclosure}
        />
      ),
    },
  ];
};

/** One question in one turn, several in one turn for `multi`, after optional earlier turns. */
const timelineItems = (disclosure: ReturnType<typeof createAiToolDisclosureState>): ChatTimelineItem[] => {
  const earlier: ChatTimelineItem[] = Array.from({ length: historyTurns }, (_, index) => [
    { kind: "message" as const, id: `h-user-${index}`, role: "user" as const, content: `${de ? "Frage" : "Question"} ${index + 1}` },
    {
      kind: "message" as const,
      id: `h-assistant-${index}`,
      role: "assistant" as const,
      content: de
        ? `Antwort ${index + 1}: Der Plan für die Woche steht in Woche 42, die Aufgaben liegen in Team Ops.`
        : `Answer ${index + 1}: The plan for the week is in Week 42, the tasks are in Team Ops.`,
    },
  ]).flat();
  if (params.get("multi") === "1") {
    const multiBlocks = (): AiTurnBlock[] => [
      { id: "text-multi", kind: "text", text: de ? "Zwei Dinge brauchen dein Ja:" : "Two things need your yes:" },
      ...keys.map((key) => blocks()[key]!.block),
    ];
    const phase = () => (keys.some((key) => blocks()[key]!.block.status === "awaiting_approval") ? "waiting" : "completed");
    return [
      ...earlier,
      { kind: "message", id: "user-multi", role: "user", content: fixtureOf(keys[0]!).user },
      {
        kind: "message",
        id: "turn-multi",
        role: "assistant",
        class: "ai-chat-message-wide",
        content: (
          <AiTurnView
            segment={() => ({
              id: "turn-multi",
              turnId: "turn-multi",
              phase: phase(),
              layout: layoutAiTurn(multiBlocks(), { phase: phase() }),
              earlier: false,
              duration: () => null,
            })}
            disclosureState={disclosure}
          />
        ),
      },
    ];
  }
  return [...earlier, ...keys.flatMap((key) => turnItems(key, disclosure))];
};

function Gallery() {
  const items = createMemo(() => timelineItems(createAiToolDisclosureState()));
  return <Chat.Timeline items={items()} />;
}

const root = document.createElement("main");
root.style.cssText = `display: flex; flex-direction: column; height: 100dvh; max-width: ${params.get("col") ?? "48rem"}; margin: 0 auto;`;
document.body.append(root);
render(
  () => (
    <LocaleProvider locale={lang}>
      <AiReaderTimeZoneProvider value="Europe/Berlin">
        <AiChatActionsProvider
          actions={{
            onApproval: async (request, input) => {
              approvals.push({ callId: request.callId, ...input });
              if (params.get("fail") === "1") throw new Error("lost");
              if (params.get("slow") === "1") await new Promise<void>((done) => (release = done));
            },
            onContinueTurn: (message) => void continued.push(message),
            onCheckAction: async (request) => {
              checks.push(request.callId);
              return { state: "done", at: FIXTURE_AT };
            },
          }}
        >
          <Gallery />
        </AiChatActionsProvider>
      </AiReaderTimeZoneProvider>
    </LocaleProvider>
  ),
  root,
);
