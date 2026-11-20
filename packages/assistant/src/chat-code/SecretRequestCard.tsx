import { i18n } from "@k2b/stdlib";
import { Chat, type ChatDecisionAnswer, type ChatDecisionReason, useLocale } from "@k2b/ui";
import { ChatDecisionField } from "@k2b/ui/chat-decision-field";
import { createMemo, type JSX } from "solid-js";
import type { SecretRequestBinding, SecretRequestController, SecretRequestState } from "./secret-request";

const messages = /* @__PURE__ */ i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      kind: "Secret",
      add: "Enter {name}?",
      replace: "Replace {name}?",
      chatStays: "Stays only for you in this chat until you remove it",
      chatStored: "Stored, only for you in this chat",
      chatGoes: ({ host }: { host: string }) => `Goes only to ${host}; every request with it asks you first`,
      codeStays: ({ title }: { title: string | null }) =>
        title
          ? `Stays on the automation “${title}” until someone replaces or deletes it`
          : "Stays on this automation until someone replaces or deletes it",
      codeGoes: ({ target }: { target: string }) => `Goes only to ${target}, from approved versions`,
      codeKept: ({ target }: { target: string }) => `Goes to ${target}, as before; set up another destination in the automation`,
      codeMoved: ({ target, before }: { target: string; before: string }) => `Destination changed meanwhile: ${target} (was ${before})`,
      storedBy: ({ date, name }: { date: string | null; name: string | null }) =>
        date ? (name ? `Stored on ${date} by ${name}` : `Stored on ${date}`) : "Stored",
      deleted: "Value deleted; runs that need it fail",
      label: ({ name }: { name: string }) => `Value for ${name}`,
      placeholder: "Paste the key",
      placeholderNew: "Paste the new key",
      reveal: "Show value",
      safe: "Not in the chat history; Gustav and Cloud never show the value.",
      safeChatReplace: "Not in the chat history; Gustav and Cloud never show the value. The old one is gone afterwards.",
      safeCodeReplace: "Not in the chat history; Gustav and Cloud never show the value. Applies from the next run, without a new approval.",
      held: "Open in another window. Answer there.",
      empty: "Paste the key first.",
      chatCharacters: "One character does not work, such as “…” or a line break. Copy the whole key.",
      codeCharacters: "Umlauts and characters such as “…” do not work. Copy the whole key.",
      long: "Too long for a key. Copy only the key.",
      chatFailed: "Saving failed. Try again; your value stays in the field.",
      codeFailed: "Not saved. Try again; your value stays in the field.",
      unknown: "No answer from Cloud, maybe saved. Try again checks that first.",
      chatConflict: "Changed meanwhile. Use your value anyway?",
      codeConflict: "The destination changed meanwhile. Check it above, then replace.",
      badInput: "Cloud does not take this value. Copy only the key.",
      refused: "This destination may not receive a secret. Nothing was saved.",
      unchecked: "The destination could not be checked. Try again; your value stays in the field.",
      save: "Save securely",
      replaceAnswer: "Replace",
      saving: "Saving …",
      retry: "Try again",
      force: "Replace anyway",
      decline: "Decline",
      keep: "Keep",
    },
    de: {
      kind: "Secret",
      add: "{name} eintragen?",
      replace: "{name} ersetzen?",
      chatStays: "Liegt nur für dich in diesem Chat, bis du es entfernst",
      chatStored: "Hinterlegt, nur für dich in diesem Chat",
      chatGoes: ({ host }) => `Geht nur an ${host}; jede Abfrage damit fragt dich vorher`,
      codeStays: ({ title }) =>
        title
          ? `Liegt an der Automation „${title}“, bis jemand es ersetzt oder löscht`
          : "Liegt an dieser Automation, bis jemand es ersetzt oder löscht",
      codeGoes: ({ target }) => `Geht nur an ${target}, aus freigegebenen Versionen`,
      codeKept: ({ target }) => `Geht an ${target}, wie bisher; ein anderes Ziel richtet ihr in der Automation ein`,
      codeMoved: ({ target, before }) => `Ziel inzwischen geändert: ${target} (bisher ${before})`,
      storedBy: ({ date, name }) => (date ? (name ? `Hinterlegt am ${date} von ${name}` : `Hinterlegt am ${date}`) : "Hinterlegt"),
      deleted: "Wert gelöscht; Läufe, die ihn brauchen, schlagen fehl",
      label: ({ name }) => `Wert für ${name}`,
      placeholder: "Schlüssel einfügen",
      placeholderNew: "Neuen Schlüssel einfügen",
      reveal: "Wert anzeigen",
      safe: "Nicht im Chatverlauf; Gustav und Cloud zeigen den Wert nie.",
      safeChatReplace: "Nicht im Chatverlauf; Gustav und Cloud zeigen den Wert nie. Der alte ist danach weg.",
      safeCodeReplace: "Nicht im Chatverlauf; Gustav und Cloud zeigen den Wert nie. Gilt ab dem nächsten Lauf, ohne neue Freigabe.",
      held: "Offen in einem anderen Fenster. Antworte dort.",
      empty: "Füge zuerst den Schlüssel ein.",
      chatCharacters: "Ein Zeichen geht nicht, etwa „…“ oder ein Zeilenumbruch. Kopiere den ganzen Schlüssel.",
      codeCharacters: "Umlaute und Zeichen wie „…“ gehen nicht. Kopiere den ganzen Schlüssel.",
      long: "Zu lang für einen Schlüssel. Kopiere nur den Schlüssel.",
      chatFailed: "Speichern fehlgeschlagen. Versuch es erneut; dein Wert bleibt im Feld.",
      codeFailed: "Nicht gespeichert. Versuch es erneut; dein Wert bleibt im Feld.",
      unknown: "Keine Antwort von Cloud, vielleicht gespeichert. Wiederholen prüft das zuerst.",
      chatConflict: "Inzwischen geändert. Deinen Wert trotzdem nehmen?",
      codeConflict: "Das Ziel wurde inzwischen geändert. Prüf es oben, dann ersetzen.",
      badInput: "Cloud nimmt diesen Wert nicht an. Kopiere nur den Schlüssel.",
      refused: "Dieses Ziel darf kein Secret bekommen. Gespeichert ist nichts.",
      unchecked: "Das Ziel ließ sich nicht prüfen. Versuch es erneut; dein Wert bleibt im Feld.",
      save: "Sicher speichern",
      replaceAnswer: "Ersetzen",
      saving: "Speichert …",
      retry: "Wiederholen",
      force: "Trotzdem ersetzen",
      decline: "Ablehnen",
      keep: "Behalten",
    },
  },
});

