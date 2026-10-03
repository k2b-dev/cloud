import { afterEach, describe, expect, test } from "bun:test";
import { createComponent, createSignal, onCleanup } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

const settle = async () => {
  await Promise.resolve();
  await Bun.sleep(10);
};

describe("@k2b/ui feedback runtime", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  afterEach(async () => {
    const { dialogCore } = await import("../src/feedback/dialog-core");
    const { toast } = await import("../src/feedback/toast");
    dialogCore.close();
    toast.dismissAll();
    await Bun.sleep(220);
  });

  test("focuses and names the active dialog level, then restores its opener", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const outerOpener = dom.document.createElement("button");
    outerOpener.textContent = "Open dialog";
    dom.root.append(outerOpener);
    outerOpener.focus();

    const { createDialogCore } = await import("../src/feedback/dialog-core");
    const core = createDialogCore();
    let closeFirst: (value?: string) => void = () => {};
    let closeSecond: (value?: string) => void = () => {};

    const firstResult = core.open<string>((close) => {
      closeFirst = close;
      const section = document.createElement("section");
      const heading = document.createElement("h2");
      const input = document.createElement("input");
      const button = document.createElement("button");
      heading.textContent = "First level";
      input.id = "first-input";
      button.id = "nested-opener";
      button.type = "button";
      button.textContent = "Open nested";
      section.append(heading, input, button);
      return section;
    });
    await settle();

    const dialog = dom.document.querySelector<HTMLDialogElement>("dialog");
    const firstInput = dom.document.querySelector<HTMLInputElement>("#first-input");
    const nestedOpener = dom.document.querySelector<HTMLButtonElement>("#nested-opener");
    expect(dom.document.activeElement).toBe(firstInput);
    expect(dialog?.getAttribute("aria-labelledby")).toBe(dom.document.querySelector("h2")?.id);

    nestedOpener?.focus();
    const secondResult = core.open<string>((close) => {
      closeSecond = close;
      const section = document.createElement("section");
      const heading = document.createElement("h2");
      const input = document.createElement("input");
      heading.textContent = "Second level";
      input.id = "second-input";
      section.append(heading, input);
      return section;
    });
    await settle();

    const secondInput = dom.document.querySelector<HTMLInputElement>("#second-input");
    expect(dom.document.activeElement).toBe(secondInput);
    expect(dialog?.getAttribute("aria-labelledby")).toBe(dom.document.querySelectorAll("h2")[1]?.id);

    closeSecond("nested");
    expect(await secondResult).toBe("nested");
    await settle();
    expect(dom.document.activeElement).toBe(nestedOpener);
    expect(dialog?.getAttribute("aria-labelledby")).toBe(dom.document.querySelector("h2")?.id);

    closeFirst("done");
    expect(await firstResult).toBe("done");
    await settle();
    expect(dom.document.activeElement).toBe(outerOpener);
    expect(core.isOpen()).toBe(false);
    expect(dom.document.querySelector("dialog")).toBeNull();

    dom.cleanup();
  });

  test("resolves and disposes open dialogs when their island disconnects", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    dom.document.body.style.overflow = "clip";
    dom.document.documentElement.style.overflow = "auto";
    const { createDialogCore } = await import("../src/feedback/dialog-core");
    const core = createDialogCore();
    let cleanupCalls = 0;

    const result = core.open<string>(() => {
      onCleanup(() => {
        cleanupCalls += 1;
      });
      const input = document.createElement("input");
      input.setAttribute("aria-label", "Temporary dialog");
      return input;
    });
    await settle();
    expect(dom.document.body.style.overflow).toBe("hidden");
    expect(dom.document.documentElement.style.overflow).toBe("hidden");

    // A collection between observe() and the removal used to drop the mutation:
    // happy-dom < 20.11.2 held the observer callback only through a WeakRef, so
    // this test timed out whenever CI happened to run the GC here. Force it so
    // a regression fails deterministically instead of once a week.
    Bun.gc(true);
    dom.root.remove();
    // The disconnect observer delivers through a microtask, so the open promise
    // is the disposal signal itself. Waiting on happy-dom's whole task queue
    // instead ties the test to unrelated window tasks and hung in CI (#37).
    const resolved = await result;

    expect(resolved).toBeUndefined();
    expect(cleanupCalls).toBe(1);
    expect(core.isOpen()).toBe(false);
    expect(dom.document.body.style.overflow).toBe("clip");
    expect(dom.document.documentElement.style.overflow).toBe("auto");

    dom.cleanup();
  });

  test("forwards ignore cancellation and accessible names from every public opener", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { dialogCore } = await import("../src/feedback/dialog-core");
    const { prompts } = await import("../src/feedback/prompts");

    const openers: Array<{
      name: string;
      open: () => Promise<unknown>;
    }> = [
      { name: "Info", open: () => prompts.alert("Message", { cancelBehavior: "ignore" }) },
      { name: "Confirmation", open: () => prompts.confirm("Continue?", { cancelBehavior: "ignore" }) },
      {
        name: "Form",
        open: () =>
          prompts.form({
            cancelBehavior: "ignore",
            fields: { name: { type: "text" } },
          }),
      },
      {
        name: "Dialog",
        open: () =>
          prompts.dialog(
            () => {
              const button = document.createElement("button");
              button.type = "button";
              button.textContent = "Custom";
              return button;
            },
            { cancelBehavior: "ignore" },
          ),
      },
      { name: "Error", open: () => prompts.error("Failed", { cancelBehavior: "ignore" }) },
      { name: "Search...", open: () => prompts.search(async () => [], { cancelBehavior: "ignore" }) },
    ];

    for (const entry of openers) {
      const result = entry.open();
      await settle();
      const dialog = dom.document.querySelector<HTMLDialogElement>("dialog");
      expect(dialog?.getAttribute("aria-label"), entry.name).toBe(entry.name);
      expect(dialog?.classList.contains("k2b-dialog--primary"), entry.name).toBe(false);
      if (entry.name === "Error") expect(dialog?.classList.contains("k2b-dialog--danger")).toBe(true);

      dialog?.dispatchEvent(new Event("cancel", { cancelable: true }));
      expect(dialogCore.isOpen(), entry.name).toBe(true);

      dialogCore.close();
      await result;
      await settle();
      expect(dialogCore.isOpen(), entry.name).toBe(false);
    }

    dom.cleanup();
  });

  test("requires an exact confirmation phrase before submitting", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { prompts } = await import("../src/feedback/prompts");

    const result = prompts.confirm("Delete Project Atlas and all stored data?", {
      title: "Delete project",
      confirmText: "Delete project",
      confirmationPhrase: "Project Atlas",
      variant: "danger",
    });
    await settle();

    const input = dom.document.querySelector<HTMLInputElement>(".k2b-dialog__body input");
    const submit = dom.document.querySelector<HTMLButtonElement>(".k2b-dialog__actions button[type='submit']");
    const form = dom.document.querySelector<HTMLFormElement>(".k2b-dialog__panel");
    expect(dom.document.activeElement).toBe(input);
    expect(input?.labels?.[0]?.textContent).toContain("Type Project Atlas to confirm");
    expect(input?.closest(".k2b-text-input")?.getAttribute("data-monospace")).toBe("true");
    expect(input?.autocomplete).toBe("off");
    expect(input?.getAttribute("spellcheck")).toBe("false");
    expect(submit?.disabled).toBe(true);

    if (!input || !form) throw new Error("Expected confirmation phrase controls");
    input.value = "project atlas";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
    expect(submit?.disabled).toBe(true);

    input.value = "Project Atlas ";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
    expect(submit?.disabled).toBe(true);

    input.value = "Project Atlas";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
    expect(submit?.disabled).toBe(false);

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(await result).toBe(true);
    dom.cleanup();
  });

  test("labels the confirmation phrase in the document locale and keeps the phrase verbatim", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { dialogCore } = await import("../src/feedback/dialog-core");
    const { prompts } = await import("../src/feedback/prompts");
    const label = () => dom.document.querySelector<HTMLInputElement>(".k2b-dialog__body input")?.labels?.[0];

    for (const [lang, text] of [
      ["en", "Type Sommerfest 2026 to confirm"],
      ["de", "Gib Sommerfest 2026 zur Bestätigung ein"],
    ] as const) {
      dom.document.documentElement.setAttribute("lang", lang);
      const result = prompts.confirm("Delete this venue?", { confirmationPhrase: "Sommerfest 2026", variant: "danger" });
      await settle();
      expect(label()?.textContent, lang).toContain(text);
      expect(label()?.querySelector("code.k2b-confirmation-phrase")?.textContent, lang).toBe("Sommerfest 2026");
      dialogCore.close();
      await result;
      await settle();
    }

    dom.document.documentElement.removeAttribute("lang");
    dom.cleanup();
  });

  test("preserves plain confirmation results", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { prompts } = await import("../src/feedback/prompts");

    const plainResult = prompts.confirm("Continue?");
    await settle();
    expect(dom.document.querySelector(".k2b-dialog__body input")).toBeNull();
    const plainConfirm = dom.document.querySelector<HTMLButtonElement>(".k2b-dialog__actions button[data-variant='primary']");
    expect(plainConfirm?.type).toBe("button");
    expect(plainConfirm?.disabled).toBe(false);
    const confirmClick = (plainConfirm as (HTMLButtonElement & { $$click?: () => void }) | null)?.$$click;
    expect(confirmClick).toBeFunction();
    confirmClick?.();
    expect(await plainResult).toBe(true);
    dom.cleanup();
  });

  test("cancels a typed confirmation without requiring the phrase", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { prompts } = await import("../src/feedback/prompts");

    expect(() => prompts.confirm("Delete everything?", { confirmationPhrase: "  " })).toThrow(
      "confirmationPhrase must be non-empty, visible, and single-line",
    );
    expect(() => prompts.confirm("Delete everything?", { confirmationPhrase: "DELETE\nEVERYTHING" })).toThrow(
      "confirmationPhrase must be non-empty, visible, and single-line",
    );

    const typedResult = prompts.confirm("Delete everything?", { confirmationPhrase: "DELETE" });
    await settle();
    const cancel = dom.document.querySelector<HTMLButtonElement>(".k2b-dialog__actions button[type='button']");
    expect(cancel?.textContent).toContain("Cancel");
    const cancelClick = (cancel as (HTMLButtonElement & { $$click?: () => void }) | null)?.$$click;
    expect(cancelClick).toBeFunction();
    cancelClick?.();
    expect(await typedResult).toBe(false);
    dom.cleanup();
  });

  test("dismisses a pointer-opened tooltip with document Escape", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { Tooltip } = await import("../src/feedback/Tooltip");
    const [disabled, setDisabled] = createSignal(false);

    const dispose = render(
      () =>
        createComponent(Tooltip.Anchor, {
          content: "Helpful context",
          delay: 0,
          get disabled() {
            return disabled();
          },
          children: (() => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = "Hover me";
            return button;
          })(),
        }),
      dom.root,
    );
    const wrapper = dom.root.querySelector<HTMLElement>(".k2b-tooltip-wrapper");
    const surface = dom.root.querySelector<HTMLElement>(".k2b-tooltip");
    const matches = surface?.matches.bind(surface);
    if (surface && matches) {
      // `matches` declares type-predicate overloads; the stub only answers the runtime string form.
      Object.defineProperty(surface, "matches", {
        configurable: true,
        writable: true,
        value: (selector: string) => (selector === ":popover-open" ? surface.dataset.testPopoverOpen === "true" : matches(selector)),
      });
      surface.showPopover = () => {
        surface.dataset.testPopoverOpen = "true";
      };
      surface.hidePopover = () => {
        delete surface.dataset.testPopoverOpen;
      };
    }

    wrapper?.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    // delay=0 opens synchronously, before the next timer or microtask.
    expect(surface?.getAttribute("data-instant")).toBe("true");
    expect(surface?.matches(":popover-open")).toBe(true);
    await settle();
    expect(surface?.matches(":popover-open")).toBe(true);

    setDisabled(true);
    await Promise.resolve();
    expect(surface?.matches(":popover-open")).toBe(false);

    setDisabled(false);
    wrapper?.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    // delay=0 opens synchronously, before the next timer or microtask.
    expect(surface?.matches(":popover-open")).toBe(true);
    await settle();
    expect(surface?.matches(":popover-open")).toBe(true);

    dom.document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(surface?.matches(":popover-open")).toBe(false);
    wrapper?.dispatchEvent(new Event("pointerleave"));
    wrapper?.querySelector("button")?.focus();
    expect(surface?.matches(":popover-open")).toBe(true);
    wrapper?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(surface?.matches(":popover-open")).toBe(false);

    dispose();
    dom.cleanup();
  });

  test("renders, updates, caps, and dismisses real toast DOM", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { K2B_TOAST_CONTAINER_ID, toast } = await import("../src/feedback/toast");

    const handle = toast.success("Saved", { duration: 0 });
    const rail = dom.document.getElementById(K2B_TOAST_CONTAINER_ID);
    const card = rail?.querySelector<HTMLElement>("[data-k2b-toast]");
    expect(rail?.className).toBe("");
    expect(rail?.getAttribute("role")).toBe("region");
    expect(rail?.getAttribute("aria-label")).toBe("Notifications");
    expect(card?.dataset.tone).toBe("success");
    expect(card?.textContent).toContain("Saved");
    expect(card?.querySelector(".k2b-toast__icon i")?.className).toBe("ti ti-circle-check");
    // The card is not a live region of its own; the rail's persistent regions announce it.
    expect(card?.querySelector("[role], [aria-live]")).toBeNull();

    handle.update("Publish failed", {
      variant: "error",
      title: "Could not publish",
      duration: 0,
      iconClass: "ti ti-alert-triangle",
      action: { label: "Retry", href: "/retry" },
    });
    expect(card?.dataset.tone).toBe("danger");
    expect(card?.querySelector(".k2b-toast__icon i")?.className).toBe("ti ti-alert-triangle");
    expect(card?.textContent).toContain("Could not publish");
    expect(card?.querySelector<HTMLAnchorElement>(".k2b-toast__action")?.href).toBe("http://localhost/retry");

    // Three stay visible on a wide screen. Older confirmations leave first, the error stays.
    for (let index = 0; index < 4; index += 1) toast(`Notice ${index}`, { duration: 10_000 });
    const open = () =>
      Array.from(rail?.querySelectorAll<HTMLElement>("[data-k2b-toast]:not([data-closing])") ?? [], (item) => item.textContent);
    expect(open().map((text) => text?.replace("Retry", ""))).toEqual(["Could not publishPublish failed", "Notice 2", "Notice 3"]);

    toast.dismissAll();
    await Bun.sleep(220);
    expect(rail?.childElementCount).toBe(0);

    dom.cleanup();
  });

  test("places custom content in the toast rail beside toasts until its owner dismisses it", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { K2B_TOAST_CONTAINER_ID, toast } = await import("../src/feedback/toast");

    toast("Before", { duration: 0 });
    const content = dom.document.createElement("section");
    content.textContent = "Uploads";
    const slot = toast.custom(content);
    toast("After", { duration: 0 });
    const rail = dom.document.getElementById(K2B_TOAST_CONTAINER_ID);
    const cards = [...(rail?.querySelectorAll<HTMLElement>("[data-k2b-toast]") ?? [])];
    expect(cards.map((card) => card.textContent?.includes("Uploads") ?? false)).toEqual([false, true, false]);
    const custom = cards[1]!;
    expect(custom.className).toBe("k2b-toast");
    expect(custom.dataset.custom).toBe("true");
    expect(custom.firstElementChild).toBe(content);
    expect(custom.querySelector(".k2b-toast__close")).toBeNull();
    await settle();
    expect(custom.dataset.open).toBe("true");

    // Neither the five-toast cap nor dismissAll removes it; clicking it does not either.
    for (let index = 0; index < 6; index += 1) toast(`Notice ${index}`, { duration: 0 });
    custom.click();
    toast.dismissAll();
    await Bun.sleep(220);
    expect(rail?.childElementCount).toBe(1);
    expect(custom.isConnected).toBe(true);

    slot.dismiss();
    expect(custom.dataset.closing).toBe("true");
    await Bun.sleep(220);
    expect(custom.isConnected).toBe(false);
    expect(rail?.childElementCount).toBe(0);
    dom.cleanup();
  });

  test("exposes search as an active-descendant combobox and normalizes form cancellation", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { dialogCore } = await import("../src/feedback/dialog-core");
    const { prompts } = await import("../src/feedback/prompts");

    const searchResult = prompts.search(
      async () => [
        { label: "Ada", value: "ada" },
        { label: "Grace", desc: "grace@example.com", value: "grace" },
      ],
      {
        ariaLabel: "Find a person",
        debounceMs: 0,
      },
    );
    await settle();

    const input = dom.document.querySelector<HTMLInputElement>("[role='combobox']");
    const option = dom.document.querySelector<HTMLElement>("[role='option']");
    expect(input?.getAttribute("aria-label")).toBe("Find a person");
    expect(input?.getAttribute("aria-controls")).toBe(option?.parentElement?.id);
    expect(input?.getAttribute("aria-activedescendant")).toBe(option?.id);
    expect(option?.getAttribute("aria-selected")).toBe("true");
    expect(option?.hasAttribute("data-has-description")).toBeFalse();
    expect(dom.document.querySelectorAll("[role='option']")[1]?.getAttribute("data-has-description")).toBe("true");

    dialogCore.close();
    expect(await searchResult).toBeUndefined();
    await settle();

    const formResult = prompts.form({ fields: { name: { type: "text" } } });
    await settle();
    dialogCore.close();
    expect(await formResult).toBeNull();

    dom.cleanup();
  });

  test("keeps a prompt date picker reactive after selecting a day", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { dialogCore } = await import("../src/feedback/dialog-core");
    const { prompts } = await import("../src/feedback/prompts");

    const formResult = prompts.form({
      fields: {
        releaseDate: { type: "datetime", dateOnly: true, default: "2026-08-03" },
      },
    });
    await settle();

    dom.document.querySelector<HTMLButtonElement>(".k2b-date-trigger")?.click();
    await settle();
    const nextDay = Array.from(dom.document.querySelectorAll<HTMLButtonElement>("[data-date-day]")).find(
      (day) => day.dataset.dateDay !== "2026-08-03" && day.dataset.outside !== "true",
    );
    expect(nextDay).toBeDefined();
    nextDay?.click();
    await settle();

    expect(nextDay?.getAttribute("aria-selected")).toBe("true");

    dialogCore.close();
    expect(await formResult).toBeNull();
    dom.cleanup();
  });

  test("form validation errors follow the document locale", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    dom.document.documentElement.setAttribute("lang", "de");
    const { dialogCore } = await import("../src/feedback/dialog-core");
    const { prompts } = await import("../src/feedback/prompts");

    const formResult = prompts.form({
      fields: {
        name: { type: "text", label: "Name", required: true },
        code: { type: "text", label: "Kürzel", minLength: 3, default: "ab" },
        labels: { type: "tags", label: "Schlagworte", maxTags: 1, default: ["Bühne", "Technik"] },
      },
    });
    await settle();

    dom.document.querySelector(".k2b-dialog__panel")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    const errors = Array.from(dom.document.querySelectorAll(".k2b-dialog__body .k2b-field__error"), (error) => error.textContent);
    expect(errors).toEqual(["Erforderlich", "Mindestens 3 Zeichen", "Höchstens 1 Tag"]);

    dialogCore.close();
    expect(await formResult).toBeNull();
    dom.document.documentElement.removeAttribute("lang");
    dom.cleanup();
  });

  test("form errors wait for the first submit and then follow every change", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { dialogCore } = await import("../src/feedback/dialog-core");
    const { prompts } = await import("../src/feedback/prompts");

    const formResult = prompts.form({
      fields: {
        url: { type: "text", label: "URL", validate: (value) => (value && !value.startsWith("https://") ? "Enter a full URL" : null) },
      },
    });
    await settle();
    const input = dom.document.querySelector<HTMLInputElement>(".k2b-dialog__body input")!;
    const errors = () => Array.from(dom.document.querySelectorAll(".k2b-dialog__body .k2b-field__error"), (error) => error.textContent);
    const type = async (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settle();
    };

    // A URL still being typed does not interrupt the user.
    await type("h");
    expect(errors()).toEqual([]);

    dom.document.querySelector(".k2b-dialog__panel")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(errors()).toEqual(["Enter a full URL"]);

    await type("https://example.com");
    expect(errors()).toEqual([]);
    await type("example.com");
    expect(errors()).toEqual(["Enter a full URL"]);

    dialogCore.close();
    expect(await formResult).toBeNull();
    dom.cleanup();
  });

  test("a toast shows a title only when the caller passes one", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { toast } = await import("../src/feedback/toast");
    const titles = () =>
      Array.from(dom.document.querySelectorAll<HTMLElement>("[data-k2b-toast]:not([data-closing]) .k2b-toast__title"), (title) =>
        title.hidden ? null : title.textContent,
      );

    toast("Note", { duration: 0 });
    toast.success("Saved", { duration: 0 });
    const failure = toast.error("Failed", { duration: 0 });
    expect(titles()).toEqual([null, null, null]);

    failure.update("Back again", { variant: "success" });
    expect(titles().at(-1)).toBeNull();
    failure.update("Back again", { title: "Connection restored" });
    expect(titles().at(-1)).toBe("Connection restored");
    failure.update("Back again", { title: undefined });
    expect(titles().at(-1)).toBeNull();
    toast.dismissAll();
    dom.cleanup();
  });

  test("announces through two persistent live regions: the error word first, never the action", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { toast } = await import("../src/feedback/toast");
    dom.document.documentElement.setAttribute("lang", "de");
    toast.success("Kontakt erstellt", { action: { label: "Rückgängig", onClick: () => {} } });
    const regions = Array.from(dom.document.querySelectorAll<HTMLElement>("[data-k2b-toast-live] > *"));
    // Not atomic: each line is read on its own, not again with every later one.
    expect(
      regions.map((region) => [
        region.getAttribute("role"),
        region.getAttribute("aria-live"),
        region.getAttribute("aria-atomic"),
        region.textContent,
      ]),
    ).toEqual([
      ["status", "polite", "false", ""],
      ["alert", "assertive", "false", ""],
    ]);
    // Persistent: the regions are outside the rail, which moves into a new top-layer element for every toast.
    expect(regions[0]?.closest("[data-k2b-toast-container]")).toBeNull();
    toast.error("Speichern fehlgeschlagen", { title: "Projekt" });
    await Bun.sleep(150);
    expect(regions.map((region) => region.textContent)).toEqual(["Kontakt erstellt", "Fehler: Projekt. Speichern fehlgeschlagen"]);

    // Progress is announced at its start, half way and its end, not at every step.
    const job = toast("Import läuft", { progress: 0.1 });
    job.update("2 von 10", { progress: 0.2 });
    job.update("6 von 10", { progress: 0.6 });
    job.update("8 von 10", { progress: 0.8 });
    job.update("Import fertig", { progress: null, variant: "success" });
    await Bun.sleep(150);
    expect(Array.from(regions[0]!.children, (line) => line.textContent)).toEqual([
      "Kontakt erstellt",
      "Import läuft",
      "6 von 10",
      "Import fertig",
    ]);

    // Turning into an error with the same text is still announced, with the error word.
    const sync = toast("Kontakte werden abgeglichen", { progress: "indeterminate" });
    sync.update("Kontakte werden abgeglichen", { variant: "error", progress: null });
    await Bun.sleep(150);
    expect(regions[1]!.lastElementChild?.textContent).toBe("Fehler: Kontakte werden abgeglichen");
    dom.document.documentElement.removeAttribute("lang");
    dom.cleanup();
  });

  test("closes only through its close button or Escape, then hands focus on", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { toast } = await import("../src/feedback/toast");
    const opener = dom.document.createElement("button");
    dom.root.appendChild(opener);
    opener.focus();
    toast.error("Could not save", { duration: 0 });
    toast("Link copied", { duration: 0 });
    const [first, second] = Array.from(dom.document.querySelectorAll<HTMLElement>("[data-k2b-toast]"));

    // A click on the text keeps it, so an error message can be selected and copied.
    first!.querySelector<HTMLElement>(".k2b-toast__description")!.click();
    expect(first!.dataset.closing).toBeUndefined();

    first!.querySelector<HTMLButtonElement>(".k2b-toast__close")!.focus();
    first!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(first!.dataset.closing).toBe("true");
    expect(dom.document.activeElement).toBe(second!.querySelector(".k2b-toast__close"));

    second!.querySelector<HTMLButtonElement>(".k2b-toast__close")!.click();
    expect(second!.dataset.closing).toBe("true");
    expect(dom.document.activeElement).toBe(opener);
    await Bun.sleep(220);

    // Focus skips a neighbour that is still closing and goes to the next open toast.
    for (const name of ["One", "Two", "Three"]) toast(name, { duration: 0 });
    const [one, two, three] = Array.from(dom.document.querySelectorAll<HTMLElement>("[data-k2b-toast]"));
    two!.querySelector<HTMLButtonElement>(".k2b-toast__close")!.focus();
    two!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dom.document.activeElement).toBe(three!.querySelector(".k2b-toast__close"));
    three!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dom.document.activeElement).toBe(one!.querySelector(".k2b-toast__close"));
    await Bun.sleep(220);
    dom.cleanup();
  });

  test("pauses every toast while one is under the pointer or holds focus, so none slides away", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { toast } = await import("../src/feedback/toast");
    const open = () =>
      Array.from(
        dom.document.querySelectorAll<HTMLElement>("[data-k2b-toast]:not([data-closing])"),
        (card) => card.querySelector(".k2b-toast__description")?.textContent,
      );

    toast.error("Could not save the file", { duration: 400 });
    toast.success("Message archived", { duration: 100 });
    const [error] = Array.from(dom.document.querySelectorAll<HTMLElement>("[data-k2b-toast]"));
    error!.dispatchEvent(new dom.window.PointerEvent("pointerenter") as unknown as Event);
    await Bun.sleep(200);
    expect(open()).toEqual(["Could not save the file", "Message archived"]);
    error!.dispatchEvent(new dom.window.PointerEvent("pointerleave") as unknown as Event);
    await Bun.sleep(150);
    expect(open()).toEqual(["Could not save the file"]);
    toast.dismissAll();
    await Bun.sleep(220);

    toast.error("Could not save the file", { duration: 400, action: { label: "Try again", onClick: () => {} } });
    toast.success("Message archived", { duration: 100 });
    const retry = dom.document.querySelector<HTMLButtonElement>(".k2b-toast__action")!;
    retry.focus();
    await Bun.sleep(200);
    expect(open()).toEqual(["Could not save the file", "Message archived"]);
    retry.blur();
    await Bun.sleep(150);
    expect(open()).toEqual(["Could not save the file"]);
    dom.cleanup();
  });

  test("the rail limit keeps sticky toasts and the toast under the pointer or focus", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { toast } = await import("../src/feedback/toast");
    const open = () =>
      Array.from(
        dom.document.querySelectorAll<HTMLElement>("[data-k2b-toast]:not([data-closing])"),
        (card) => card.querySelector(".k2b-toast__description")?.textContent,
      );

    // A caller's sticky toast is the only sign that live updates stopped; timed confirmations leave before it.
    toast("Live updates stopped", { duration: 0, action: { label: "Reload", onClick: () => {} } });
    for (const name of ["Saved 1", "Saved 2", "Saved 3"]) toast.success(name, { duration: 10_000 });
    expect(open()).toEqual(["Live updates stopped", "Saved 2", "Saved 3"]);
    toast.dismissAll();
    await Bun.sleep(220);

    // The toast with focus on its Undo stays, and keeps the focus, even past the limit until the user leaves it.
    toast.success("Message moved to trash", { action: { label: "Undo", onClick: () => {} } });
    const undo = dom.document.querySelector<HTMLButtonElement>(".k2b-toast__action")!;
    undo.focus();
    for (const name of ["Upload 1", "Upload 2", "Upload 3"]) toast(name, { progress: 0 });
    expect(open()).toEqual(["Message moved to trash", "Upload 1", "Upload 2", "Upload 3"]);
    expect(dom.document.activeElement).toBe(undo);
    undo.blur();
    expect(open()).toEqual(["Upload 1", "Upload 2", "Upload 3"]);
    dom.cleanup();
  });

  test("a removed focused control or an unmounted rail no longer holds every toast", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { toast } = await import("../src/feedback/toast");
    const open = () =>
      Array.from(
        dom.document.querySelectorAll<HTMLElement>("[data-k2b-toast]:not([data-closing])"),
        (card) => card.querySelector(".k2b-toast__description")?.textContent,
      );
    // Firefox and WebKit fire no focusout when a focused element is removed; neither does this harness.
    const removeSilently = (element: Element) => {
      const swallow = (event: Event) => event.stopImmediatePropagation();
      dom.document.addEventListener("focusout", swallow, true);
      element.remove();
      dom.document.removeEventListener("focusout", swallow, true);
    };

    // Removing the focused action keeps the keyboard in the toast, on its close button.
    const exporting = toast("Exporting", { progress: 0.2, action: { label: "Cancel", onClick: () => {} } });
    dom.document.querySelector<HTMLButtonElement>(".k2b-toast__action")!.focus();
    exporting.update("Export cancelled", { progress: null, action: null, duration: 100 });
    expect(dom.document.activeElement?.className).toBe("k2b-toast__close");
    // Replacing the action keeps the keyboard on the action.
    exporting.update("Exporting again", { duration: 100, action: { label: "Cancel", onClick: () => {} } });
    dom.document.querySelector<HTMLButtonElement>(".k2b-toast__action")!.focus();
    exporting.update("Still exporting", { duration: 100, action: { label: "Cancel", onClick: () => {} } });
    expect(dom.document.activeElement?.className).toBe("k2b-toast__action");
    toast.dismissAll();
    await Bun.sleep(220);

    // A focused, hovered control that custom content removes without focusout or pointerleave releases the rail.
    const retry = dom.document.createElement("button");
    retry.textContent = "Retry";
    const panel = dom.document.createElement("div");
    panel.append(retry);
    const slot = toast.custom(panel);
    const panelCard = dom.document.querySelector<HTMLElement>("[data-custom]")!;
    panelCard.dispatchEvent(new dom.window.PointerEvent("pointerenter") as unknown as Event);
    retry.focus();
    toast.success("Saved", { duration: 100 });
    removeSilently(retry);
    // WebKit fires no pointerleave once the hovered button is gone, only pointerover where the pointer goes next.
    dom.document.body.dispatchEvent(new dom.window.PointerEvent("pointerover", { bubbles: true }) as unknown as Event);
    await Bun.sleep(150);
    expect(open()).toEqual([]);
    slot.dismiss();
    await Bun.sleep(220);

    // The same when the rail goes away under the pointer and focus, as when the scope that hosts it unmounts.
    const button = dom.document.createElement("button");
    toast.custom(button);
    const card = dom.document.querySelector<HTMLElement>("[data-custom]")!;
    card.dispatchEvent(new dom.window.PointerEvent("pointerenter") as unknown as Event);
    button.focus();
    removeSilently(card.closest("[data-k2b-toast-container]")!);
    toast.success("Saved again", { duration: 100 });
    await Bun.sleep(150);
    expect(open()).toEqual([]);
    dom.cleanup();
  });

  test("a finished progress toast makes room when the rail is over its limit", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { toast } = await import("../src/feedback/toast");
    const open = () => dom.document.querySelectorAll("[data-k2b-toast]:not([data-closing])").length;
    const batches = [1, 2, 3, 4].map((n) => toast(`Batch ${n}`, { progress: 0.1, duration: 0 }));
    expect(open()).toBe(4);
    batches.forEach((batch, index) => batch.update(`Batch ${index + 1} uploaded`, { variant: "success", progress: null }));
    expect(open()).toBe(3);
    dom.cleanup();
  });

  test("defaults the time on screen by variant, length and action", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { toast } = await import("../src/feedback/toast");
    const timers: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      if ((ms ?? 0) >= 1000) timers.push(ms!);
      return realSetTimeout(handler, ms);
    }) as typeof setTimeout;
    try {
      toast.success("Contact created");
      toast("Link copied", { action: { label: "Open", href: "/link" } });
      toast.error("Could not save");
      toast("x".repeat(100));
      toast.error("y".repeat(130));
      toast("Explicit", { duration: 2_000 });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    // The 7 s values are the announcement lines leaving their live region.
    expect(timers.filter((ms) => ms !== 7_000)).toEqual([4_000, 8_000, 8_000, 6_100, 2_000]);
    toast.dismissAll();
    dom.cleanup();
  });

  test("the toast close button is named in the document locale unless the app names it", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { toast } = await import("../src/feedback/toast");
    const closeLabels = () =>
      Array.from(dom.document.querySelectorAll("[data-k2b-toast]:not([data-closing]) .k2b-toast__close"), (button) =>
        button.getAttribute("aria-label"),
      );

    dom.document.documentElement.setAttribute("lang", "en");
    toast("Note", { duration: 0 });
    expect(closeLabels()).toEqual(["Dismiss notification"]);
    toast.dismissAll();

    dom.document.documentElement.setAttribute("lang", "de");
    toast("Hinweis", { duration: 0 });
    toast("Hinweis", { duration: 0, dismissLabel: "Meldung ausblenden" });
    expect(closeLabels()).toEqual(["Benachrichtigung schließen", "Meldung ausblenden"]);
    toast.dismissAll();

    dom.document.documentElement.removeAttribute("lang");
    dom.cleanup();
  });

  test("progress toasts update in place and distinguish cancelling from dismissing", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const { toast } = await import("../src/feedback/toast");
    let cancelled = 0;
    const notice = toast("Preparing", {
      title: "Import",
      duration: 1,
      progress: "indeterminate",
      action: { label: "Cancel", onClick: () => cancelled++ },
    });
    await settle();
    const element = dom.document.querySelector<HTMLElement>("[data-k2b-toast]")!;
    expect(element).not.toBeNull();
    const progress = element.querySelector("progress")!;
    expect(progress.hasAttribute("value")).toBe(false);
    expect(element.dataset.progress).toBe("true");
    element.click();
    await settle();
    expect(element.dataset.closing).toBeUndefined();
    notice.update("6 of 12 files", { progress: 0.5 });
    expect(element.querySelector("progress")).toBe(progress);
    expect(progress.value).toBe(0.5);
    // The title names the bar; the summary line is read instead of a bare percentage.
    expect([progress.getAttribute("aria-label"), progress.getAttribute("aria-valuetext")]).toEqual(["Import", "6 of 12 files"]);
    element.querySelector<HTMLButtonElement>(".k2b-toast__action")!.click();
    expect(cancelled).toBe(1);
    expect(element.dataset.closing).toBeUndefined();
    notice.update("Stopped", { progress: null, action: null, duration: 0 });
    expect(progress.hidden).toBe(true);
    expect(element.dataset.progress).toBe("false");
    expect(element.querySelector(".k2b-toast__action")).toBeNull();
    notice.dismiss();
    await Bun.sleep(220);
    dom.cleanup();
  });
});
