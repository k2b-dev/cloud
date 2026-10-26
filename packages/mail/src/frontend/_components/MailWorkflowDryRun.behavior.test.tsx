import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { WorkflowTryResult } from "../../contracts";
import { dryRunFixtureBatch, dryRunFixtureItems } from "./mail-workflow-dry-run-fixtures";

const NOW = Date.parse("2026-10-26T09:30:00.000Z");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

type Deferred = { cursor: string | null; resolve: (value: WorkflowTryResult) => void; reject: (error: Error) => void };

const mount = async (options: { blocked?: boolean; locale?: "en" | "de" } = {}) => {
  const dom = createDomTestHarness();
  dom.document.documentElement.lang = options.locale ?? "de";
  const pending: Deferred[] = [];
  const signals: AbortSignal[] = [];
  const [token, setToken] = createSignal(0);
  const [blocked, setBlocked] = createSignal(options.blocked ?? false);
  const { default: MailWorkflowDryRun } = await import("./MailWorkflowDryRun");
  const dispose = render(
    () =>
      createComponent(MailWorkflowDryRun, {
        mailboxName: "Vertrieb",
        get startToken() {
          return token();
        },
        get blocked() {
          return blocked();
        },
        now: () => NOW,
        run: (cursor, signal) => {
          signals.push(signal);
          return new Promise<WorkflowTryResult>((resolve, reject) => pending.push({ cursor, resolve, reject }));
        },
      }),
    dom.root,
  );
  const answerNext = async () => {
    const next = pending.shift();
    if (!next) throw new Error("No batch requested");
    next.resolve(dryRunFixtureBatch(next.cursor));
    await settle();
  };
  const text = () => dom.root.textContent ?? "";
  const counts = () => [...dom.root.querySelectorAll(".text-\\[1\\.75rem\\]")].map((node) => node.textContent);
  return { dom, pending, signals, setToken, setBlocked, answerNext, text, counts, dispose };
};

test.skipIf(isServer)("de: the dry run fills from the left, counts only grow and ends with the mockup totals", async () => {
  const view = await mount();
  try {
    expect(view.text()).toContain("Zeigt an den letzten Mails, was die Regel tun würde.");
    expect(view.dom.root.querySelectorAll('[data-state="waiting"]')).toHaveLength(50);
    view.setToken(1);
    await settle();
    expect(view.dom.root.querySelector("[data-mail-workflow-dry-run]")?.getAttribute("data-mail-workflow-dry-run")).toBe("running");
    expect(view.pending[0]?.cursor).toBeNull();
    await view.answerNext();
    expect(view.text()).toContain("10 von 50 geprüft");
    expect(view.dom.root.querySelectorAll('[data-state="pending"]')).toHaveLength(40);
    const seen: number[][] = [];
    while (view.pending.length > 0) {
      seen.push(view.counts().map(Number));
      await view.answerNext();
    }
    expect(view.counts()).toEqual(["17", "6", "27"]);
    for (let index = 1; index < seen.length; index += 1) {
      for (let column = 0; column < 3; column += 1) expect(seen[index]![column]!).toBeGreaterThanOrEqual(seen[index - 1]![column]!);
    }
    expect(view.text()).toContain("Probelauf ohne KI · letzte 50 Mails");
    expect(view.text()).toContain("gerade eben");
    expect(view.text()).toContain("17 KI-Aufrufe wären nötig, nicht ausgeführt · 9 % des Tageslimits");
    expect(view.text()).toContain("5 Nachrichten · 642 Zeichen → Zusammenfassung fortschreiben");
    expect(view.text()).toContain("388 Zeichen → Zusammenfassung schreiben");
    expect(view.text()).toContain("Verteiler → übersprungen");
    expect(view.text()).toContain("118 Zeichen · 1 Nachricht");
    expect(view.text()).toContain("Der Probelauf ändert keine Mail, sendet nichts und ruft keine KI auf.");
    expect(view.dom.root.querySelectorAll('[data-state="pending"]')).toHaveLength(0);
    expect(view.dom.root.querySelector("[data-selected]")).not.toBeNull();
    expect(view.dom.root.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
      "Letzte 50 Mails: 17 treffen zu, 6 übersprungen, 27 nicht",
    );
  } finally {
    view.dispose();
    view.dom.cleanup();
  }
});

