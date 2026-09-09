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

    dom.root.remove();
    await dom.window.happyDOM.waitUntilComplete();
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
      surface.matches = (selector: string) =>
        selector === ":popover-open" ? surface.dataset.testPopoverOpen === "true" : matches(selector);
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
    wrapper?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
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
    expect(card?.dataset.tone).toBe("success");
    expect(card?.textContent).toContain("Saved");
    expect(card?.querySelector(".k2b-toast__content")?.getAttribute("role")).toBe("status");

    handle.update("Publish failed", {
      variant: "error",
      title: "Could not publish",
      duration: 0,
      iconClass: "ti ti-alert-triangle",
      action: { label: "Retry", href: "/retry" },
    });
    expect(card?.dataset.tone).toBe("danger");
    expect(card?.querySelector(".k2b-toast__content")?.getAttribute("role")).toBe("alert");
    expect(card?.querySelector(".k2b-toast__content")?.getAttribute("aria-live")).toBe("assertive");
    expect(card?.querySelector(".k2b-toast__icon i")?.className).toBe("ti ti-alert-triangle");
    expect(card?.textContent).toContain("Could not publish");
    expect(card?.querySelector<HTMLAnchorElement>(".k2b-toast__action")?.href).toBe("http://localhost/retry");

    for (let index = 0; index < 6; index += 1) toast(`Notice ${index}`, { duration: 0 });
    expect(rail?.querySelectorAll("[data-k2b-toast]").length).toBe(7);
    expect(rail?.querySelectorAll("[data-k2b-toast][data-closing='true']").length).toBe(2);

    toast.dismissAll();
    await Bun.sleep(220);
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
});
