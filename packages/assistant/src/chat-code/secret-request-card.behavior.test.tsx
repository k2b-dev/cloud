import { afterEach, expect, spyOn, test } from "bun:test";
import type { AiTurnBlock } from "@k2b/cloud/ai";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { SecretCardScene } from "./secret-card.fixture";

// The UI library needs a document when it loads.
const first = createDomTestHarness();
const { LocaleProvider } = await import("@k2b/ui");
const { SecretRequestEntry, storedSecretOutcome } = await import("./SecretRequestEntry");
const { registerSecretRequest } = await import("./secret-request-registry");
const { createSecretTitleStore } = await import("./secret-title-store");
const { SECRET_CARD_SCENES, SECRET_FIXTURE_VALUE, secretCardScene, secretSceneArgs } = await import("./secret-card.fixture");
first.cleanup();

const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});

type Step = SecretCardScene["step"];
/** Resolves once the document shows what `check` waits for; the test's own timeout bounds it. */
const until = (check: () => boolean) =>
  new Promise<void>((done) => {
    if (check()) return done();
    const observer = new MutationObserver(() => {
      if (!check()) return;
      observer.disconnect();
      done();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });

/** One call in the timeline, live with this window's controller, or as history after a reload. */
/** What the page's request loaded for the scenes' automation "Abc234"; `{}` is a chat opened without a reload. */
const LOADED = { Abc234: "Paketstatus abrufen" };
const mount = async (scene: SecretCardScene, live: boolean, titles: Record<string, string | null> = LOADED) => {
  const dom = createDomTestHarness();
  const driven = live ? await secretCardScene(scene) : undefined;
  // A reloaded page has no controller of the earlier window; its own call id keeps the live mount's controller away.
  const callId = live ? `call-${scene.id}` : `reload-${scene.id}`;
  const unregister = driven ? registerSecretRequest({ conversationId: "chat", turnId: "turn", callId }, driven.controller) : () => {};
  // One store per mounted page, as an island holds it.
  const store = createSecretTitleStore(titles);
  const [step, setStep] = createSignal<Step>(live ? "interaction" : scene.step);
  const [result, setResult] = createSignal<unknown>(live ? undefined : scene.result);
  const block = (): Extract<AiTurnBlock, { kind: "tool" }> => ({
    kind: "tool",
    id: `tool-${callId}`,
    callId,
    name: "code_secret",
    status: step() === "interaction" ? "awaiting_client" : "completed",
    args: secretSceneArgs(scene.code),
    result: result(),
    at: "2026-11-19T18:42:00.000Z",
  });
  const dispose = render(
    () => (
      <LocaleProvider locale="de">
        <SecretRequestEntry
          turnId="turn"
          block={block}
          state={step}
          conversationId={() => "chat"}
          timeZone="Europe/Berlin"
          titles={store}
        />
      </LocaleProvider>
    ),
    dom.root,
  );
  restore.push(() => {
    dispose();
    unregister();
    dom.cleanup();
  });
  // The card loads on demand; a call that never showed one leaves its place empty.
  await until(
    () => Boolean(dom.root.querySelector(".k2b-chat-decision, .k2b-chat-outcome")) || dom.root.querySelector(".contents")?.innerHTML === "",
  );
  return { dom, driven, setStep, setResult };
};

const text = (element: Element | null | undefined) => element?.textContent?.replace(/\s+/g, " ").trim() ?? null;
/** What a card shows: its sentence, facts, the visible line, the visible labels, and the field's state. */
const card = (root: HTMLElement) => {
  const input = root.querySelector<HTMLInputElement>(".k2b-chat-decision__field input");
  return {
    sentence: text(root.querySelector(".k2b-chat-decision__sentence")),
    facts: [...root.querySelectorAll(".k2b-chat-decision__fact-line")].map(text),
    line: text(root.querySelector('.k2b-chat-decision__line[data-current="true"]')),
    confirm: text(root.querySelector('.k2b-chat-decision__confirm .k2b-chat-decision__face[data-current="true"]')),
    decline: text(root.querySelector('.k2b-chat-decision__decline .k2b-chat-decision__face[data-current="true"]')),
    invalid: input?.getAttribute("aria-invalid") === "true",
    locked: Boolean(input?.disabled),
    value: input?.value ?? null,
  };
};
// The time stands apart by margin, so its "· 19:42" follows the sentence without a space in the text.
const outcome = (root: HTMLElement) => text(root.querySelector(".k2b-chat-outcome"))?.replace(/\s*· \d\d:\d\d$/, "") ?? null;

const CHAT_FACTS = [
  "Liegt nur für dich in diesem Chat, bis du es entfernst",
  "Geht nur an api.paketdienst-beispiel.de; jede Abfrage damit fragt dich vorher",
];
const CODE_FACTS = [
  "Liegt an der Automation „Paketstatus abrufen“, bis jemand es ersetzt oder löscht",
  "Geht nur an api.paketdienst-beispiel.de/v1, aus freigegebenen Versionen",
];
const SAFE = "Nicht im Chatverlauf; Gustav und Cloud zeigen den Wert nie.";
type Card = ReturnType<typeof card>;
/** Every scene of mockup v4 with a card, as the person sees it. */
const CARDS: Record<string, Partial<Card>> = {
  "a-neu": { sentence: "Paketdienst-API eintragen?", facts: CHAT_FACTS, line: SAFE, confirm: "Sicher speichern", decline: "Ablehnen" },
  "a-tippt": { line: SAFE, confirm: "Sicher speichern", value: SECRET_FIXTURE_VALUE, invalid: false },
  "b-ersetzen": {
    sentence: "Paketdienst-API ersetzen?",
    facts: ["Hinterlegt, nur für dich in diesem Chat", CHAT_FACTS[1]!],
    line: `${SAFE} Der alte ist danach weg.`,
    confirm: "Ersetzen",
    decline: "Behalten",
  },
  speichert: { confirm: "Speichert …", line: SAFE },
  "f-leer": { line: "Füge zuerst den Schlüssel ein.", invalid: true, confirm: "Sicher speichern" },
  "f-ungueltig": { line: "Ein Zeichen geht nicht, etwa „…“ oder ein Zeilenumbruch. Kopiere den ganzen Schlüssel.", invalid: true },
  "f-speichern": { line: "Speichern fehlgeschlagen. Versuch es erneut; dein Wert bleibt im Feld.", confirm: "Wiederholen" },
  konflikt: {
    sentence: "Paketdienst-API ersetzen?",
    line: "Inzwischen geändert. Deinen Wert trotzdem nehmen?",
    confirm: "Trotzdem ersetzen",
  },
  anderswo: { line: "Offen in einem anderen Fenster. Antworte dort.", locked: true, confirm: "Sicher speichern" },
  "c-neu": { sentence: "Paketdienst_API eintragen?", facts: CODE_FACTS, line: SAFE, confirm: "Sicher speichern", decline: "Ablehnen" },
  "c-tippt": { value: SECRET_FIXTURE_VALUE, line: SAFE },
  "c-ersetzen": {
    sentence: "Paketdienst_API ersetzen?",
    facts: ["Hinterlegt am 03.11. von Lea Brandt", ...CODE_FACTS],
    line: `${SAFE} Gilt ab dem nächsten Lauf, ohne neue Freigabe.`,
    confirm: "Ersetzen",
    decline: "Behalten",
  },
  "c-speichert": { confirm: "Speichert …" },
  "c-leer": { line: "Füge zuerst den Schlüssel ein.", invalid: true },
  "c-ungueltig": { line: "Umlaute und Zeichen wie „…“ gehen nicht. Kopiere den ganzen Schlüssel.", invalid: true },
  "c-speichern": { line: "Nicht gespeichert. Versuch es erneut; dein Wert bleibt im Feld.", confirm: "Wiederholen" },
  "c-konflikt": {
    sentence: "Paketdienst_API ersetzen?",
    facts: ["Hinterlegt am 03.11. von Lea Brandt", CODE_FACTS[0]!, "Ziel inzwischen geändert: api.paketdienst-beispiel.de/v2 (bisher /v1)"],
    line: "Das Ziel wurde inzwischen geändert. Prüf es oben, dann ersetzen.",
    confirm: "Ersetzen",
    decline: "Behalten",
  },
  "c-anderswo": { line: "Offen in einem anderen Fenster. Antworte dort.", locked: true },
  "c-unklar": { line: "Keine Antwort von Cloud, vielleicht gespeichert. Wiederholen prüft das zuerst.", confirm: "Wiederholen" },
  "c-geloescht": {
    sentence: "Paketdienst_API eintragen?",
    facts: ["Wert gelöscht; Läufe, die ihn brauchen, schlagen fehl", ...CODE_FACTS],
    confirm: "Sicher speichern",
  },
  "zu-lang+": { line: "Zu lang für einen Schlüssel. Kopiere nur den Schlüssel.", invalid: true },
  "c-bad-input+": { line: "Cloud nimmt diesen Wert nicht an. Kopiere nur den Schlüssel.", invalid: true },
  "c-ziel-bleibt+": {
    sentence: "Paketdienst_API ersetzen?",
    facts: [
      "Hinterlegt am 03.11. von Lea Brandt",
      CODE_FACTS[0]!,
      "Geht an alt.paketdienst-beispiel.de/api, wie bisher; ein anderes Ziel richtet ihr in der Automation ein",
    ],
    line: `${SAFE} Gilt ab dem nächsten Lauf, ohne neue Freigabe.`,
    confirm: "Ersetzen",
  },
  // Nobody moved the destination: the retry never claims "changed meanwhile".
  "c-ziel-bleibt-wiederholen+": {
    facts: [
      "Hinterlegt am 03.11. von Lea Brandt",
      CODE_FACTS[0]!,
      "Geht an alt.paketdienst-beispiel.de/api, wie bisher; ein anderes Ziel richtet ihr in der Automation ein",
    ],
    line: `${SAFE} Gilt ab dem nächsten Lauf, ohne neue Freigabe.`,
    confirm: "Ersetzen",
    value: SECRET_FIXTURE_VALUE,
  },
};
/** Every scene that ends: the one line the timeline keeps, live and after a reload. */
const LINES: Record<string, { live: string | null; reload: string | null }> = {
  gespeichert: { live: "Secret Paketdienst-API gespeichert", reload: "Secret Paketdienst-API gespeichert" },
  "b-ersetzt": { live: "Secret Paketdienst-API gespeichert", reload: "Secret Paketdienst-API gespeichert" },
  abgelehnt: { live: "Secret Paketdienst-API abgelehnt", reload: "Secret Paketdienst-API abgelehnt" },
  "f-recht": {
    live: "Secret Paketdienst-API nicht gespeichert: Deine Anmeldung ist abgelaufen. Gespeichert ist nichts.",
    reload: "Secret Paketdienst-API nicht gespeichert: Deine Anmeldung ist abgelaufen. Gespeichert ist nichts.",
  },
  abgelaufen: {
    live: "Anfrage nach Secret Paketdienst-API nicht mehr offen. Gespeichert ist nichts.",
    reload: "Anfrage nach Secret Paketdienst-API nicht mehr offen. Gespeichert ist nichts.",
  },
  "c-gespeichert": { live: "Secret Paketdienst_API gespeichert", reload: "Secret Paketdienst_API gespeichert" },
  "c-ersetzt": { live: "Secret Paketdienst_API gespeichert", reload: "Secret Paketdienst_API gespeichert" },
  "c-abgelehnt": { live: "Secret Paketdienst_API abgelehnt", reload: "Secret Paketdienst_API abgelehnt" },
  "c-recht": {
    live: "Secret Paketdienst_API nicht gespeichert: Du darfst „Paketstatus abrufen“ nicht mehr bearbeiten, oder es gibt sie nicht mehr. Gespeichert ist nichts.",
    // The stored result keeps no title; the page's request loaded it, so the reloaded line names the automation too.
    reload:
      "Secret Paketdienst_API nicht gespeichert: Du darfst „Paketstatus abrufen“ nicht mehr bearbeiten, oder es gibt sie nicht mehr. Gespeichert ist nichts.",
  },
  "c-abgelaufen": {
    live: "Anfrage nach Secret Paketdienst_API nicht mehr offen. Gespeichert ist nichts.",
    reload: "Anfrage nach Secret Paketdienst_API nicht mehr offen. Gespeichert ist nichts.",
  },
  "c-nicht-verwaltet": { live: null, reload: null },
  // The line follows the cause, not the mode: an expired sign-in at an automation, a chat that is gone.
  "c-anmeldung+": {
    live: "Secret Paketdienst_API nicht gespeichert: Deine Anmeldung ist abgelaufen. Gespeichert ist nichts.",
    reload: "Secret Paketdienst_API nicht gespeichert: Deine Anmeldung ist abgelaufen. Gespeichert ist nichts.",
  },
  "f-chat-weg+": {
    live: "Secret Paketdienst-API nicht gespeichert: Du kannst in diesem Chat nicht mehr schreiben, oder es gibt ihn nicht mehr. Gespeichert ist nichts.",
    reload:
      "Secret Paketdienst-API nicht gespeichert: Du kannst in diesem Chat nicht mehr schreiben, oder es gibt ihn nicht mehr. Gespeichert ist nichts.",
  },
  "c-ausgang-unklar+": {
    live: "Secret Paketdienst_API: Keine Antwort von Cloud, vielleicht gespeichert.",
    reload: "Secret Paketdienst_API: Keine Antwort von Cloud, vielleicht gespeichert.",
  },
};

test("the scenes cover every state of mockup v4 with a card or an outcome line, in both cases", () => {
  const ids = SECRET_CARD_SCENES.map((scene) => scene.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...Object.keys(CARDS), ...Object.keys(LINES)].sort()).toEqual([...ids].sort());
  // 31 of the mockup's 33 scenes; "wartet" and "c-wartet" are the waiting row, tested with the jump.
  expect(ids.filter((id) => !id.endsWith("+"))).toHaveLength(31);
});

for (const scene of SECRET_CARD_SCENES) {
  const expected = CARDS[scene.id];
  if (expected)
    test(`card ${scene.id}: words and field state in fixed cells, no value outside the field`, async () => {
      const { dom } = await mount(scene, true);
      expect(card(dom.root)).toMatchObject(expected);
      // The cell keeps every line and every label of the flow, so a change moves nothing.
      expect(dom.root.querySelectorAll(".k2b-chat-decision__line").length).toBe(12);
      expect(dom.root.querySelectorAll(".k2b-chat-decision__confirm .k2b-chat-decision__face").length).toBe(5);
      expect(dom.root.querySelector(".k2b-chat-decision")?.getAttribute("data-chat-anchor")).toBe(`tool-call-${scene.id}`);
      expect(dom.root.innerHTML).not.toContain(SECRET_FIXTURE_VALUE);
    });
  const line = LINES[scene.id];
  if (line)
    test(`line ${scene.id}: live and after a reload, never the value`, async () => {
      const live = await mount(scene, true);
      expect(outcome(live.dom.root)).toBe(line.live);
      expect(live.dom.root.querySelector(".k2b-chat-decision")).toBeNull();
      expect(live.dom.root.innerHTML).not.toContain(SECRET_FIXTURE_VALUE);
      const reload = await mount(scene, false);
      expect(outcome(reload.dom.root)).toBe(line.reload);
      expect(reload.dom.root.textContent ?? "").not.toContain(SECRET_FIXTURE_VALUE);
      if (line.reload) expect(text(reload.dom.root.querySelector(".k2b-chat-outcome__time"))).toBe("· 19:42");
    });
}

test("typing, saving and the saved line: the value goes into one save only, the line takes the focus", async () => {
  const scene = SECRET_CARD_SCENES.find((item) => item.id === "a-neu")!;
  const { dom, driven, setStep, setResult } = await mount(scene, true);
  const input = dom.root.querySelector<HTMLInputElement>(".k2b-chat-decision__field input")!;
  input.focus();
  input.value = SECRET_FIXTURE_VALUE;
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  expect(dom.root.querySelector(".k2b-chat-decision")?.getAttribute("data-mode")).toBe("edit");
  dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__confirm")!.click();
  await until(() => Boolean(dom.root.querySelector(".k2b-chat-outcome")));
  expect(outcome(dom.root)).toBe("Secret Paketdienst-API gespeichert");
  expect(document.activeElement?.classList.contains("k2b-chat-outcome")).toBe(true);
  expect(driven?.saves).toEqual([{ value: SECRET_FIXTURE_VALUE, revision: null, binding: expect.any(Object) }]);
  expect(await driven?.controller.result).toEqual({ configured: true, name: "Paketdienst-API" });
  // The stored result replaces the live one in the same line.
  setResult({ configured: true, name: "Paketdienst-API" });
  setStep("done");
  expect(outcome(dom.root)).toBe("Secret Paketdienst-API gespeichert");
  expect(dom.root.innerHTML).not.toContain(SECRET_FIXTURE_VALUE);
});

test("an empty save keeps the focus in the field; declining moves it to the line", async () => {
  const scene = SECRET_CARD_SCENES.find((item) => item.id === "c-neu")!;
  const { dom } = await mount(scene, true);
  const input = dom.root.querySelector<HTMLInputElement>(".k2b-chat-decision__field input")!;
  input.focus();
  dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__confirm")!.click();
  await until(() => card(dom.root).invalid);
  expect(card(dom.root)).toMatchObject({ line: "Füge zuerst den Schlüssel ein.", invalid: true });
  expect(document.activeElement).toBe(input);
  // The answer's promise settles before the next press can reach the card.
  await until(() => dom.root.querySelector(".k2b-chat-decision__decline")?.getAttribute("aria-disabled") !== "true");
  dom.root.querySelector<HTMLButtonElement>(".k2b-chat-decision__decline")!.click();
  await until(() => Boolean(dom.root.querySelector(".k2b-chat-outcome")));
  expect(outcome(dom.root)).toBe("Secret Paketdienst_API abgelehnt");
  expect(document.activeElement?.classList.contains("k2b-chat-outcome")).toBe(true);
});

test("a held card outcome from another window takes no focus here", async () => {
  const scene = SECRET_CARD_SCENES.find((item) => item.id === "anderswo")!;
  const { dom, driven } = await mount(scene, true);
  const outside = document.createElement("button");
  dom.root.append(outside);
  outside.focus();
  driven?.controller.complete({ configured: true, name: "Paketdienst-API" });
  await until(() => Boolean(dom.root.querySelector(".k2b-chat-outcome")));
  expect(outcome(dom.root)).toBe("Secret Paketdienst-API gespeichert");
  expect(document.activeElement).toBe(outside);
});

test("a lost-right line names no automation when Core has none, and a chat opened without a reload asks for it once", async () => {
  const scene = SECRET_CARD_SCENES.find((item) => item.id === "c-recht")!;
  const gone = await mount(scene, false, { Abc234: null });
  expect(outcome(gone.dom.root)).toContain("Du darfst die Automation nicht mehr bearbeiten");
  const reads: unknown[] = [];
  const request = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        reads.push({ url: String(url), body: init?.body ?? null });
        return Response.json({ data: { code: { title: "Paketstatus abrufen" } } });
      },
      { preconnect: fetch.preconnect },
    ),
  );
  restore.push(() => request.mockRestore());
  const opened = await mount(scene, false, {});
  await until(() => outcome(opened.dom.root)?.includes("„Paketstatus abrufen“") ?? false);
  expect(reads).toHaveLength(1);
  expect(JSON.stringify(reads[0])).toContain("Abc234");
});

