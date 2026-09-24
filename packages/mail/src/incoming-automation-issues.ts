import { i18n } from "@k2b/stdlib";
import type { z } from "zod";

/** One invalid field in an incoming automation definition, in the same shape as contact-directory issues. */
export type IncomingAutomationIssue = { field: string; code: string; message: string };

/** Enough to name every problem in a realistic definition without an unbounded response. */
const MAX_ISSUES = 20;

type Kind = "array" | "object" | "string" | "number" | "boolean" | "null";

const messages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      kind_array: "a list",
      kind_object: "an object",
      kind_string: "text",
      kind_number: "a number",
      kind_boolean: "true or false",
      kind_null: "null",
      required: ({ expected }: { expected: string }) => `Required. Expected ${expected}.`,
      wrongType: ({ expected, received }: { expected: string; received: string }) => `Expected ${expected}, got ${received}.`,
      notEmpty: "Must not be empty.",
      minItems: ({ minimum }: { minimum: number }) => `Add at least ${minimum} ${minimum === 1 ? "item" : "items"}.`,
      maxItems: ({ maximum }: { maximum: number }) => `Use at most ${maximum} ${maximum === 1 ? "item" : "items"}.`,
      minCharacters: ({ minimum }: { minimum: number }) => `Use at least ${minimum} characters.`,
      maxCharacters: ({ maximum }: { maximum: number }) => `Use at most ${maximum} characters.`,
      minNumber: ({ minimum }: { minimum: number }) => `Must be at least ${minimum}.`,
      maxNumber: ({ maximum }: { maximum: number }) => `Must be at most ${maximum}.`,
      unknownField: "Unknown field.",
      oneOf: ({ values }: { values: string }) => `Use one of: ${values}.`,
      noMatchingShape: "Does not match any allowed form.",
      invalidFormat: ({ format }: { format: string }) => `Invalid format (${format}).`,
      summary: ({ field, message, more }: { field: string; message: string; more: number }) =>
        `Invalid incoming automation definition: ${field}: ${message}${more > 0 ? ` (+${more} more)` : ""}`,
    },
    de: {
      kind_array: "eine Liste",
      kind_object: "ein Objekt",
      kind_string: "Text",
      kind_number: "eine Zahl",
      kind_boolean: "true oder false",
      kind_null: "null",
      required: ({ expected }) => `Pflichtfeld. Erwartet wird ${expected}.`,
      wrongType: ({ expected, received }) => `Erwartet wird ${expected}, erhalten: ${received}.`,
      notEmpty: "Darf nicht leer sein.",
      minItems: ({ minimum }) => `Mindestens ${minimum} ${minimum === 1 ? "Eintrag" : "Einträge"} angeben.`,
      maxItems: ({ maximum }) => `Höchstens ${maximum} ${maximum === 1 ? "Eintrag" : "Einträge"} angeben.`,
      minCharacters: ({ minimum }) => `Mindestens ${minimum} Zeichen verwenden.`,
      maxCharacters: ({ maximum }) => `Höchstens ${maximum} Zeichen verwenden.`,
      minNumber: ({ minimum }) => `Muss mindestens ${minimum} sein.`,
      maxNumber: ({ maximum }) => `Darf höchstens ${maximum} sein.`,
      unknownField: "Unbekanntes Feld.",
      oneOf: ({ values }) => `Erlaubt ist: ${values}.`,
      noMatchingShape: "Passt zu keiner erlaubten Form.",
      invalidFormat: ({ format }) => `Ungültiges Format (${format}).`,
      summary: ({ field, message, more }) => `Ungültige Automatisierung: ${field}: ${message}${more > 0 ? ` (+${more} weitere)` : ""}`,
    },
  },
});

type Messages = ReturnType<typeof messages.resolve>["t"];