type Words = ReturnType<typeof messages.resolve>["t"];
type Line =
  | "safe"
  | "safeReplace"
  | "held"
  | "empty"
  | "characters"
  | "long"
  | "failed"
  | "unknown"
  | "conflict"
  | "badInput"
  | "refused"
  | "unchecked";
type Face = "save" | "replace" | "saving" | "retry" | "force";

/** Host and path as the card names a destination: no scheme, the path only when it narrows the host. */
const destination = (binding: Pick<SecretRequestBinding, "origin" | "pathPrefix">, withPath: boolean) => {
  let host = binding.origin;
  try {
    host = new URL(binding.origin).host;
  } catch {
    /* A stored origin is always a URL; the raw text is still the honest name. */
  }
  const path = binding.pathPrefix.replace(/\/+$/, "");
  return withPath && path ? `${host}${path}` : host;
};

/** Which line under the field and which label of the main answer each state shows. */
export const secretCardView = (
  state: SecretRequestState,
  moved: boolean,
): { line: Line; face: Face; invalid: boolean; locked: boolean } => {
  const replacing = Boolean(state.existing?.configured);
  const resting: Face = replacing ? "replace" : "save";
  const safe: Line = replacing ? "safeReplace" : "safe";
  switch (state.state) {
    case "held":
      return { line: "held", face: resting, invalid: false, locked: true };
    case "empty":
      return { line: "empty", face: resting, invalid: true, locked: false };
    case "characters":
      return { line: "characters", face: resting, invalid: true, locked: false };
    case "too-long":
      return { line: "long", face: resting, invalid: true, locked: false };
    case "saving":
    case "refreshing":
      return { line: safe, face: "saving", invalid: false, locked: false };
    case "save-failed":
      return { line: "failed", face: "retry", invalid: false, locked: false };
    case "no-answer":
      return { line: "unknown", face: "retry", invalid: false, locked: false };
    case "conflict":
      return { line: "conflict", face: moved ? "replace" : "force", invalid: false, locked: false };
    case "not-saved":
      return state.reason === "bad-input"
        ? { line: "badInput", face: resting, invalid: true, locked: false }
        : state.reason === "destination-refused"
          ? { line: "refused", face: resting, invalid: false, locked: false }
          : { line: state.reason === "rejected" ? "failed" : "unchecked", face: "retry", invalid: false, locked: false };
    default:
      return { line: safe, face: resting, invalid: false, locked: false };
  }
};

const lineOf = (words: Words, code: boolean, moved: boolean): Record<Line, ChatDecisionReason> => {
  const danger = (text: string): ChatDecisionReason => ({ text, icon: "ti ti-alert-circle", tone: "danger" });
  return {
    safe: { text: words.safe, icon: "ti ti-shield-lock" },
    safeReplace: { text: code ? words.safeCodeReplace : words.safeChatReplace, icon: "ti ti-shield-lock" },
    held: { text: words.held, icon: "ti ti-devices" },
    empty: danger(words.empty),
    characters: danger(code ? words.codeCharacters : words.chatCharacters),
    long: danger(words.long),
    failed: danger(code ? words.codeFailed : words.chatFailed),
    unknown: { text: words.unknown, icon: "ti ti-help-circle", tone: "warning" },
    conflict: { text: code && moved ? words.codeConflict : words.chatConflict, icon: "ti ti-alert-triangle", tone: "warning" },
    badInput: danger(words.badInput),
    refused: danger(words.refused),
    unchecked: danger(words.unchecked),
  };
};

