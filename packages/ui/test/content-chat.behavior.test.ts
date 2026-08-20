import { describe, expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { ChatTimelineItem } from "../src/chat/ChatTimeline";
import { createDomTestHarness } from "./dom";

describe("@k2b/ui content and chat behavior", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("keeps nested DataTable controls independent from the row action", async () => {
    const dom = createDomTestHarness();
    const { default: DataTable } = await import("../src/content/DataTable");
    const rowClicks: string[] = [];
    const rowDoubleClicks: string[] = [];
    let controlClicks = 0;

    const dispose = render(
      () =>
        createComponent(DataTable<{ id: string; name: string }>, {
          rows: [{ id: "one", name: "Ada" }],
          columns: [{ id: "name", header: "Name", value: "name" }],
          getRowId: (row) => row.id,
          onRowClick: (row) => rowClicks.push(row.id),
          onRowDoubleClick: (row) => rowDoubleClicks.push(row.id),
          renderCell: () => {
            const button = dom.document.createElement("button");
            button.type = "button";
            button.textContent = "Open actions";
            button.addEventListener("click", () => {
              controlClicks += 1;
            });
            return button as unknown as HTMLElement;
          },
        }),
      dom.root,
    );

    const row = dom.root.querySelector<HTMLTableRowElement>("tbody tr");
    const cell = dom.root.querySelector<HTMLTableCellElement>("tbody td");
    const button = dom.root.querySelector<HTMLButtonElement>("tbody button");

    button?.click();
    expect(controlClicks).toBe(1);
    expect(rowClicks).toEqual([]);

    const nestedDoubleClick = new MouseEvent("dblclick", { bubbles: true });
    button?.dispatchEvent(nestedDoubleClick);
    expect(rowDoubleClicks).toEqual([]);

    const nestedEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    const nestedSpace = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    button?.dispatchEvent(nestedEnter);
    button?.dispatchEvent(nestedSpace);
    expect(rowClicks).toEqual([]);
    expect(nestedEnter.defaultPrevented).toBe(false);
    expect(nestedSpace.defaultPrevented).toBe(false);

    cell?.click();
    expect(rowClicks).toEqual(["one"]);

    row?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(rowDoubleClicks).toEqual(["one"]);

    const rowEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    row?.dispatchEvent(rowEnter);
    expect(rowClicks).toEqual(["one", "one"]);
    expect(rowEnter.defaultPrevented).toBe(true);
    expect(row?.getAttribute("tabindex")).toBe("0");

    dispose();
    dom.cleanup();
  });

  test("gives double-click-only DataTable rows a keyboard action", async () => {
    const dom = createDomTestHarness();
    const { default: DataTable } = await import("../src/content/DataTable");
    const activated: string[] = [];
    const dispose = render(
      () =>
        createComponent(DataTable<{ id: string }>, {
          rows: [{ id: "one" }],
          columns: [{ id: "id", header: "ID", value: "id" }],
          onRowDoubleClick: (row) => activated.push(row.id),
        }),
      dom.root,
    );

    const row = dom.root.querySelector<HTMLTableRowElement>("tbody tr")!;
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    const handler = (row as HTMLTableRowElement & { $$keydown?: (event: KeyboardEvent) => void }).$$keydown;
    Object.defineProperties(event, {
      currentTarget: { configurable: true, value: row },
      target: { configurable: true, value: row },
    });
    handler?.(event);
    expect(activated).toEqual(["one"]);

    dispose();
    dom.cleanup();
  });

  test("keeps infinite DataTable loading single-flight until the result changes", async () => {
    const dom = createDomTestHarness();
    const { default: DataTable } = await import("../src/content/DataTable");
    const [rows, setRows] = createSignal([{ id: "one" }]);
    let calls = 0;
    const dispose = render(
      () =>
        createComponent(DataTable<{ id: string }>, {
          get rows() {
            return rows();
          },
          columns: [{ id: "id", header: "ID", value: "id" }],
          hasMore: true,
          onLoadMore: () => {
            calls += 1;
          },
        }),
      dom.root,
    );
    const region = dom.root.querySelector<HTMLElement>(".k2b-table-wrap")!;

    region.dispatchEvent(new Event("scroll"));
    region.dispatchEvent(new Event("scroll"));
    expect(calls).toBe(1);

    setRows([{ id: "one" }, { id: "two" }]);
    await Promise.resolve();
    expect(calls).toBe(2);

    dispose();
    dom.cleanup();
  });

  test("tracks DataTable overflow without exposing a second scroll owner", async () => {
    const dom = createDomTestHarness();
    const { default: DataTable } = await import("../src/content/DataTable");
    const dispose = render(
      () =>
        createComponent(DataTable<{ id: string }>, {
          rows: [{ id: "one" }],
          columns: [{ id: "id", header: "ID", value: "id" }],
        }),
      dom.root,
    );
    const shell = dom.root.querySelector<HTMLElement>(".k2b-table-shell")!;
    const viewport = dom.root.querySelector<HTMLElement>(".k2b-table-wrap")!;
    const vertical = dom.root.querySelector<HTMLElement>('.k2b-data-table__scrollbar[data-axis="y"]')!;
    const horizontal = dom.root.querySelector<HTMLElement>('.k2b-data-table__scrollbar[data-axis="x"]')!;

    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
      clientWidth: { configurable: true, value: 240 },
      scrollWidth: { configurable: true, value: 240 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    viewport.dispatchEvent(new Event("scroll"));
    await Promise.resolve();

    expect(shell.dataset.scrollbarEnhanced).toBe("true");
    expect(shell.dataset.overflowY).toBe("true");
    expect(shell.dataset.overflowX).toBeUndefined();
    expect(shell.dataset.scrolling).toBe("true");
    expect(vertical.dataset.overflow).toBe("true");
    expect(horizontal.dataset.overflow).toBeUndefined();
    expect((vertical.firstElementChild as HTMLElement | null)?.style.getPropertyValue("--k2b-data-table-scroll-size")).toBe("25px");
    expect(vertical.getAttribute("aria-hidden")).toBe("true");
    expect(viewport.getAttribute("role")).toBe("region");
    expect(viewport.getAttribute("tabindex")).toBe("0");

    dispose();
    dom.cleanup();
  });

  test("reacts when pagination grows beyond one page", async () => {
    const dom = createDomTestHarness();
    const { Pagination } = await import("../src/content/Pagination");
    const [totalPages, setTotalPages] = createSignal(1);
    const dispose = render(
      () =>
        createComponent(Pagination, {
          currentPage: 1,
          get totalPages() {
            return totalPages();
          },
          baseUrl: "/items?page=",
        }),
      dom.root,
    );

    expect(dom.root.querySelector("nav")).toBeNull();
    setTotalPages(3);
    await Promise.resolve();
    expect(dom.root.querySelector("nav")?.textContent).toContain("2");

    dispose();
    dom.cleanup();
  });

  test("names the focusable ChatTimeline viewport as a scroll region", async () => {
    const dom = createDomTestHarness();
    const { Chat } = await import("../src/chat");

    const dispose = render(
      () =>
        createComponent(Chat.Timeline, {
          label: "Support conversation",
          items: [{ kind: "message", id: "one", role: "user", content: "Hello" }],
        }),
      dom.root,
    );

    const viewport = dom.root.querySelector<HTMLElement>(".k2b-chat-timeline__viewport");
    expect(viewport?.getAttribute("role")).toBe("region");
    expect(viewport?.getAttribute("aria-label")).toBe("Support conversation messages");
    expect(viewport?.getAttribute("tabindex")).toBe("0");

    dispose();
    dom.cleanup();
  });

  test("follows new messages only while the reader remains pinned", async () => {
    const dom = createDomTestHarness();
    const { Chat } = await import("../src/chat");
    const [items, setItems] = createSignal<ChatTimelineItem[]>([{ kind: "message", id: "one", role: "user", content: "One" }]);
    let scrollHeight = 500;
    let viewport: HTMLDivElement | undefined;
    const dispose = render(
      () =>
        createComponent(Chat.Timeline, {
          get items() {
            return items();
          },
          viewportRef: (element) => {
            viewport = element;
            Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => scrollHeight });
            Object.defineProperty(element, "clientHeight", { configurable: true, value: 100 });
          },
        }),
      dom.root,
    );
    await new Promise<void>((done) => requestAnimationFrame(() => done()));

    viewport!.scrollTop = 100;
    viewport!.dispatchEvent(new Event("scroll"));
    scrollHeight = 600;
    setItems((current) => [...current, { kind: "message", id: "two", role: "assistant", content: "Two" }]);
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    expect(viewport!.scrollTop).toBe(100);

    viewport!.scrollTop = 500;
    viewport!.dispatchEvent(new Event("scroll"));
    scrollHeight = 700;
    setItems((current) => [...current, { kind: "message", id: "three", role: "assistant", content: "Three" }]);
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    expect(viewport!.scrollTop).toBe(700);

    dispose();
    dom.cleanup();
  });

  test("does not lose follow-latest when layout scrolling races a scheduled follow", async () => {
    const dom = createDomTestHarness();
    const { Chat } = await import("../src/chat");
    const [items, setItems] = createSignal<ChatTimelineItem[]>([{ kind: "message", id: "one", role: "user", content: "One" }]);
    let scrollHeight = 500;
    let viewport: HTMLDivElement | undefined;
    const dispose = render(
      () =>
        createComponent(Chat.Timeline, {
          get items() {
            return items();
          },
          viewportRef: (element) => {
            viewport = element;
            Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => scrollHeight });
            Object.defineProperty(element, "clientHeight", { configurable: true, value: 100 });
          },
        }),
      dom.root,
    );
    await new Promise<void>((done) => requestAnimationFrame(() => done()));

    viewport!.scrollTop = 400;
    viewport!.dispatchEvent(new Event("scroll"));
    scrollHeight = 700;
    setItems((current) => [...current, { kind: "message", id: "editor", role: "assistant", content: "Growing editor" }]);
    await Promise.resolve();
    viewport!.dispatchEvent(new Event("scroll"));
    await new Promise<void>((done) => requestAnimationFrame(() => done()));

    expect(viewport!.scrollTop).toBe(700);

    scrollHeight = 900;
    setItems((current) => [...current, { kind: "message", id: "more", role: "assistant", content: "More" }]);
    await Promise.resolve();
    const wheel = new Event("wheel", { bubbles: true });
    Object.defineProperty(wheel, "deltaY", { value: -20 });
    viewport!.dispatchEvent(wheel);
    viewport!.scrollTop = 450;
    viewport!.dispatchEvent(new Event("scroll"));
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    expect(viewport!.scrollTop).toBe(450);
    expect(dom.root.querySelector(".k2b-chat-timeline__latest")).not.toBeNull();

    dispose();
    dom.cleanup();
  });

  test("follows viewport size changes while pinned", async () => {
    const dom = createDomTestHarness();
    const observers: Array<{ targets: Element[]; trigger: () => void }> = [];
    class TestResizeObserver {
      readonly targets: Element[] = [];
      constructor(private readonly callback: ResizeObserverCallback) {
        observers.push({ targets: this.targets, trigger: () => this.callback([], this as unknown as ResizeObserver) });
      }
      observe(target: Element) {
        this.targets.push(target);
      }
      disconnect() {}
      unobserve() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
    const { Chat } = await import("../src/chat");
    let scrollHeight = 500;
    let viewport: HTMLDivElement | undefined;
    const dispose = render(
      () =>
        createComponent(Chat.Timeline, {
          items: [{ kind: "message", id: "one", role: "user", content: "One" }],
          viewportRef: (element) => {
            viewport = element;
            Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => scrollHeight });
            Object.defineProperty(element, "clientHeight", { configurable: true, value: 100 });
          },
        }),
      dom.root,
    );
    await new Promise<void>((done) => requestAnimationFrame(() => done()));

    expect(observers).toHaveLength(1);
    expect(observers[0]!.targets).toContain(viewport!);
    expect(observers[0]!.targets).toContain(dom.root.querySelector(".k2b-chat-timeline__content")!);

    scrollHeight = 650;
    observers[0]!.trigger();
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    expect(viewport!.scrollTop).toBe(650);

    dispose();
    dom.cleanup();
  });

  test("preserves the visible scroll position when older messages are prepended", async () => {
    const dom = createDomTestHarness();
    const { Chat } = await import("../src/chat");
    const [items, setItems] = createSignal<ChatTimelineItem[]>([{ kind: "message", id: "new", role: "assistant", content: "New" }]);
    let scrollHeight = 500;
    let viewport: HTMLDivElement | undefined;
    const dispose = render(
      () =>
        createComponent(Chat.Timeline, {
          get items() {
            return items();
          },
          hasMore: true,
          followThreshold: 0,
          onLoadOlder: () => {
            setItems((current) => [{ kind: "message", id: "old", role: "user", content: "Old" }, ...current]);
            scrollHeight = 700;
          },
          viewportRef: (element) => {
            viewport = element;
            Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => scrollHeight });
            Object.defineProperty(element, "clientHeight", { configurable: true, value: 100 });
          },
        }),
      dom.root,
    );
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    viewport!.scrollTop = 50;
    viewport!.dispatchEvent(new Event("scroll"));

    const historyButton = dom.root.querySelector<HTMLButtonElement>(".k2b-chat-timeline__older")!;
    const clickEvent = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(clickEvent, "currentTarget", { configurable: true, value: historyButton });
    (historyButton as HTMLButtonElement & { $$click?: (event: MouseEvent) => void }).$$click?.(clickEvent);
    await Promise.resolve();
    await new Promise<void>((done) => setTimeout(done, 0));
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    await new Promise<void>((done) => requestAnimationFrame(() => done()));
    expect(viewport!.scrollTop).toBe(250);

    dispose();
    dom.cleanup();
  });

  test("restores composer focus after a run without stealing another editor", async () => {
    const dom = createDomTestHarness();
    const { Chat } = await import("../src/chat");
    const [running, setRunning] = createSignal(true);
    const externalInput = dom.document.createElement("input");
    dom.document.body.append(externalInput);

    const dispose = render(
      () =>
        createComponent(Chat.Composer, {
          value: "",
          onValueChange: () => undefined,
          onSubmit: () => undefined,
          get state() {
            return running() ? "running" : "idle";
          },
        }),
      dom.root,
    );
    const composerInput = dom.root.querySelector<HTMLTextAreaElement>("textarea");

    setRunning(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dom.document.activeElement).toBe(composerInput);

    setRunning(true);
    externalInput.focus();
    setRunning(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dom.document.activeElement).toBe(externalInput);

    dispose();
    externalInput.remove();
    dom.cleanup();
  });

  test("grows the composer for long drafts before it starts scrolling", async () => {
    const dom = createDomTestHarness();
    const { Chat } = await import("../src/chat");
    const [draft, setDraft] = createSignal("");
    const dispose = render(
      () =>
        createComponent(Chat.Composer, {
          get value() {
            return draft();
          },
          onValueChange: setDraft,
          onSubmit: () => undefined,
        }),
      dom.root,
    );
    const textarea = dom.root.querySelector<HTMLTextAreaElement>("textarea")!;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: () => 600 });
    textarea.value = "A long draft";
    const input = new Event("input", { bubbles: true });
    Object.defineProperty(input, "currentTarget", { configurable: true, value: textarea });
    (textarea as HTMLTextAreaElement & { $$input?: (event: InputEvent) => void }).$$input?.(input as InputEvent);

    expect(textarea.style.height).toBe("384px");

    dispose();
    dom.cleanup();
  });

  test("replaces stop with steer as soon as the user types during a run", async () => {
    const dom = createDomTestHarness();
    const { Chat } = await import("../src/chat");
    const [draft, setDraft] = createSignal("");

    const dispose = render(
      () =>
        createComponent(Chat.Composer, {
          get value() {
            return draft();
          },
          onValueChange: setDraft,
          onSubmit: () => undefined,
          onStop: () => undefined,
          state: "running",
        }),
      dom.root,
    );

    expect(dom.root.querySelector('[aria-label="Stop response"]')).not.toBeNull();
    expect(dom.root.querySelector('[aria-label="Steer response"]')).toBeNull();

    setDraft("One more detail");
    await Promise.resolve();

    expect(dom.root.querySelector('[aria-label="Stop response"]')).toBeNull();
    expect(dom.root.querySelector('[aria-label="Steer response"]')).not.toBeNull();

    dispose();
    dom.cleanup();
  });

  test("reports the configured queue intent for a draft entered during a run", async () => {
    const dom = createDomTestHarness();
    const { Chat } = await import("../src/chat");
    const [draft, setDraft] = createSignal("");
    let intent = "";
    const dispose = render(
      () =>
        createComponent(Chat.Composer, {
          get value() {
            return draft();
          },
          onValueChange: setDraft,
          onSubmit: (input) => {
            intent = input.intent;
          },
          state: "running",
          runningSubmitIntent: "queue",
        }),
      dom.root,
    );

    setDraft("Next question");
    await Promise.resolve();
    const queueButton = dom.root.querySelector<HTMLButtonElement>('[aria-label="Queue message"]');
    expect(queueButton).not.toBeNull();
    expect(queueButton!.disabled).toBe(false);
    const click = (queueButton as HTMLButtonElement & { $$click?: () => void })?.$$click;
    click?.();
    await Promise.resolve();
    expect(intent).toBe("queue");

    dispose();
    dom.cleanup();
  });
});
