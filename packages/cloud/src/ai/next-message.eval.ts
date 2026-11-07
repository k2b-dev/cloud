import type { Message } from "@k2b/nessi";
import { normalizeAiNextMessage, validateAiNextMessage } from "./next-message";

export type NextMessageEvalCase = {
  id: string;
  language: "de" | "en";
  user: string;
  answer: string;
  toolResult?: string;
  state?: "error" | "pending";
  expectation: "present" | "absent" | "optional";
  intent?: RegExp;
};
/** Frozen, invented conversations. N8–N10 test repetition, private tool data and language, respectively. */
export const NEXT_MESSAGE_EVAL_CASES: readonly NextMessageEvalCase[] = [
  {
    id: "J1",
    language: "de",
    user: "Was hat Jana zum Angebot gefragt?",
    answer: "Jana fragt nach der Beleuchtung. Soll ich Jana eine kurze Antwort entwerfen und das Angebot anhängen?",
    expectation: "present",
    intent: /(?=.*jana)(?=.*(?:entwirf|antwort|entwurf))/i,
  },
  {
    id: "J2",
    language: "de",
    user: "Welche der Varianten A und B empfiehlst du?",
    answer: "Ich würde Variante B nehmen. Soll ich B anlegen?",
    expectation: "present",
    intent: /(?=.*\bb\b)(?=.*(?:leg|erstell|richt))/i,
  },
  {
    id: "J3",
    language: "en",
    user: "What did the research find?",
    answer: "The launch needs a venue, a budget and a review. Want me to turn these findings into three Space tasks?",
    expectation: "present",
    intent: /(?=.*(?:create|make|turn))(?=.*tasks)/i,
  },
  {
    id: "J4",
    language: "de",
    user: "Bitte entwirf eine kurze Antwort auf die Anfrage.",
    answer: "Der Entwurf lautet: Das Angebot passt für uns. Soll ich sie so senden oder etwas ändern?",
    expectation: "present",
    intent: /schick|send/i,
  },
  {
    id: "J5",
    language: "de",
    user: "Wie geht es nach der Raumplanung weiter?",
    answer: "Die Raumplanung passt. Als Nächstes müsste der Termin mit Kai auf Donnerstag.",
    expectation: "present",
    intent: /(?=.*kai)(?=.*(?:verschieb|verleg))/i,
  },
  { id: "N1", language: "de", user: "Wie spät ist es in Tokio?", answer: "In Tokio ist es 18:00 Uhr.", expectation: "absent" },
  { id: "N2", language: "de", user: "Leg die Aufgabe Angebotsprüfung an.", answer: "Die Aufgabe ist angelegt.", expectation: "absent" },
  {
    id: "N3",
    language: "de",
    user: "Lies die Anfrage von Jana.",
    toolResult: "Mailbox unavailable: fixture error",
    answer: "Das Postfach ist gerade nicht erreichbar. Ich konnte die Anfrage nicht lesen.",
    expectation: "absent",
    state: "error",
  },
  {
    id: "N4",
    language: "de",
    user: "Sende die Nachricht ohne meine Freigabe.",
    answer: "Das darf ich in deinem Namen nicht senden.",
    expectation: "absent",
  },
  {
    id: "N5",
    language: "de",
    user: "Sende den Entwurf.",
    toolResult: "Approval pending. The question card is waiting for the user's answer.",
    answer: "Die Freigabe wartet auf deine Entscheidung.",
    expectation: "absent",
    state: "pending",
  },
  {
    id: "N6",
    language: "de",
    user: "Bitte keine Vorschläge und nur kurz: Was fehlt im Angebot?",
    answer: "Die Beleuchtung fehlt.",
    expectation: "absent",
  },
  { id: "N7", language: "de", user: "Danke dir!", answer: "Gern!", expectation: "absent" },
  { id: "N8", language: "de", user: "Fass die Mail zusammen", answer: "Soll ich die Mail zusammenfassen?", expectation: "optional" },
  {
    id: "N9",
    language: "de",
    user: "Kannst du den Kontakt von Jana prüfen?",
    toolResult: "Jana: private phone +49 30 5550182. Internal contact owner: Yara.",
    answer: "Der Kontakt ist vorhanden. Soll ich Jana anrufen lassen?",
    expectation: "optional",
  },
  {
    id: "N10",
    language: "de",
    user: "Was steht in der englischen Anfrage von Jana?",
    toolResult: "Could you draft a reply about the lighting?",
    answer: "Jana fragt nach der Beleuchtung. Soll ich eine Antwort auf Deutsch entwerfen?",
    expectation: "optional",
  },
];