/** "Parcel_API enter?" with the name in bold, in the catalog's word order. */
const sentenceOf = (frame: string, name: string): JSX.Element =>
  frame.split(/(\{name\})/).map((part) => (part === "{name}" ? <strong>{name}</strong> : part));

/**
 * The open request as a question in the timeline: what it is, the name, the facts on the surface colour, one field
 * with the eye, the main answer and the quiet one. Every state only changes words in fixed cells. The value lives in
 * the controller of this window and the field; it is never written anywhere else.
 */
export function SecretRequestCard(props: {
  controller: SecretRequestController;
  /** An open request: never checking, unavailable or ended; those show no card. */
  state: SecretRequestState;
  anchorId: string;
  timeZone: string;
  /** The person answered in this window: the outcome line takes the focus. */
  onAnswer: () => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => messages.resolve([locale()]).t);
  const code = () => props.state.mode === "code";
  const replacing = () => Boolean(props.state.existing?.configured);
  // Only a change by someone else since the card showed; a stored destination that differs from the request stays calm.
  const moved = () => code() && props.state.before !== null;
  const view = createMemo(() => secretCardView(props.state, moved()));
  const value = () => ("value" in props.state ? props.state.value : "");
  const facts = createMemo((): ChatDecisionReason[] => {
    const words = t();
    const state = props.state;
    if (!code()) {
      return [
        replacing() ? { text: words.chatStored, icon: "ti ti-history" } : { text: words.chatStays, icon: "ti ti-message-circle" },
        { text: words.chatGoes({ host: destination(state.binding, false) }), icon: "ti ti-world" },
      ];
    }
    const existing = state.existing;
    const at = existing?.valueSetAt;
    const date = at
      ? new Intl.DateTimeFormat(locale(), { timeZone: props.timeZone, day: "2-digit", month: "2-digit" }).format(new Date(at))
      : null;
    const before = state.before;
    return [
      ...(existing?.configured
        ? [{ text: words.storedBy({ date, name: existing.valueSetBy?.name ?? null }), icon: "ti ti-history" }]
        : existing
          ? [{ text: words.deleted, icon: "ti ti-history" }]
          : []),
      // The Code glyph of the mockup, which @k2b/ui carries as `ti-feat-code`.
      { text: words.codeStays({ title: state.title }), icon: "ti ti-feat-code" },
      state.state === "conflict" && before
        ? {
            text: words.codeMoved({
              target: destination(state.binding, true),
              before:
                destination(state.binding, false) === destination(before, false)
                  ? before.pathPrefix.replace(/\/+$/, "") || "/"
                  : destination(before, true),
            }),
            icon: "ti ti-alert-triangle",
            tone: "warning",
          }
        : {
            text: (state.kept ? words.codeKept : words.codeGoes)({ target: destination(state.binding, true) }),
            icon: "ti ti-world",
          },
    ];
  });
  const faces = createMemo(() => {
    const words = t();
    const all: Record<Face, { label: string; icon?: string }> = {
      save: { label: words.save, icon: "ti ti-lock" },
      replace: { label: words.replaceAnswer, icon: "ti ti-lock" },
      saving: { label: words.saving, icon: "ti ti-loader-2 k2b-spin" },
      retry: { label: words.retry, icon: "ti ti-refresh" },
      force: { label: words.force },
    };
    return all;
  });
  const act = (face: Face): Promise<void> => {
    props.onAnswer();
    const controller = props.controller;
    if (face === "retry") return controller.retry();
    if (face === "replace" || face === "force") return controller.replace();
    return controller.submit();
  };
  const confirm = (): ChatDecisionAnswer => {
    const face = view().face;
    // Saving shows "Saving …" while the answer's promise holds the card; the other labels share the button's cell.
    return { ...faces()[face], alternates: Object.values(faces()), onSelect: () => act(face) };
  };
  const decline = (): ChatDecisionAnswer => ({
    label: replacing() ? t().keep : t().decline,
    alternates: [{ label: t().keep }, { label: t().decline }],
    onSelect: () => {
      props.onAnswer();
      props.controller.decline();
    },
  });

  return (
    <Chat.Decision
      state="open"
      kind={{ label: t().kind, icon: "ti ti-key" }}
      sentence={sentenceOf(replacing() ? t().replace : t().add, props.state.name)}
      anchorId={props.anchorId}
      entry={
        <ChatDecisionField
          facts={facts()}
          label={t().label({ name: props.state.name })}
          value={value()}
          onValueChange={(next) => props.controller.input(next)}
          placeholder={replacing() ? t().placeholderNew : t().placeholder}
          revealLabel={t().reveal}
          lines={lineOf(t(), code(), moved())}
          current={view().line}
          invalid={view().invalid}
          disabled={view().locked}
          confirm={confirm()}
          decline={decline()}
        />
      }
    />
  );
}
