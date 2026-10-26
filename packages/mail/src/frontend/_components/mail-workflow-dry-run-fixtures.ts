import type { WorkflowTryItem, WorkflowTryResult } from "../../contracts";

/** Fictional mails and the rule "Lange Mails zusammenfassen" from the approved mockup. */
const row = (
  index: number,
  name: string,
  subject: string,
  outcome: WorkflowTryItem["outcome"],
  facts: Array<[string, number | boolean]>,
  effect?: { kind: string; params?: WorkflowTryItem["effects"][number]["params"]; ai?: boolean },
): WorkflowTryItem => ({
  messageId: `Msg${String(index).padStart(3, "0")}`,
  conversationId: `Conv${String(index).padStart(3, "0")}`,
  from: { name, email: `${name.toLowerCase().replace(/[^a-z]+/gu, ".")}@example.test` },
  subject,
  receivedAt: new Date(Date.UTC(2026, 9, 26, 9, 0) - index * 600_000).toISOString(),
  outcome,
  reason: outcome === "skipped" ? { code: "excluded", field: "inputs.message.isBulk" } : null,
  facts: facts.map(([path, value]) => ({ path, value })),
  effects: effect ? [{ kind: effect.kind, ai: effect.ai ?? true, params: effect.params ?? {}, dependsOnAi: false }] : [],
  stoppedAtAi: false,
  problems: [],
  aiCalls: effect && (effect.ai ?? true) ? { min: 1, max: 1 } : { min: 0, max: 0 },
});

type FixtureEffect = "summary" | "tag";

/** `summary` is the mockup's rule (S2); `tag` the same rule with a step that exists before S2. */
const fixtureItems = (effect: FixtureEffect): WorkflowTryItem[] => {
  const summarize = (existingSummary: boolean) =>
    effect === "summary"
      ? { kind: "summarizeConversation", params: { mode: "rolling", existingSummary } }
      : { kind: "addLocalTag", params: { tag: "Lang" }, ai: false };

  const named: WorkflowTryItem[] = [
    row(
      1,
      "Jana Berger",
      "Angebot Visitenkarten 2026",
      "match",
      [
        ["inputs.conversation.messageCount", 5],
        ["inputs.message.textLength", 642],
      ],
      summarize(true),
    ),
    row(2, "Tomás Silva", "Reklamation Lieferung vom 14.10.", "match", [["inputs.message.textLength", 388]], summarize(false)),
    row(3, "Mira Okafor", "Quote request: 500 tote bags", "match", [["inputs.message.textLength", 512]], summarize(false)),
    row(4, "Papier Krause GmbH", "Rechnung R-2026-0412", "none", [
      ["inputs.message.textLength", 118],
      ["inputs.conversation.messageCount", 1],
    ]),
    row(5, "Stadtwerke Linden", "Druckfreigabe Plakate Herbstfest", "match", [["inputs.conversation.messageCount", 4]], summarize(true)),
    row(6, "Papierwelt", "Neue Naturpapiere im Herbst", "skipped", [["inputs.message.isBulk", true]]),
    row(7, "Paketdienst", "Ihre Sendung kommt heute", "none", [["inputs.message.textLength", 96]]),
    row(8, "Lea Hoffmann", "Termin Musterbogen", "none", [
      ["inputs.message.textLength", 142],
      ["inputs.conversation.messageCount", 2],
    ]),
  ];

  return [
    ...named,
    ...Array.from({ length: 42 }, (_, offset) => {
      const index = offset + 9;
      const outcome: WorkflowTryItem["outcome"] = offset < 13 ? "match" : offset < 18 ? "skipped" : "none";
      return row(
        index,
        `Kundin ${index}`,
        `Anfrage ${index}`,
        outcome,
        outcome === "skipped"
          ? [["inputs.message.isBulk", true]]
          : [["inputs.message.textLength", outcome === "match" ? 300 + index : 80 + index]],
        outcome === "match" ? summarize(false) : undefined,
      );
    }),
  ];
};

/** 50 mails: 17 match, 6 skipped, 27 not, the counts the mockup shows. */
export const dryRunFixtureItems: WorkflowTryItem[] = fixtureItems("summary");
export const dryRunTagFixtureItems: WorkflowTryItem[] = fixtureItems("tag");

export const dryRunFixturePreflight: WorkflowTryResult["preflight"] = {
  targets: [],
  sends: false,
  writesDrafts: false,
  aiSteps: 1,
};

/** Splits the fixture into the batches the API returns. */
export const dryRunFixtureBatch = (
  cursor: string | null,
  options: { batch?: number; items?: WorkflowTryItem[]; maxAiCallsPerDay?: number | null } = {},
): WorkflowTryResult => {
  const items = options.items ?? dryRunFixtureItems;
  const batch = options.batch ?? 10;
  const start = cursor ? Number(cursor) : 0;
  const slice = items.slice(start, start + batch);
  const next = start + slice.length;
  return {
    window: { last: 50, total: items.length },
    cursor: next < items.length ? String(next) : null,
    checked: next,
    items: slice,
    aiCalls: slice.reduce((sum, item) => ({ min: sum.min + item.aiCalls.min, max: sum.max + item.aiCalls.max }), { min: 0, max: 0 }),
    maxAiCallsPerDay: options.maxAiCallsPerDay === undefined ? 200 : options.maxAiCallsPerDay,
    preflight: dryRunFixturePreflight,
  };
};