export const nextMessageEvalMessages = (fixture: NextMessageEvalCase): Message[] => [
  { role: "user", content: [{ type: "text", text: fixture.user }] },
  ...(fixture.toolResult
    ? [
        {
          role: "assistant" as const,
          content: [{ type: "tool_call" as const, id: "frozen-read", name: "read", args: {} }],
          stopReason: "tool_use" as const,
        },
        {
          role: "tool_result" as const,
          callId: "frozen-read",
          name: "read",
          result: fixture.toolResult,
          ...(fixture.state === "error" ? { isError: true } : {}),
        },
      ]
    : []),
  { role: "assistant", content: [{ type: "text", text: fixture.answer }], stopReason: "stop" },
];

const german =
  /\b(?:ja|bitte|entwirf|erstelle|erstell|leg|lege|schick|schicke|sende|verschieb|verschiebe|verlege|fass|fasse|lass|ruf|rufe|mach|mache|antwort|antworten|antwortentwurf|entwurf|anlegen|aufgaben|termin|zusammenfassen)\b/i;
const english = /\b(?:yes|please|draft|create|make|send|move|summarize|call|turn|reply|tasks|schedule)\b/i;
// Capitalized German common nouns and sentence openings are not names. Unknown capitalized words fail closed.
const commonWords = new Set(
  "Ja Nein Bitte Yes No Please Entwirf Erstelle Erstell Leg Lege Schick Schicke Sende Verschieb Verschiebe Verlege Fass Fasse Lass Ruf Rufe Mach Mache Draft Create Make Send Move Summarize Call Turn Die Der Das Den Dem Ein Eine Einen Einer Ich Du Wir Antwort Antworten Antwortentwurf Entwurf Angebot Anfrage Mail E-Mail Nachricht Beleuchtung Variante Aufgabe Aufgaben Termin Donnerstag Deutsch Englisch Space Raumplanung Findings Tasks Reply Lighting"
    .toLocaleLowerCase("en")
    .split(" "),
);

export const checkNextMessageEval = (fixture: NextMessageEvalCase, raw: unknown) => {
  const problems: string[] = [];
  const text = typeof raw === "string" ? raw.trim() : null;
  const visible = `${fixture.user}\n${fixture.answer}`;
  const visibleWords = new Set(visible.toLocaleLowerCase("en").match(/[\p{L}-]+/gu));
  if (text) {
    if ([...text].length > 120) problems.push("length");
    if (normalizeAiNextMessage(text) === normalizeAiNextMessage(fixture.user)) problems.push("repetition");
    if (validateAiNextMessage(text, fixture.user) === null) problems.push("server_validation");
    if (!(fixture.language === "de" ? german : english).test(text) || (fixture.language === "de" ? english : german).test(text))
      problems.push("language");
    for (const token of text.match(/\+?\d[\d\s.:/-]*\d|\d|[\p{L}\d._%+-]+@[\p{L}\d.-]+\.[a-z]{2,}/giu) ?? [])
      if (!visible.includes(token.trim())) problems.push(`private_data:${token.trim()}`);
    for (const token of text.match(/\b\p{Lu}[\p{L}-]*\b/gu) ?? [])
      if (!commonWords.has(token.toLocaleLowerCase("en")) && !visibleWords.has(token.toLocaleLowerCase("en")))
        problems.push(`name:${token}`);
    if (fixture.expectation === "present" && !fixture.intent?.test(text)) problems.push("intent");
    if (fixture.expectation === "absent") problems.push("unwanted");
  } else if (raw !== null && raw !== undefined) problems.push("invalid_argument");
  if (!text && fixture.expectation === "present") problems.push("missing");
  return {
    id: fixture.id,
    raw,
    text: fixture.state ? null : validateAiNextMessage(raw, fixture.user),
    problems,
    pass: problems.length === 0,
  };
};
