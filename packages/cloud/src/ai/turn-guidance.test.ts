import { describe, expect, test } from "bun:test";
import type { Message } from "@k2b/nessi";
import { aiAttachmentMarker } from "./attachments";
import { aiResourceMarker } from "./resource-markers";
import {
  type AiChatExchange,
  type AiTurnGuidanceChat,
  type AiTurnGuidanceStore,
  aiOfferHint,
  asksForNoSuggestions,
  chatExchanges,
  detectAiOfferTrigger,
  endsWithQuestion,
  isCapabilityQuestion,
  isMailDraft,
  loadAiTurnGuidance,
  renderAiRecentWork,
  turnInputText,
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

  test("a new request that names a format, followed by one correction, is only the first correction", () => {
    const afterSmallTalk = (request: string, requestReply = TABLE_REPLY) => [
      { user: "Wie spät ist es?", reply: "Es ist 14:05 Uhr." },
      { user: request, reply: requestReply },
    ];
    expect(detect("Sortier sie bitte nach Frist.", afterSmallTalk("Liste mir die offenen Aufgaben als Tabelle auf."))).toBeNull();
    expect(detect("Sort by deadline, overdue in bold.", afterSmallTalk("Create a sales report as a table."))).toBeNull();
    expect(detect("Create an expenses table.", afterSmallTalk("What does Markdown mean?", "A plain-text format."))).toBeNull();
    // The same correction after a correction is the second one.
    expect(
      detect("Sortier sie bitte nach Frist.", [
        { user: S5_T1, reply: "Übersicht" },
        { user: S5_T2, reply: TABLE_REPLY },
      ]),
    ).toBe("repeated_correction");
    expect(
      detect("Almost. Sort by deadline, overdue in bold.", [
        { user: "List my open tasks.", reply: "- Backup\n- Certificate" },
        { user: "Make it a table with the columns Task and Deadline.", reply: TABLE_REPLY },
      ]),
    ).toBe("repeated_correction");
  });

  test("new requests, questions, and Grids or Spaces edits that use format words are not corrections", () => {
    const pairs: [string, string][] = [
      ["Fass die Mail in drei Zeilen zusammen.", "Schreib mir zwei Zeilen an Jana, dass ich später komme."],
      ["In welchen Spalten steht der Umsatz?", "Welches Format hat die Datei?"],
      ["Verschieb Backup in die Spalte In Arbeit.", "Verschieb die Aufgabe in die Spalte Erledigt."],
      ["Füg eine Spalte Telefon hinzu.", "Lösch die Zeile mit Max Mustermann."],
      ["Add a column Phone.", "Add a row for ACME Corp."],
      [S5_T2, "Leg im Space „Nacht-Check 27.09.“ in der Spalte „Offen“ eine Aufgabe „Eval: Druckangebote prüfen“ mit Frist 16.10. an."],
    ];
    for (const [first, second] of pairs) {
      expect(
        detect(second, [
          { user: "Hi", reply: "Hallo!" },
          { user: first, reply: TABLE_REPLY },
        ]),
      ).toBeNull();
    }
  });

  test("a second correction counts only after a delivered result, not after a short confirmation", () => {
    const earlier = [
      { user: "Öffne die Tabelle Kunden.", reply: TABLE_REPLY },
      { user: "Mach die Spalte Telefon fett.", reply: "Erledigt." },
    ];
    expect(detect("Sortier die Tabelle nach Name.", earlier)).toBeNull();
    expect(detect("Sortier die Tabelle nach Name.", [earlier[0]!, { ...earlier[1]!, reply: TABLE_REPLY }])).toBe("repeated_correction");
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

  test("a tone correction in English or with other wording also qualifies", () => {
    const englishDraft = "Hi Jana,\n\nThursday at 10 works for me.\n\nBest regards,\nAlex";
    expect(detect("Too formal, make it more casual.", [{ user: "Write Jana that Thursday works.", reply: englishDraft }])).toBe(
      "tone_correction",
    );
    expect(detect("Klingt mir zu förmlich, bitte etwas lockerer.", [{ user: S7_T1, reply: S7_DRAFT }])).toBe("tone_correction");
    expect(detect("Lockerer bitte, wir duzen uns.", [{ user: S7_T1, reply: S7_DRAFT }])).toBe("tone_correction");
  });

  test("a new draft or a content fix after a mail draft is not a tone correction", () => {
    const englishDraft = "Hi Jana,\n\nThursday at 10 works for me.\n\nBest regards,\nAlex";
    for (const message of [
      "Schreib jetzt noch eine lockere Geburtstagsmail an Max.",
      "Schreib eine neue Mail an Herrn Krüger, diesmal förmlich.",
      "Da ist ein sachlicher Fehler drin: das Treffen ist am Freitag.",
      "Schreib rein, dass es ein persönlicher Termin ist.",
    ]) {
      expect(detect(message, [{ user: S7_T1, reply: S7_DRAFT }])).toBeNull();
    }
    for (const message of [
      "Now write a casual birthday email to Max.",
      "Translate the word formal into German.",
      "Add a ton more detail.",
      "There are a ton of typos in it, fix them.",
    ]) {
      expect(detect(message, [{ user: "Write Jana that Thursday works.", reply: englishDraft }])).toBeNull();
    }
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

  test("thanks, small talk, and references inside the chat are not earlier work", () => {
    for (const message of [
      "Danke, wie immer super!",
      "Wie immer, danke!",
      "Mach weiter wie bisher.",
      "Ist das wie bisher?",
      "Hi, how are you? Busy as usual?",
      "Thanks, as usual great work.",
      "It doesn't work like before.",
    ]) {
      expect(detect(message)).toBeNull();
    }
  });

  test("S12: an asked-for silence wins, from memory, this chat, or the current message", () => {
    expect(detect(S4B, [], { instructions: [`- preference: ${S12A}`] })).toBeNull();
    expect(detect(S4B, [], { instructions: ["Never end answers with offers or suggestions."] })).toBeNull();
    expect(detect(S4B, [{ user: S12A, reply: "Verstanden." }])).toBeNull();
    expect(detect(`${S4B} Und bitte keine Vorschläge.`)).toBeNull();
    expect(detect("Same as last time, no suggestions please.")).toBeNull();
    expect(detect("Mach den Wochenbericht wie letzte Woche.", [], { instructions: ["Lass die Vorschläge am Ende weg."] })).toBeNull();
  });

  test("recognizes common ways to ask for no suggestions, and not a request to shorten a draft", () => {
    for (const text of [
      "Do not make any suggestions at the end of replies.",
      "Bitte schlage mir nichts mehr vor.",
      "Bitte keine Rückfragen oder Vorschläge.",
      "Lass die Vorschläge am Ende weg.",
      "Spar dir die Vorschläge.",
      "Keine ungefragten Vorschläge.",
      "Möchte keine Folgevorschläge.",
      "Stop with the suggestions.",
      "Please stop adding suggestions at the end.",
      "I don’t want suggestions.",
    ]) {
      expect(asksForNoSuggestions(text)).toBe(true);
    }
    expect(asksForNoSuggestions("Mach die Mail kürzer.")).toBe(false);
    expect(asksForNoSuggestions("Vergleich bitte die drei Angebote.")).toBe(false);
  });

  test("a request for only a short answer wins", () => {
    expect(detect("Same as last time. Only a short answer, please.")).toBeNull();
    expect(detect("Mach den Bericht wie letzte Woche, antworte nur kurz.")).toBeNull();
    // Shortening the result is a correction, not a request for a short answer.
    expect(detect("Das ist mir zu steif, bitte lockerer und kürzer.", [{ user: S7_T1, reply: S7_DRAFT }])).toBe("tone_correction");
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
    for (const no of ["Nö.", "Danke, nicht nötig."]) {
      const declinedStatement = [
        { user: S5_T1, reply: "Übersicht" },
        { user: S5_T2, reply: `${TABLE_REPLY}\n\nIch kann das auch als Skill speichern.` },
        { user: no, reply: "Alles klar." },
        { user: S5_T2, reply: TABLE_REPLY },
      ];
      expect(detect(S5_T3, declinedStatement)).toBeNull();
    }
  });

  test("an offer phrased as a statement also counts as the previous offer", () => {
    for (const offer of [
      "Wenn du magst, speichere ich das Vorgehen als Skill.",
      "Ich kann das auch als Skill speichern.",
      "Das kann ich als Skill speichern – sag einfach Ja.",
    ]) {
      const offered = [
        { user: S5_T1, reply: "Übersicht" },
        { user: S5_T2, reply: `${TABLE_REPLY}\n\n${offer}` },
      ];
      expect(detect(S5_T3, offered)).toBeNull();
    }
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
  test("is one short instruction that restates the general limits, so it never overrules one the checks missed", () => {
    const hint = aiOfferHint("earlier_work");
    expect(hint.startsWith("Offer once at the end:")).toBe(true);
    expect(hint).toContain("unless a listed Skill already covers it");
    expect(hint).toContain(
      "Skip it if you end with a question, wait for approval, or could not finish; if your previous reply already ended with an offer or the user declined one in this chat; or if the user, their preferences, or instructions ask for no suggestions or only a short answer.",
    );
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
    expect(isMailDraft("Hallo! Hier der Vergleich:\n\nBest option ist Lindner.")).toBe(false);
    expect(isMailDraft("Hallo Jana,\n\nbis Donnerstag!\n\nViele Grüße Alex")).toBe(true);
  });

  test("recognizes a reply that ends with a question", () => {
    expect(endsWithQuestion("Erledigt.\n\nSoll ich daraus einen **Skill** machen?**")).toBe(true);
    expect(endsWithQuestion("Erledigt. Was meinst du? Ich habe es gespeichert.")).toBe(false);
    expect(endsWithQuestion("Erledigt.\n\nSoll ich das als Skill speichern? 🙂")).toBe(true);
    expect(endsWithQuestion("Erledigt.\n\nSoll ich das als Skill speichern? [Mehr zu Skills](https://example.com/skills)")).toBe(true);
    expect(endsWithQuestion("Soll ich das speichern?\n\nhttps://example.com/skills")).toBe(true);
  });

  test("S11: recognizes the capability question, but not longer requests", () => {
    expect(isCapabilityQuestion("Was kannst du für mich tun?")).toBe(true);
    expect(isCapabilityQuestion("Wobei kannst du mir helfen?")).toBe(true);
    expect(isCapabilityQuestion("What can you do?")).toBe(true);
    expect(isCapabilityQuestion("Hallo! Was kannst du für mich tun?")).toBe(true);
    expect(isCapabilityQuestion("Hi Claude, what can you do?")).toBe(true);
    expect(isCapabilityQuestion("Übersetze ins Englische: Was kannst du für mich tun?")).toBe(false);
    expect(isCapabilityQuestion("Translate into German: What can you do?")).toBe(false);
    expect(isCapabilityQuestion("Do not answer this question: What can you do?")).toBe(false);
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

  test("adds steering messages to their turn and leaves out attachment markers, noting them", () => {
    const steer = { ...stored(3, "t1", userMessage("Keine Vorschläge bitte.")), meta: { steerId: "s1" } };
    const exchanges = chatExchanges(
      [
        stored(1, "t1", userMessage(S5_T1)),
        stored(2, "t1", assistantText("Ich schaue nach.")),
        steer,
        stored(4, "t1", assistantText("Übersicht")),
        stored(5, "t2", userMessage(`Fass das zusammen ${aiAttachmentMarker({ path: "/notes.md", mediaType: "text/markdown", size: 3 })}`)),
        stored(6, "t2", assistantText("Zusammenfassung")),
      ],
      "t3",
    );
    expect(exchanges).toEqual([
      { user: `${S5_T1}\nKeine Vorschläge bitte.`, reply: "Übersicht" },
      { user: "Fass das zusammen", reply: "Zusammenfassung", attachments: true },
    ]);
    expect(detect(S5_T3, exchanges)).toBeNull();
  });
});

describe("turnInputText", () => {
  test("leaves out file markers and attached Cloud items, and reports them", () => {
    const file = aiAttachmentMarker({ path: "/no suggestions.txt", mediaType: "text/plain", size: 3 });
    const resource = aiResourceMarker({ ref: { type: "grids.table", id: "t1" }, title: "Tabelle Umsatz" });
    expect(turnInputText(`Was steht in der Datei? ${file}`)).toEqual({ text: "Was steht in der Datei?", attachments: true });
    expect(turnInputText([{ type: "text", text: resource }, "Sortier nach Datum."])).toEqual({
      text: "Sortier nach Datum.",
      attachments: true,
    });
    expect(turnInputText("Bitte als Tabelle.")).toEqual({ text: "Bitte als Tabelle.", attachments: false });
  });
});

const fakeStore = (input: {
  messages?: AiStoredMessage[];
  chats?: Pick<AiConversation, "id" | "title">[];
  total?: number;
  resources?: { type: string; id: string; title: string | null; chat?: string }[];
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
      return {
        resources: (input.resources ?? []).map(({ type, id, title, chat }) => ({
          ref: { type, id },
          title,
          chat: { shortId: chat ?? "other", title: "Other", updatedAt: "2026-10-09T06:41:00.000Z" },
        })),
      };
    },
  };
  return { store, calls };
};

describe("loadAiTurnGuidance", () => {
  const chat: AiTurnGuidanceChat = { id: "current", shortId: "cur", archivedAt: null, createdByUserId: "u1" };
  const base = { chat, turnId: "t3", ownerUserId: "u1", ...offers };

  test("reads no history for a message that cannot start an offer case", async () => {
    const { store, calls } = fakeStore({});
    expect(await loadAiTurnGuidance({ ...base, input: "Wie spät ist es in Tokio?" }, store)).toEqual({});
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
    const guidance = await loadAiTurnGuidance({ ...base, input: S5_T3 }, store);
    expect(guidance.offerHint).toBe(aiOfferHint("repeated_correction"));
    expect(calls).toEqual(["messages"]);
  });

  test("a correction sent with a file or Cloud item starts new work", async () => {
    const messages = [
      stored(1, "t1", userMessage(S5_T1)),
      stored(2, "t1", assistantText("Übersicht")),
      stored(3, "t2", userMessage(S5_T2)),
      stored(4, "t2", assistantText(TABLE_REPLY)),
    ];
    const file = aiAttachmentMarker({ path: "/Tabelle.xlsx", mediaType: "application/vnd.ms-excel", size: 3 });
    const resource = aiResourceMarker({ ref: { type: "spaces.space", id: "s1" }, title: "Nacht-Check" });
    expect(await loadAiTurnGuidance({ ...base, input: `${S5_T3} ${file}` }, fakeStore({ messages }).store)).toEqual({});
    expect(await loadAiTurnGuidance({ ...base, input: [resource, S5_T3] }, fakeStore({ messages }).store)).toEqual({});
  });

  test("S11: summarizes other chats and the Cloud items used in them", async () => {
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
        { type: "notebooks.note", id: "n2", title: "Only in this chat", chat: "cur" },
      ],
    });
    const guidance = await loadAiTurnGuidance({ ...base, input: "Was kannst du für mich tun?" }, store);
    expect(guidance).toEqual({
      recentWork: { chatCount: 6, chats: ["Wochenbericht"], items: [{ type: "spaces.space", title: "Nacht-Check 27.09." }] },
    });
    expect(calls.sort()).toEqual(["chats", "resources"]);
  });

  test("S11: does not count the current chat when it sorts below pinned chats, and counts no archived chat", async () => {
    const pinned = Array.from({ length: 6 }, (_, index) => ({ id: `p${index}`, title: `Pinned ${index}` }));
    const { store } = fakeStore({ chats: pinned, total: 10 });
    const guidance = await loadAiTurnGuidance({ ...base, input: "What can you do?" }, store);
    expect(guidance.recentWork?.chatCount).toBe(9);
    expect(guidance.recentWork?.chats).toHaveLength(5);
    const archived = await loadAiTurnGuidance(
      { ...base, chat: { ...chat, archivedAt: "2026-10-01T00:00:00.000Z" }, input: "What can you do?" },
      fakeStore({ chats: pinned, total: 10 }).store,
    );
    expect(archived.recentWork?.chatCount).toBe(10);
  });

  test("a capability question sent with a file asks about the file, so no summary", async () => {
    const file = aiAttachmentMarker({ path: "/report.pdf", mediaType: "application/pdf", size: 3 });
    const { store, calls } = fakeStore({});
    expect(await loadAiTurnGuidance({ ...base, input: `What can you do? ${file}` }, store)).toEqual({});
    expect(calls).toEqual([]);
  });

  test("renders an empty workspace honestly", () => {
    const text = renderAiRecentWork({ chatCount: 0, chats: [], items: [] });
    expect(text).toContain("Other chats: none yet");
    expect(text).toContain("Cloud items used in other chats: none yet");
    expect(text).toContain("It holds only Assistant data and does not show which apps have data for the user.");
    expect(text).toContain("leave out apps without data, such as mail without a mailbox");
    expect(renderAiRecentWork({ chatCount: 3, chats: ["Wochenbericht"], items: [] })).toContain(
      'Other chats: 3; pinned and recent: "Wochenbericht"',
    );
  });
});
