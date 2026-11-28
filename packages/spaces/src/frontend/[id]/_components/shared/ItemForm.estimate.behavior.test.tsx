import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import type { EstimateSuggestionResult, SpaceColumn, SpaceItem } from "@/contracts";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
import { installV2Globals, sendDialog } from "../../../../../test/v2-dom";
import type { ItemFormData } from "./item-form/types";

const columns: SpaceColumn[] = [{ id: "Col001", spaceId: "Space1", name: "Ideas", color: "#2563eb", rank: "1024", isDone: false }];
const task: SpaceItem = {
  id: "Item01",
  spaceId: "Space1",
  columnId: "Col001",
  title: "Prepare the workshop room",
  description: "Chairs, projector, coffee.",
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  deadlineAllDay: false,
  estimatedDurationMinutes: null,
  activeBlockerCount: 0,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: "1024",
  completedAt: null,
  createdBy: "11111111-1111-4111-8111-111111111111",
  createdAt: "2026-10-01T08:00:00Z",
  updatedAt: "2026-10-01T08:00:00Z",
};
const ready = (minutes: number, confidence: "high" | "low" = "high", reason: string | null = null): EstimateSuggestionResult => ({
  state: "ready",
  suggestion: { id: `estimate:${minutes}`, minutes, confidence, reason },
});

/** The estimate field and Gustav's line under it. */
const parts = (root: Document) => {
  const input = root.querySelector<HTMLInputElement>('input[name="estimate"]')!;
  const notice = root.querySelector<HTMLElement>('[data-k2-part="Notice"][data-tone="ai"]');
  const action = (words: string) =>
    [...(notice?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) => button.textContent?.includes(words));
  return {
    input,
    notice,
    line: notice?.textContent ?? "",
    accept: () => action("Übernehmen"),
    retry: () => action("Erneut"),
  };
};

const until = async (condition: () => boolean, what: string, root: Document) => {
  const deadline = performance.now() + 2_000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(`${what} did not happen: ${root.body.innerHTML}`);
    await Bun.sleep(5);
  }
};

const mount = async (options: {
  /** `null` opens the form to create a task. */
  item?: Partial<SpaceItem> | null;
  load?: (signal: AbortSignal) => Promise<EstimateSuggestionResult>;
}) => {
  const dom = createDomTestHarness();
  installV2Globals(dom);
  const submitted: ItemFormData[] = [];
  const { LocaleProvider } = await import("@k2b/ui");
  const { default: ItemForm } = await import("./ItemForm");
  const dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(ItemForm, {
            spaceId: "Space1",
            item: options.item === null ? undefined : { ...task, ...options.item },
            columns,
            tags: [],
            onSubmit: (data) => void submitted.push(data),
            onCancel: () => undefined,
            loadEstimateSuggestion: options.load,
          });
        },
      }),
    dom.root,
  );
  delegateEvents(["click", "input", "keydown", "focusout"]);
  const submit = async () => {
    const before = submitted.length;
    sendDialog(dom);
    await until(() => submitted.length > before, "Saving", dom.document);
    return submitted.at(-1)!;
  };
  const cleanup = async () => {
    dispose();
    // A closing v2 dialog finishes its focus work a moment later, while the window still exists.
    await Bun.sleep(20);
    dom.cleanup();
  };
  return { dom, submit, cleanup, document: dom.document };
};