test("the automation fact shows the Code glyph of @k2b/ui", async () => {
  const { dom } = await mount(SECRET_CARD_SCENES.find((item) => item.id === "c-neu")!, true);
  const icons = [...dom.root.querySelectorAll(".k2b-chat-decision__fact-line i")].map((icon) => icon.className);
  expect(icons).toEqual([expect.stringContaining("ti-feat-code"), expect.stringContaining("ti-world")]);
});

test("a stored failure names its outcome only from the fixed sentences", () => {
  expect(storedSecretOutcome("failed", { failed: true, error: "Secret was not saved." })).toBe("access");
  expect(storedSecretOutcome("failed", { failed: true, error: "Secret was not saved because the sign-in expired." })).toBe("signIn");
  expect(storedSecretOutcome("failed", { failed: true, error: "Secret entry is unavailable." })).toBeNull();
  expect(storedSecretOutcome("failed", { failed: true, error: "anything else" })).toBe("expired");
  expect(storedSecretOutcome("not_run", undefined)).toBe("expired");
  expect(storedSecretOutcome("interaction", undefined)).toBeNull();
});

test("without this window's controller the waiting call is a quiet step, never a card", async () => {
  const scene = SECRET_CARD_SCENES.find((item) => item.id === "a-neu")!;
  const dom = createDomTestHarness();
  const block = (): Extract<AiTurnBlock, { kind: "tool" }> => ({
    kind: "tool",
    id: "tool-x",
    callId: "x",
    name: "code_secret",
    status: "awaiting_client",
    args: secretSceneArgs(scene.code),
  });
  const dispose = render(
    () => (
      <LocaleProvider locale="de">
        <SecretRequestEntry turnId="turn" block={block} state={() => "interaction"} conversationId={() => "chat"} timeZone="UTC" />
      </LocaleProvider>
    ),
    dom.root,
  );
  restore.push(() => {
    dispose();
    dom.cleanup();
  });
  expect(dom.root.querySelector(".k2b-chat-decision")).toBeNull();
  expect(text(dom.root)).toBe("Secret Paketdienst-API");
});
