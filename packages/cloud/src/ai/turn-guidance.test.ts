import { describe, expect, test } from "bun:test";
import type { Message } from "@k2b/nessi";
import {
  type AiChatExchange,
  type AiTurnGuidanceStore,
  aiOfferHint,
  chatExchanges,
  detectAiOfferTrigger,
  endsWithQuestion,
  isCapabilityQuestion,
  isMailDraft,
  loadAiTurnGuidance,
  renderAiRecentWork,
} from "./turn-guidance";
import type { AiConversation, AiStoredMessage } from "./types";

// Messages and replies from the Luna evaluation of 09.10.2026 (S4, S5, S7, S11, S12).
const S5_T1 = "Gib mir eine Übersicht über die Aufgaben im Space „Nacht-Check 27.09.“.";
const S5_T2 = "Bitte als Tabelle mit den Spalten Aufgabe, Zuständig und Frist – ohne Priorität.";
const S5_T3 = "Fast. Fristen bitte als TT.MM., überfällige Aufgaben fett, sortiert nach Frist und die ohne Frist ans Ende.";
const TABLE_REPLY = "| Aufgabe | Zuständig | Frist |\n|---|---|---|\n| Backup-Restore testen | Admin | 30. September 2026 |";
const S7_T1 =
  "Schreib mir eine Antwort an Frau Weber: Donnerstag 10 Uhr passt, die Rückwand soll bedruckt werden, den Standplan schicke ich bis Freitag. Ich schicke die Mail selbst ab, gib mir nur den Text.";
const S7_DRAFT =
  "Hallo Frau Weber,\n\nDonnerstag, der 15.10., um 10:00 Uhr passt mir gut. Die Rückwand soll bedruckt werden.\n\nViele Grüße  \n[Ihr Name]";
const S7_T2 = "Das ist mir zu steif. Jana und ich duzen uns, schreib locker und kürzer, ohne „Sehr geehrte“.";
const S7V_T2 = "Das ist mir zu steif. Mails bitte immer per du und kurz.";
const S4B = "Mach mir bitte wieder den Wochenbericht für den Space „Nacht-Check 27.09.“, so wie letzte Woche.";
const S4A =
  "Mach mir einen kurzen Wochenbericht zum Space „Nacht-Check 27.09.“: eine Tabelle mit den Spalten Aufgabe, Status, Frist und Zuständig, überfällige Aufgaben zuerst, danach drei Sätze Fazit.";
const S12A = "Hör auf mit Vorschlägen am Ende deiner Antworten. Ich frag selbst, wenn ich was brauche.";

const offers = { skillOffers: true, memoryOffers: true };
const detect = (message: string, earlier: AiChatExchange[] = [], extra: Partial<Parameters<typeof detectAiOfferTrigger>[0]> = {}) =>
  detectAiOfferTrigger({ message, earlier, ...offers, ...extra });