if (isServer) test.skip("the estimate suggestion uses browser conditions", () => {});
else {
  test("an open suggestion stands in the empty field and is never saved; Accept takes it and says where it came from", async () => {
    let answer: (result: EstimateSuggestionResult) => void = () => {};
    const { document, submit, cleanup } = await mount({ load: () => new Promise((resolve) => (answer = resolve)) });
    try {
      const loading = parts(document);
      expect(loading.line).toBe("Gustav schätzt …");

      answer(ready(90));
      await until(() => parts(document).input.placeholder === "90", "The suggestion", document);
      const open = parts(document);
      expect(open.input.value).toBe("");
      expect(open.line).toContain("Gustav hat geschätzt: 90 min. Der Vorschlag wird nicht gespeichert.");
      // An open suggestion is not the value: saving keeps the estimate empty.
      expect((await submit()).estimatedDurationMinutes).toBeNull();

      open.accept()!.click();
      await until(() => parts(document).input.value === "90", "Accepting", document);
      const accepted = parts(document);
      expect(accepted.line).toBe("90 min von Gustav übernommen");
      expect(accepted.accept()).toBeUndefined();
      expect(document.activeElement).toBe(accepted.input);
      expect((await submit()).estimatedDurationMinutes).toBe(90);
      // Arriving and accepting keep the same line, so nothing moves.
      expect(accepted.notice).toBe(loading.notice);
    } finally {
      await cleanup();
    }
  });

  test("one field offers only its own Accept; an unsure estimate stays open with its reason", async () => {
    const unsure = await mount({ load: async () => ready(240, "low", "Wie viele Räume es sind, steht nicht in der Aufgabe.") });
    try {
      await until(() => parts(unsure.document).input.placeholder === "240", "The suggestion", unsure.document);
      const open = parts(unsure.document);
      const accepts = [...unsure.document.querySelectorAll("button")].filter((button) => button.textContent?.includes("Übernehmen"));
      expect(accepts).toHaveLength(1);
      expect(open.line).toContain("Gustav ist unsicher: 240 min");
      const described = open.input
        .getAttribute("aria-describedby")!
        .split(" ")
        .map((id) => unsure.document.getElementById(id)?.textContent ?? "")
        .join(" ");
      expect(described).toContain("Wie viele Räume es sind, steht nicht in der Aufgabe.");
      open.accept()!.click();
      await until(() => parts(unsure.document).input.value === "240", "Accepting the unsure value", unsure.document);
    } finally {
      await unsure.cleanup();
    }
  });

  test("an own estimate stays; the suggestion only stands beside it", async () => {
    const { document, submit, cleanup } = await mount({ item: { estimatedDurationMinutes: 30 }, load: async () => ready(60) });
    try {
      await until(() => parts(document).line.includes("Gustav hat geschätzt: 60 min"), "The suggestion", document);
      const own = parts(document);
      expect(own.input.value).toBe("30");
      expect(own.line).not.toContain("nicht gespeichert");
      expect((await submit()).estimatedDurationMinutes).toBe(30);
      own.accept()!.click();
      await until(() => parts(document).input.value === "60", "Accepting", document);
      // An estimate on the quarter-hour grid is saved as it is.
      expect((await submit()).estimatedDurationMinutes).toBe(60);
    } finally {
      await cleanup();
    }
  });

  test("a failure says so and retries; a used-up allowance and too little text explain themselves without a button", async () => {
    let calls = 0;
    const failing = await mount({
      load: async () => (++calls === 1 ? { state: "failed", reason: "error" } : ready(120)),
    });
    try {
      await until(() => parts(failing.document).line.startsWith("Schätzung fehlgeschlagen"), "The failure", failing.document);
      parts(failing.document).retry()!.click();
      await until(() => parts(failing.document).input.placeholder === "120", "Retrying", failing.document);
      expect(calls).toBe(2);
    } finally {
      await failing.cleanup();
    }

    const thrown = await mount({
      load: async () => {
        throw new Error("offline");
      },
    });
    try {
      await until(() => parts(thrown.document).line.startsWith("Schätzung fehlgeschlagen"), "The failure", thrown.document);
    } finally {
      await thrown.cleanup();
    }

    const allowance = await mount({ load: async () => ({ state: "failed", reason: "allowance" }) });
    try {
      await until(() => parts(allowance.document).line === "Gustav-Kontingent aufgebraucht", "The allowance note", allowance.document);
      expect(parts(allowance.document).retry()).toBeUndefined();
    } finally {
      await allowance.cleanup();
    }

    const none = await mount({ load: async () => ({ state: "none" }) });
    try {
      await until(() => parts(none.document).line === "Zu wenig zum Schätzen", "No estimate", none.document);
      const empty = parts(none.document);
      expect(empty.input.placeholder).toBe("");
      expect(empty.accept()).toBeUndefined();
    } finally {
      await none.cleanup();
    }
  });

  test("without the assistant, for events, and when creating, the form renders as before and asks nothing", async () => {
    let calls = 0;
    const load = async () => (calls++, ready(30));
    for (const options of [
      {},
      { item: { startsAt: "2026-10-08T09:00:00Z", endsAt: "2026-10-08T10:00:00Z" }, load },
      { item: null, load },
    ] satisfies Parameters<typeof mount>[0][]) {
      const { document, cleanup } = await mount(options);
      try {
        expect(document.querySelector('[data-k2-part="Notice"][data-tone="ai"]')).toBeNull();
      } finally {
        await cleanup();
      }
    }
    expect(calls).toBe(0);
  });
}
