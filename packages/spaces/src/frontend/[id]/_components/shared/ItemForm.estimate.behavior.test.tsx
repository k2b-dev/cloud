import { expect, test } from "bun:test";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import type { EstimateSuggestionResult, SpaceColumn, SpaceItem } from "@/contracts";
import { createDomTestHarness } from "../../../../../../ui/test/dom";
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

/** The estimate field's label row, so positions can be compared between states. */
const parts = (root: HTMLElement) => {
  const input = root.querySelector<HTMLInputElement>('input[inputmode="numeric"], input[inputmode="decimal"]')!;
  const field = input.closest(".k2b-ai-suggestion-field") as HTMLElement | null;
  return {
    input,
    field,
    status: field?.querySelector(".k2b-ai-suggestion") ?? null,
    group: root.querySelector(".k2b-ai-suggestion-group__bar"),
    title: root.querySelector(".k2b-ai-suggestion-group__title")?.textContent ?? "",
    note: root.querySelector(".spaces-item-form__open-suggestion"),
    accept: () =>
      [...(field?.querySelectorAll<HTMLButtonElement>(".k2b-ai-suggestion__action") ?? [])].find((button) =>
        button.textContent?.includes("Übernehmen"),
      ),
    retry: () =>
      [...(field?.querySelectorAll<HTMLButtonElement>(".k2b-ai-suggestion__action") ?? [])].find((button) =>
        button.textContent?.includes("Erneut"),
      ),
  };
};

const until = async (condition: () => boolean, what: string, root: HTMLElement) => {
  const deadline = performance.now() + 2_000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(`${what} did not happen: ${root.innerHTML}`);
    await Bun.sleep(5);
  }
};

const mount = async (options: {
  /** `null` opens the form to create a task. */
  item?: Partial<SpaceItem> | null;
  load?: (signal: AbortSignal) => Promise<EstimateSuggestionResult>;
}) => {
  const dom = createDomTestHarness();
  const submitted: ItemFormData[] = [];
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
    dom.root.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await until(() => submitted.length > 0, "Saving", dom.root);
    return submitted.at(-1)!;
  };
  return { dom, submit, cleanup: () => (dispose(), dom.cleanup()) };
};