describe("detectAiOfferTrigger", () => {
  test("S5: the second format correction in a row qualifies for a Skill offer, the first does not", () => {
    const afterRequest = [{ user: S5_T1, reply: "Im Space gibt es **9 Aufgaben** …" }];
    expect(detect(S5_T2, afterRequest)).toBeNull();
    expect(detect(S5_T3, [...afterRequest, { user: S5_T2, reply: TABLE_REPLY }])).toBe("repeated_correction");
  });

  test("a format-heavy first request does not count as the first correction", () => {
    expect(detect(S5_T3, [{ user: S4A, reply: TABLE_REPLY }])).toBeNull();
  });

  test("a correction with attached files starts new work", () => {
    const earlier = [
      { user: S5_T1, reply: "Übersicht" },
      { user: S5_T2, reply: TABLE_REPLY },
    ];
    expect(detect(S5_T3, earlier, { hasAttachments: true })).toBeNull();
  });

  test("S7: a tone correction of a mail draft qualifies for a remember offer, without any Skill involved", () => {
    expect(detect(S7_T2, [{ user: S7_T1, reply: S7_DRAFT }])).toBe("tone_correction");
    expect(detect(S7_T2, [{ user: S7_T1, reply: S7_DRAFT }], { skillOffers: false })).toBe("tone_correction");
  });

  test("S7v: a tone correction that states a lasting rule is saved directly, so no offer", () => {
    expect(detect(S7V_T2, [{ user: S7_T1, reply: S7_DRAFT }])).toBeNull();
  });

  test("a tone correction of something that is not a mail draft, or without the memory tool, is not a trigger", () => {
    expect(detect(S7_T2, [{ user: "Fass die Mail zusammen.", reply: "Frau Weber bittet um den Standplan bis Freitag." }])).toBeNull();
    expect(detect(S7_T2, [{ user: S7_T1, reply: S7_DRAFT }], { memoryOffers: false })).toBeNull();
  });

  test("S4b: a reference to earlier work qualifies for a Skill offer, only when a Skill can be offered", () => {
    expect(detect(S4B)).toBe("earlier_work");
    expect(detect("Make the weekly status like last time, please.")).toBe("earlier_work");
    expect(detect(S4B, [], { skillOffers: false })).toBeNull();
    expect(detect(S4A)).toBeNull();
  });

  test("S12: an asked-for silence wins, from memory, this chat, or the current message", () => {
    expect(detect(S4B, [], { instructions: [`- preference: ${S12A}`] })).toBeNull();
    expect(detect(S4B, [], { instructions: ["Never end answers with offers or suggestions."] })).toBeNull();
    expect(detect(S4B, [{ user: S12A, reply: "Verstanden." }])).toBeNull();
    expect(detect(`${S4B} Und bitte keine Vorschläge.`)).toBeNull();
    expect(detect("Same as last time, no suggestions please.")).toBeNull();
  });

  test("never right after a reply that ended with a question, and never again after a declined offer", () => {
    const offered = [
      { user: S5_T1, reply: "Übersicht" },
      { user: S5_T2, reply: `${TABLE_REPLY}\n\nSoll ich das als Skill speichern?` },
    ];
    expect(detect(S5_T3, offered)).toBeNull();
    const declined = [
      { user: S7_T1, reply: "Hier ist der Entwurf.\n\nSoll ich mir das merken?" },
      { user: "Nein danke.", reply: "Alles klar." },
      { user: S7_T1, reply: S7_DRAFT },
    ];
    expect(detect(S7_T2, declined)).toBeNull();
  });

  test("an offer phrased as a statement also counts as the previous offer", () => {
    const offered = [
      { user: S5_T1, reply: "Übersicht" },
      { user: S5_T2, reply: `${TABLE_REPLY}\n\nWenn du magst, speichere ich das Vorgehen als Skill.` },
    ];
    expect(detect(S5_T3, offered)).toBeNull();
  });

  test("follow-up requests that merely mention lists or order are not format corrections", () => {
    const earlier = [
      { user: "List my open tasks.", reply: "- Backup-Restore testen\n- Staging-Zertifikat erneuern" },
      { user: "Now list the overdue ones first.", reply: "- Backup-Restore testen" },
    ];
    expect(detect("Which of them are assigned to me, in order to plan my week?", earlier)).toBeNull();
  });

  test("a tone correction that is still not right is not a lasting rule", () => {
    expect(detect("Immer noch zu steif, bitte lockerer.", [{ user: S7_T1, reply: S7_DRAFT }])).toBe("tone_correction");
  });

  test("ordinary requests from the evaluation are not triggers", () => {
    for (const message of [
      "Wie spät ist es in Tokio?",
      "Fass mir diese Mail kurz zusammen.",
      "Welche Fristen habe ich aus beiden Mails?",
      "Leg im Space „Nacht-Check 27.09.“ in der Spalte „Offen“ eine Aufgabe „Eval: Druckangebote prüfen“ mit Frist 16.10. an.",
      "Vergleich bitte die drei Angebote für den Druck unseres Jahresberichts.",
      "Ja, mach daraus einen Skill.",
    ]) {
      expect(detect(message, [{ user: S5_T1, reply: TABLE_REPLY }])).toBeNull();
    }
  });
});

describe("offer hint", () => {
  test("is one short instruction that keeps the general limits", () => {
    const hint = aiOfferHint("earlier_work");
    expect(hint.startsWith("Offer once at the end:")).toBe(true);
    expect(hint).toContain("unless a listed Skill already covers it");
    expect(hint).toContain("Skip it if you end with a question, wait for approval, or could not finish.");
    expect(aiOfferHint("tone_correction")).toContain("suggest a one-line rule they can send back");
    expect(aiOfferHint("tone_correction")).not.toContain("Skill");
  });
});

describe("text shapes", () => {
  test("recognizes mail drafts by greeting and sign-off", () => {
    expect(isMailDraft(S7_DRAFT)).toBe(true);
    expect(isMailDraft("Here is the draft:\n\n> Dear Ms. Weber,\n> Thursday works.\n> Best regards,\n> Jana")).toBe(true);
    expect(isMailDraft("Hallo! Die Aufgabe ist erledigt.")).toBe(false);
    expect(isMailDraft(TABLE_REPLY)).toBe(false);
  });

  test("recognizes a reply that ends with a question", () => {
    expect(endsWithQuestion("Erledigt.\n\nSoll ich daraus einen **Skill** machen?**")).toBe(true);
    expect(endsWithQuestion("Erledigt. Was meinst du? Ich habe es gespeichert.")).toBe(false);
  });

  test("S11: recognizes the capability question, but not longer requests", () => {
    expect(isCapabilityQuestion("Was kannst du für mich tun?")).toBe(true);
    expect(isCapabilityQuestion("Wobei kannst du mir helfen?")).toBe(true);
    expect(isCapabilityQuestion("What can you do?")).toBe(true);
    expect(isCapabilityQuestion("Wie spät ist es in Tokio?")).toBe(false);
    expect(isCapabilityQuestion("Was kannst du mir zu Jana sagen?")).toBe(false);
    expect(isCapabilityQuestion("What can you do about the broken printer?")).toBe(false);
    expect(
      isCapabilityQuestion(
        "Was kannst du mir zu den drei Angeboten für den Druck des Jahresberichts sagen, und welches ist am günstigsten?",
      ),
    ).toBe(false);
  });
});

