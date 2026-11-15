import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { CodeLiveFeed } from "./CodeLiveStrip";
import { codePageFixture } from "./code-page.fixture";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    const [{ default: CodePage }, { LocaleProvider, toast, prompts }, client] = await Promise.all([
      import("./CodePage"),
      import("@k2b/ui"),
      import("../../capabilities/client"),
    ]);
    return { CodePage, LocaleProvider, toast, prompts, client };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const mount = (data: ReturnType<typeof codePageFixture>, onLive?: (feed: CodeLiveFeed) => undefined) => {
  const dom = createDomTestHarness();
  const { CodePage, LocaleProvider } = modules!;
  delegateEvents(["click"]);
  const dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(CodePage, { data, onLive });
        },
      }),
    dom.root,
  );
  const control = (label: string) => {
    const match = [...dom.document.querySelectorAll<HTMLElement>("button, [role=menuitem], a")].find(
      (element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label,
    );
    if (!match) throw new Error(`Missing control ${label}`);
    return match;
  };
  return { dom, control, dispose: () => (dispose(), dom.cleanup()) };
};

for (const control of [
  "pause-menu",
  "resume-head",
  "run",
  "rerun",
  "event-rerun-after",
  "event-rerun-before",
  "event-unstarted",
] as const) {
  test.skipIf(isServer)(`${control} names the Code target and keeps its ID out of input`, async () => {
    const { toast, prompts, client } = modules!;
    // A refused response lets the test inspect the real click without reloading or navigating.
    const invoke = spyOn(client, "invokeCapabilityWithDataSchema").mockResolvedValue({
      ok: false,
      error: { code: "BAD_INPUT", message: "Fixture refusal", status: 400 },
    });
    const notice = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    // "Run again …" first shows what the run already did; the test confirms it.
    const confirm = spyOn(prompts, "confirm").mockResolvedValue(true);
    const isEvent = control.startsWith("event-");
    const isRerun = control === "rerun" || isEvent;
    const data = codePageFixture(control === "resume-head" ? "paused" : isRerun ? "run-failed" : "overview", "en");
    if (data.state.kind !== "ready") throw new Error("Expected ready fixture");
    if (control === "run") data.state.automations = [{ ...data.state.automations![0]!, kind: "manual", title: "Review deliveries" }];
    if (isEvent) {
      data.state.run!.run.trigger = "event";
      if (control !== "event-rerun-after") data.state.run!.calls = [];
      if (control === "event-unstarted") data.state.run!.run.startedAt = null;
    }
    const expectedInput =
      control === "run"
        ? { entrypoint: data.state.automations![0]!.entrypoint, input: null }
        : isRerun
          ? { entrypoint: data.state.run!.run.entrypoint, input: data.state.run!.input, rerunOf: data.state.run!.run.id }
          : {};
    const page = mount(data);
    try {
      if (control === "event-unstarted") {
        expect(page.dom.root.textContent).not.toContain("Run again …");
        expect(invoke).not.toHaveBeenCalled();
        return;
      }
      if (control === "pause-menu") {
        page.control("More").click();
        await tick();
      }
      page
        .control(control === "pause-menu" ? "Pause" : control === "resume-head" ? "Resume" : control === "run" ? "Run now" : "Run again …")
        .click();
      await tick();
      if (isRerun) expect(confirm).toHaveBeenCalledTimes(1);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0]?.[0]).toMatchObject({
        appId: "core",
        kind: "action",
        capabilityId: control === "pause-menu" ? "code.pause" : control === "resume-head" ? "code.resume" : "code.run",
        target: { type: "core.code", id: data.state.code.id },
        input: expectedInput,
      });
      expect(invoke.mock.calls[0]?.[0].input).toEqual(expectedInput);
      const returnedData =
        control === "run" || isRerun ? { runId: "00000000-0000-4000-8000-000000000099", duplicate: false } : { state: "paused" };
      expect(invoke.mock.calls[0]![1].safeParse(returnedData).success).toBe(true);
      expect(invoke.mock.calls[0]?.[0].idempotencyKey).toEqual(isRerun ? `rerun:${data.state.run!.run.id}` : expect.any(String));
    } finally {
      page.dispose();
      invoke.mockRestore();
      notice.mockRestore();
      confirm.mockRestore();
    }
  });
}