if (isServer) test.skip("the estimate suggestion uses browser conditions", () => {});
else {
  test("an open suggestion stands in the empty field and is never saved; Accept takes it and says where it came from", async () => {
    let answer: (result: EstimateSuggestionResult) => void = () => {};
    const { dom, submit, cleanup } = await mount({ load: () => new Promise((resolve) => (answer = resolve)) });
    try {
      const loading = parts(dom.root);
      expect(loading.title).toBe("Gustav schätzt die Dauer …");
      expect(loading.field?.className).toContain("k2b-ai-suggestion-loading");
      const before = { group: loading.group!.getBoundingClientRect(), input: loading.input.getBoundingClientRect() };

      answer(ready(90));
      await until(() => parts(dom.root).input.placeholder === "90", "The suggestion", dom.root);
      const open = parts(dom.root);
      expect(open.input.value).toBe("");
      expect(open.title).toBe("Gustav hat die Dauer aus dieser Aufgabe geschätzt");
      expect(open.note?.textContent).toBe("Der Vorschlag ist noch offen und wird nicht gespeichert.");
      expect(open.accept()?.getAttribute("aria-label")).toBe("Vorschlag für Geschätzte Dauer übernehmen");
      // An open suggestion is not the value: saving keeps the estimate empty.
      expect((await submit()).estimatedDurationMinutes).toBeNull();

      open.accept()!.click();
      await until(() => parts(dom.root).input.value === "90", "Accepting", dom.root);
      const accepted = parts(dom.root);
      expect(accepted.status?.textContent).toContain("von Gustav");
      expect(accepted.note?.textContent).toBe("");
      expect(dom.document.activeElement).toBe(accepted.input);
      expect((await submit()).estimatedDurationMinutes).toBe(90);
      // Arriving and accepting move nothing.
      expect(accepted.group!.getBoundingClientRect().top).toBe(before.group.top);
      expect(accepted.input.getBoundingClientRect().top).toBe(before.input.top);
    } finally {
      cleanup();
    }
  });

  test("Accept all takes a certain estimate; an unsure one stays open with its reason", async () => {
    const certain = await mount({ load: async () => ready(45) });
    try {
      await until(() => parts(certain.dom.root).input.placeholder === "45", "The suggestion", certain.dom.root);
      certain.dom.root.querySelector<HTMLButtonElement>(".k2b-ai-suggestion-group__accept")!.click();
      await until(() => parts(certain.dom.root).input.value === "45", "Accept all", certain.dom.root);
    } finally {
      certain.cleanup();
    }

    const unsure = await mount({ load: async () => ready(240, "low", "Wie viele Räume es sind, steht nicht in der Aufgabe.") });
    try {
      await until(() => parts(unsure.dom.root).input.placeholder === "240", "The suggestion", unsure.dom.root);
      const open = parts(unsure.dom.root);
      expect(open.field?.className).toContain("k2b-ai-suggestion-unsure");
      expect(open.status?.textContent).toContain("unsicher");
      expect(open.input.getAttribute("aria-describedby")).toBeTruthy();
      const described = open.input
        .getAttribute("aria-describedby")!
        .split(" ")
        .map((id) => unsure.dom.document.getElementById(id)?.textContent ?? "")
        .join(" ");
      expect(described).toContain("Wie viele Räume es sind, steht nicht in der Aufgabe.");
      const acceptAll = unsure.dom.root.querySelector<HTMLButtonElement>(".k2b-ai-suggestion-group__accept")!;
      expect(acceptAll.getAttribute("aria-disabled")).toBe("true");
      acceptAll.click();
      expect(parts(unsure.dom.root).input.value).toBe("");
      expect(open.accept()).toBeDefined();
    } finally {
      unsure.cleanup();
    }
  });

  test("an own estimate stays; the suggestion only sits beside the label", async () => {
    const { dom, submit, cleanup } = await mount({ item: { estimatedDurationMinutes: 30 }, load: async () => ready(60) });
    try {
      await until(() => Boolean(parts(dom.root).status?.textContent?.includes("Gustav: 60")), "The suggestion", dom.root);
      const own = parts(dom.root);
      expect(own.input.value).toBe("30");
      expect(own.note?.textContent).toBe("");
      expect((await submit()).estimatedDurationMinutes).toBe(30);
      own.accept()!.click();
      await until(() => parts(dom.root).input.value === "60", "Accepting", dom.root);
      // An estimate on the quarter-hour grid is saved as it is.
      expect((await submit()).estimatedDurationMinutes).toBe(60);
    } finally {
      cleanup();
    }
  });

  test("a failure says so and retries; a used-up allowance and too little text explain themselves without a button", async () => {
    let calls = 0;
    const failing = await mount({
      load: async () => (++calls === 1 ? { state: "failed", reason: "error" } : ready(120)),
    });
    try {
      await until(() => parts(failing.dom.root).title === "Gustav konnte die Dauer nicht schätzen", "The failure", failing.dom.root);
      expect(parts(failing.dom.root).status?.textContent).toContain("kein Vorschlag");
      parts(failing.dom.root).retry()!.click();
      await until(() => parts(failing.dom.root).input.placeholder === "120", "Retrying", failing.dom.root);
      expect(calls).toBe(2);
    } finally {
      failing.cleanup();
    }

    const thrown = await mount({
      load: async () => {
        throw new Error("offline");
      },
    });
    try {
      await until(() => parts(thrown.dom.root).title === "Gustav konnte die Dauer nicht schätzen", "The failure", thrown.dom.root);
    } finally {
      thrown.cleanup();
    }

    const allowance = await mount({ load: async () => ({ state: "failed", reason: "allowance" }) });
    try {
      await until(
        () => parts(allowance.dom.root).title === "Dein Gustav-Kontingent ist aufgebraucht, darum gibt es keine Schätzung",
        "The allowance note",
        allowance.dom.root,
      );
      expect(parts(allowance.dom.root).retry()).toBeUndefined();
    } finally {
      allowance.cleanup();
    }

    const none = await mount({ load: async () => ({ state: "none" }) });
    try {
      await until(() => parts(none.dom.root).title === "Gustav hat zu wenig, um diese Aufgabe zu schätzen", "No estimate", none.dom.root);
      const empty = parts(none.dom.root);
      expect(empty.input.placeholder).not.toBe("");
      expect(empty.accept()).toBeUndefined();
      // The status line stays reserved, so nothing moves.
      expect(empty.field).not.toBeNull();
    } finally {
      none.cleanup();
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
      const { dom, cleanup } = await mount(options);
      try {
        expect(dom.root.querySelector(".k2b-ai-suggestion-group")).toBeNull();
        expect(dom.root.querySelector(".k2b-ai-suggestion")).toBeNull();
        expect(dom.root.querySelector(".spaces-item-form__open-suggestion")).toBeNull();
      } finally {
        cleanup();
      }
    }
    expect(calls).toBe(0);
  });
}