const stored = (seq: number, loopId: string, message: Message): AiStoredMessage => ({
  id: `m${seq}`,
  shortId: `m${seq}`,
  conversationId: "c1",
  seq,
  kind: "message",
  message,
  loopId,
  modelProfileId: null,
  providerModel: null,
  usage: null,
  stopReason: null,
  loopAggregate: null,
  loopDoneReason: null,
  compactedAt: null,
  meta: null,
  createdAt: "2026-10-09T06:41:00.000Z",
});
const userMessage = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistantText = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }] });

describe("chatExchanges", () => {
  test("pairs each earlier turn's message with its last visible reply and leaves out the current turn", () => {
    const exchanges = chatExchanges(
      [
        stored(1, "t1", userMessage(S5_T1)),
        stored(2, "t1", assistantText("Ich schaue im Space nach.")),
        stored(3, "t1", assistantText("Übersicht")),
        stored(4, "t2", userMessage(S5_T2)),
        stored(5, "t2", assistantText(TABLE_REPLY)),
        stored(6, "t3", userMessage(S5_T3)),
      ],
      "t3",
    );
    expect(exchanges).toEqual([
      { user: S5_T1, reply: "Übersicht" },
      { user: S5_T2, reply: TABLE_REPLY },
    ]);
  });
});

const fakeStore = (input: {
  messages?: AiStoredMessage[];
  chats?: Pick<AiConversation, "id" | "title">[];
  total?: number;
  resources?: { type: string; id: string; title: string | null }[];
}) => {
  const calls: string[] = [];
  const store: AiTurnGuidanceStore = {
    listMessagesPage: async () => {
      calls.push("messages");
      return { messages: input.messages ?? [] };
    },
    listConversationsPage: async () => {
      calls.push("chats");
      const items = input.chats ?? [];
      return { items, total: input.total ?? items.length };
    },
    listUserConversationResources: async () => {
      calls.push("resources");
      return { resources: (input.resources ?? []).map(({ type, id, title }) => ({ ref: { type, id }, title })) };
    },
  };
  return { store, calls };
};

describe("loadAiTurnGuidance", () => {
  const base = { conversationId: "current", turnId: "t3", ownerUserId: "u1", ...offers };

  test("reads no history for a message that cannot start an offer case", async () => {
    const { store, calls } = fakeStore({});
    expect(await loadAiTurnGuidance({ ...base, message: "Wie spät ist es in Tokio?" }, store)).toEqual({});
    expect(calls).toEqual([]);
  });

  test("turns a detected case into one offer hint", async () => {
    const { store, calls } = fakeStore({
      messages: [
        stored(1, "t1", userMessage(S5_T1)),
        stored(2, "t1", assistantText("Übersicht")),
        stored(3, "t2", userMessage(S5_T2)),
        stored(4, "t2", assistantText(TABLE_REPLY)),
      ],
    });
    const guidance = await loadAiTurnGuidance({ ...base, message: S5_T3 }, store);
    expect(guidance.offerHint).toBe(aiOfferHint("repeated_correction"));
    expect(calls).toEqual(["messages"]);
  });

  test("S11: summarizes recent chats and distinct Cloud items, without the current chat", async () => {
    const { store, calls } = fakeStore({
      chats: [
        { id: "current", title: "Was kannst du für mich tun?" },
        { id: "a", title: "Wochenbericht" },
      ],
      total: 7,
      resources: [
        { type: "spaces.space", id: "FBsJJ3", title: "Nacht-Check 27.09." },
        { type: "spaces.space", id: "FBsJJ3", title: "Nacht-Check 27.09." },
        { type: "notebooks.note", id: "n1", title: null },
      ],
    });
    const guidance = await loadAiTurnGuidance({ ...base, message: "Was kannst du für mich tun?" }, store);
    expect(guidance).toEqual({
      recentWork: { chatCount: 6, chats: ["Wochenbericht"], items: [{ type: "spaces.space", title: "Nacht-Check 27.09." }] },
    });
    expect(calls.sort()).toEqual(["chats", "resources"]);
  });

  test("renders an empty workspace honestly", () => {
    const text = renderAiRecentWork({ chatCount: 0, chats: [], items: [] });
    expect(text).toContain("Chats: none yet");
    expect(text).toContain("Cloud items used in chats: none yet");
    expect(text).toContain("leave out apps without data, such as mail without a mailbox");
  });
});
