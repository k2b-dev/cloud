import { afterEach, expect, setSystemTime, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { AssistantCodeDecision } from "./AssistantCodeDecisionLine";

// The UI library needs a document when it loads.
const first = createDomTestHarness();
const { LocaleProvider } = await import("@k2b/ui");
const lines = await import("./AssistantCodeDecisionLine");
const { default: AssistantCodeDecisionLine, jumpToCodeVersionCard } = lines;
first.cleanup();

const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
});
const decision = (outcome: AssistantCodeDecision["outcome"]): AssistantCodeDecision => ({
  codeId: "c_info01",
  versionId: "66666666-6666-4666-8666-666666666666",
  number: 5,
  outcome,
  person: { id: "u-jana", name: outcome === "activated" ? null : "Jana Probe" },
  anchor: "code-version-66666666-6666-4666-8666-666666666666",
});
const at = "2026-11-12T13:01:00.000Z";

/** A chat with the version card far up, history between, and the event line at the end. */
const mount = (value: AssistantCodeDecision, options: { card?: boolean; onReveal?: (anchor: string) => Promise<boolean> } = {}) => {
  const dom = createDomTestHarness();
  const card = document.createElement("section");
  if (options.card !== false) {
    card.setAttribute("data-chat-anchor", value.anchor);
    card.innerHTML =
      '<p class="k2b-chat-decision__sentence" tabindex="-1">Version 5?</p><button class="k2b-chat-decision__answer" data-variant="ai">Version 5 einschalten</button>';
    dom.root.append(card);
  }
  const host = document.createElement("div");
  dom.root.append(host);
  const dispose = render(
    () => (
      <LocaleProvider locale="de">
        <AssistantCodeDecisionLine decision={value} at={at} timeZone="Europe/Berlin" onReveal={options.onReveal} />
      </LocaleProvider>
    ),
    host,
  );
  restore.push(() => {
    dispose();
    dom.cleanup();
  });
  return { dom, card, line: host };
};
const action = (root: Element) => root.querySelector<HTMLButtonElement>(".assistant-code-decision__action");

test("each outcome says who decided what about which version, with at most one action", () => {
  const cases = [
    ["approved", "Jana Probe hat Version 5 freigegeben", "Zur Karte"],
    ["changes_requested", "Jana Probe hat Änderungen an Version 5 angefordert", "Ansehen"],
    ["rejected", "Jana Probe hat Version 5 abgelehnt", "Begründung ansehen"],
    ["activated", "Du hast Version 5 eingeschaltet", null],
  ] as const;
  for (const [outcome, sentence, label] of cases) {
    const { line } = mount(decision(outcome));
    const text = line.querySelector(".assistant-code-decision__text")!.textContent!.replace(/\s+/g, " ");
    expect(text).toStartWith(sentence);
    expect(text).toContain("·");
    expect(line.querySelectorAll("button").length).toBe(label ? 1 : 0);
    if (label) expect(action(line)!.textContent!.trim()).toBe(label);
    for (const undo of restore.splice(0)) undo();
  }
});

test("a name the person may not see stays out; the line then says an admin decided", () => {
  const { line } = mount({ ...decision("approved"), person: { id: null, name: null } });
  expect(line.textContent).toContain("Ein Admin hat Version 5 freigegeben");
});

test("the action jumps to the card and puts the focus on its main answer; the line itself never takes focus", () => {
  const { line, card } = mount(decision("approved"));
  expect(document.activeElement).not.toBe(card.querySelector("button"));
  action(line)!.click();
  expect(document.activeElement).toBe(card.querySelector<HTMLElement>(".k2b-chat-decision__answer"));
});

test("a card without an answer takes the focus on its question", () => {
  const dom = createDomTestHarness();
  restore.push(() => dom.cleanup());
  const card = document.createElement("section");
  card.setAttribute("data-chat-anchor", "a");
  card.innerHTML = '<p class="k2b-chat-decision__sentence" tabindex="-1">Version 5 wurde abgelehnt.</p>';
  dom.root.append(card);
  expect(jumpToCodeVersionCard("a", dom.root)).toBe(true);
  expect(document.activeElement).toBe(card.querySelector(".k2b-chat-decision__sentence"));
  expect(jumpToCodeVersionCard("missing", dom.root)).toBe(false);
});

test("a card not on the page is revealed by the host first; if that fails, the line says where it is", async () => {
  const asked: string[] = [];
  const { line } = mount(decision("rejected"), {
    card: false,
    onReveal: async (anchor) => {
      asked.push(anchor);
      return false;
    },
  });
  action(line)!.click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(asked).toEqual([decision("rejected").anchor]);
  expect(line.querySelector(".assistant-code-decision__missing")?.textContent).toContain("weiter oben in diesem Chat");
});

test("changes that Gustav revises by himself carry the mark and no action; a settled approval stays as history", () => {
  const { AssistantCodeReviewStartLine } = lines;
  // The next run is counted from now: the clock stands at the decision's time.
  setSystemTime(new Date(at));
  restore.push(() => setSystemTime());
  const dom = createDomTestHarness();
  restore.push(() => dom.cleanup());
  const dispose = render(
    () => (
      <LocaleProvider locale="de">
        <AssistantCodeDecisionLine decision={decision("changes_requested")} at={at} timeZone="Europe/Berlin" automatic />
        <AssistantCodeDecisionLine decision={decision("approved")} at={at} timeZone="Europe/Berlin" settled />
        <AssistantCodeDecisionLine
          decision={{ ...decision("activated"), nextRunAt: new Date(Date.parse(at) + 11 * 60_000).toISOString() }}
          at={at}
          timeZone="Europe/Berlin"
        />
        <AssistantCodeReviewStartLine number={5} />
      </LocaleProvider>
    ),
    dom.root,
  );
  restore.push(dispose);
  const rows = [...dom.root.querySelectorAll(".assistant-code-decision")];
  expect(rows[0]!.textContent).toContain("Gustav startet von selbst, einmal");
  expect(rows[0]!.querySelectorAll("button").length).toBe(0);
  expect(rows[1]!.querySelectorAll("button").length).toBe(0);
  expect(rows[2]!.textContent).toContain("Du hast Version 5 eingeschaltet");
  expect(rows[2]!.textContent).toContain("nächster Lauf in 11 Minuten");
  // The start of Gustav's turn never repeats the decision line above it.
  expect(rows[3]!.textContent).toBe("Gustav überarbeitet Version 5 jetzt, einmal von selbst.");
  expect(rows[3]!.textContent).not.toContain("angefordert");
});