test.skipIf(isServer)("de: filters show one group and say so when it is empty", async () => {
  const view = await mount();
  try {
    view.setToken(1);
    await settle();
    while (view.pending.length > 0) await view.answerNext();
    const chip = (label: string) =>
      [...view.dom.root.querySelectorAll("button, [role=radio]")].find((node) => node.textContent?.trim() === label) as HTMLElement;
    chip("Übersprungen").click();
    await settle();
    expect(view.dom.root.querySelectorAll('li[data-outcome="skipped"]')).toHaveLength(6);
    expect(view.dom.root.querySelectorAll('li[data-outcome="match"]')).toHaveLength(0);
    chip("Alle").click();
    await settle();
    expect(view.dom.root.querySelectorAll("li[data-outcome]")).toHaveLength(dryRunFixtureItems.length);
  } finally {
    view.dispose();
    view.dom.cleanup();
  }
});

test.skipIf(isServer)("de: cancel stops asking, keeps what was checked and can start again", async () => {
  const view = await mount();
  try {
    view.setToken(1);
    await settle();
    await view.answerNext();
    await view.answerNext();
    const cancel = [...view.dom.root.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Abbrechen");
    cancel?.click();
    await settle();
    expect(view.signals.at(-1)?.aborted).toBe(true);
    expect(view.text()).toContain("Abgebrochen bei 20 von 50");
    expect(view.dom.root.querySelectorAll("li[data-outcome]")).toHaveLength(20);
    const restart = view.dom.root.querySelector('button[aria-label="Neu starten"]') as HTMLButtonElement;
    restart.click();
    await settle();
    expect(view.text()).toContain("0 von 50 geprüft");
  } finally {
    view.dispose();
    view.dom.cleanup();
  }
});

test.skipIf(isServer)("de: a failed batch says nothing changed and offers to try again", async () => {
  const view = await mount();
  try {
    view.setToken(1);
    await settle();
    await view.answerNext();
    view.pending.shift()?.reject(new Error("Das Postfach antwortet gerade nicht."));
    await settle();
    expect(view.dom.root.querySelector('[role="alert"]')?.textContent).toContain(
      "Der Probelauf ist abgebrochen: Das Postfach antwortet gerade nicht. Es wurde nichts geändert.",
    );
    expect(view.dom.root.querySelectorAll("li[data-outcome]")).toHaveLength(10);
    const retry = [...view.dom.root.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Erneut versuchen");
    retry?.click();
    await settle();
    expect(view.pending[0]?.cursor).toBeNull();
  } finally {
    view.dispose();
    view.dom.cleanup();
  }
});

test.skipIf(isServer)("de: an invalid rule waits and an invalidated rule cancels a running dry run", async () => {
  const view = await mount({ blocked: true });
  try {
    expect(view.text()).toContain("Der Probelauf wartet, bis die Regel gültig ist.");
    view.setToken(1);
    await settle();
    expect(view.pending).toHaveLength(0);
    view.setBlocked(false);
    view.setToken(2);
    await settle();
    expect(view.pending).toHaveLength(1);
    view.setBlocked(true);
    await settle();
    expect(view.signals[0]?.aborted).toBe(true);
  } finally {
    view.dispose();
    view.dom.cleanup();
  }
});

test.skipIf(isServer)("en: the same run reads in English", async () => {
  const view = await mount({ locale: "en" });
  try {
    view.setToken(1);
    await settle();
    while (view.pending.length > 0) await view.answerNext();
    expect(view.text()).toContain("Dry run without AI · last 50 mails");
    expect(view.text()).toContain("17 AI calls would be needed, none made · 9 % of the daily limit");
    expect(view.text()).toContain("5 messages · 642 characters → continue the summary");
    expect(view.text()).toContain("Mailing list → skipped");
  } finally {
    view.dispose();
    view.dom.cleanup();
  }
});