/** German counterparts of the schema's own English refinement messages; other locales keep the schema text. */
const germanRefinementMessages: Record<string, string> = {
  "Remove duplicate automation conditions": "Entferne doppelte Bedingungen.",
  "Enter a valid sender email address": "Gib eine gültige Absenderadresse ein.",
  "Enter a valid sender domain": "Gib eine gültige Absenderdomain ein.",
  "Event end must be after its start": "Das Ende des Termins muss nach dem Beginn liegen.",
  "Automation branches can be nested at most 4 levels": "Verzweigungen können höchstens 4 Ebenen tief verschachtelt sein.",
  "Automation step IDs must be unique": "Schritt-IDs müssen eindeutig sein.",
  "AI choice names must be unique": "Die Namen der KI-Auswahlmöglichkeiten müssen eindeutig sein.",
  "Maximum choices cannot exceed the available choices": "Die maximale Auswahl darf die verfügbaren Möglichkeiten nicht übersteigen.",
  "Select an earlier text-producing AI step": "Wähle einen früheren KI-Schritt, der Text erzeugt.",
  "Select an earlier AI event-data step": "Wähle einen früheren KI-Schritt für Termindaten.",
  "Select an earlier AI output": "Wähle eine frühere KI-Ausgabe.",
  "Event-data outputs can only be used by a create-event step":
    "Termindaten können nur von einem Schritt verwendet werden, der einen Termin erstellt.",
  "Condition value must be one of the AI choices": "Der Bedingungswert muss eine der KI-Auswahlmöglichkeiten sein.",
  "One reachable path can contain only one provider message action": "Ein Pfad kann nur eine Aktion am Postfach des Anbieters enthalten.",
  "One reachable path can assign only once": "Ein Pfad kann nur einmal zuweisen.",
  "One reachable path can set status only once": "Ein Pfad kann den Status nur einmal setzen.",
  "One reachable path cannot add the same tag twice": "Ein Pfad kann denselben Tag nicht zweimal hinzufügen.",
  "One reachable path can set the conversation summary only once": "Ein Pfad kann die Zusammenfassung nur einmal setzen.",
  "An automation can have at most 40 steps": "Eine Automatisierung kann höchstens 40 Schritte haben.",
  "An automation can make at most 10 AI calls": "Eine Automatisierung kann höchstens 10 KI-Aufrufe ausführen.",
};

const refinementMessage = (message: string, locale: string): string =>
  (locale === "de" ? germanRefinementMessages[message] : undefined) ?? message;

const kindOf = (value: unknown): Kind => {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  const type = typeof value;
  return type === "string" || type === "number" || type === "boolean" ? type : "object";
};

const valueAt = (input: unknown, path: readonly PropertyKey[]): unknown =>
  path.reduce<unknown>(
    (value, segment) => (value !== null && typeof value === "object" ? (value as Record<PropertyKey, unknown>)[segment] : undefined),
    input,
  );

const fieldOf = (path: readonly PropertyKey[]): string => path.map(String).join(".") || "definition";

const kindNames = (t: Messages): Record<string, string> => ({
  array: t.kind_array,
  object: t.kind_object,
  string: t.kind_string,
  number: t.kind_number,
  boolean: t.kind_boolean,
  null: t.kind_null,
});
const kindName = (t: Messages, kind: string): string => kindNames(t)[kind] ?? kind;

const describe = (t: Messages, locale: string, issue: z.core.$ZodIssue, input: unknown): string => {
  switch (issue.code) {
    case "invalid_type": {
      const value = valueAt(input, issue.path);
      const expected = kindName(t, issue.expected);
      return value === undefined ? t.required({ expected }) : t.wrongType({ expected, received: kindName(t, kindOf(value)) });
    }
    case "too_small": {
      const minimum = Number(issue.minimum);
      if (issue.origin === "array") return t.minItems({ minimum });
      if (issue.origin === "string") return minimum === 1 ? t.notEmpty : t.minCharacters({ minimum });
      return t.minNumber({ minimum });
    }
    case "too_big": {
      const maximum = Number(issue.maximum);
      if (issue.origin === "array") return t.maxItems({ maximum });
      if (issue.origin === "string") return t.maxCharacters({ maximum });
      return t.maxNumber({ maximum });
    }
    case "invalid_value":
      return t.oneOf({ values: issue.values.map(String).join(", ") });
    case "invalid_union":
      return "options" in issue && Array.isArray(issue.options)
        ? t.oneOf({ values: issue.options.map(String).join(", ") })
        : t.noMatchingShape;
    case "invalid_format":
      return t.invalidFormat({ format: issue.format });
    default:
      return refinementMessage(issue.message, locale);
  }
};

/** Names each invalid field of an incoming automation definition with a localized, human message. */
export const incomingAutomationIssues = (error: z.ZodError, input: unknown, locale?: string | null): IncomingAutomationIssue[] => {
  const { t, locale: resolved } = messages.resolve(locale ? [locale] : []);
  return error.issues
    .flatMap((issue): IncomingAutomationIssue[] =>
      issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => ({ field: fieldOf([...issue.path, key]), code: issue.code, message: t.unknownField }))
        : [{ field: fieldOf(issue.path), code: issue.code, message: describe(t, resolved, issue, input) }],
    )
    .slice(0, MAX_ISSUES);
};

/** One-line summary naming the first invalid field, for surfaces that show a single message. */
export const summarizeIncomingAutomationIssues = (issues: readonly IncomingAutomationIssue[], locale?: string | null): string => {
  const { t } = messages.resolve(locale ? [locale] : []);
  const [first] = issues;
  return first ? t.summary({ field: first.field, message: first.message, more: issues.length - 1 }) : t.noMatchingShape;
};