test.skipIf(isServer)("“Run again …” that the person cancels starts nothing", async () => {
  const { prompts, client } = modules!;
  const invoke = spyOn(client, "invokeCapabilityWithDataSchema");
  const confirm = spyOn(prompts, "confirm").mockResolvedValue(false);
  const page = mount(codePageFixture("run-failed", "en"));
  try {
    page.control("Run again …").click();
    await tick();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    page.dispose();
    invoke.mockRestore();
    confirm.mockRestore();
  }
});

test.skipIf(isServer)("“Copy handle” in the menu copies the service account's handle, and failing to copy says so", async () => {
  const { toast } = modules!;
  const written: string[] = [];
  let refuse = false;
  // The DOM harness brings its own navigator: the clipboard goes on after mounting.
  const page = mount(codePageFixture("overview", "en"));
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        if (refuse) throw new Error("Clipboard denied");
        written.push(value);
      },
    },
  });
  const success = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
  const failure = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
  const copy = async () => {
    page.control("More").click();
    await tick();
    page.control("Copy handle").click();
    await tick();
  };
  try {
    // The handle is no longer part of the page's text; it lives behind the menu.
    expect(page.dom.root.textContent).not.toContain("code-7k2q9m4xwt");
    await copy();
    expect(written).toEqual(["code-7k2q9m4xwt"]);
    expect(success).toHaveBeenCalledWith("Handle copied");
    refuse = true;
    await copy();
    expect(failure).toHaveBeenCalledWith("The handle could not be copied.");
  } finally {
    page.dispose();
    success.mockRestore();
    failure.mockRestore();
  }
});

test.skipIf(isServer)(
  "a live run appears as a pulsing ring, settles in place when it ends, and its effect slides into the list",
  async () => {
    let feed: CodeLiveFeed | undefined;
    const page = mount(codePageFixture("overview", "en"), (live) => {
      feed = live;
      return undefined;
    });
    const strip = () => [...page.dom.document.querySelectorAll<HTMLElement>(".cloud-code__strip .k2b-dot-strip__dot")];
    const runId = "00000000-0000-4000-8000-0000000000f1";
    try {
      if (!feed) throw new Error("The page did not hand its live feed to the host");
      const before = strip().length;
      feed.run({ id: runId, state: "running", createdAt: "2026-11-14T12:49:00.000Z" });
      await tick();
      // The strip keeps its 30 slots; the new run takes the newest, rightmost one.
      expect(strip()).toHaveLength(before);
      expect(strip().at(-1)?.dataset.state).toBe("running");
      expect(strip().at(-1)?.hasAttribute("data-settled")).toBe(false);
      feed.run({ id: runId, state: "succeeded", createdAt: "2026-11-14T12:49:00.000Z", title: "Create tasks · 1 confirmed" });
      await tick();
      expect(strip().at(-1)?.dataset.state).toBe("success");
      expect(strip().at(-1)?.hasAttribute("data-settled")).toBe(true);
      // "Last" changes to the run that just ended.
      expect(page.dom.document.querySelector(".cloud-code__lage-last")?.textContent).toContain("Create tasks · 1 confirmed");
      expect(page.dom.document.querySelector(".cloud-code__lage-last")?.hasAttribute("data-fresh")).toBe(true);
      const rows = () => [...page.dom.document.querySelectorAll<HTMLElement>(".cloud-code__feed > li")];
      const count = rows().length;
      feed.effect({ text: "Create task · 1 confirmed · Delivery Holz Brandt", at: "2026-11-14T12:49:00.000Z", runId });
      await tick();
      // A fixed number of rows: the newest comes in on top.
      expect(rows()).toHaveLength(Math.min(count + 1, 6));
      expect(rows()[0]?.textContent).toContain("Delivery Holz Brandt");
      expect(rows()[0]?.hasAttribute("data-fresh")).toBe(true);
    } finally {
      page.dispose();
    }
  },
);
