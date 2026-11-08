import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { codePageFixture } from "./code-page.fixture";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    const [{ default: CodePage }, { LocaleProvider, toast }, client] = await Promise.all([
      import("./CodePage"),
      import("@k2b/ui"),
      import("../../capabilities/client"),
    ]);
    return { CodePage, LocaleProvider, toast, client };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

for (const control of [
  "pause-menu",
  "resume-menu",
  "resume-notice",
  "run",
  "rerun",
  "event-rerun-after",
  "event-rerun-before",
  "event-unstarted",
] as const) {
  test.skipIf(isServer)(`${control} names the Code target and keeps its ID out of input`, async () => {
    const dom = createDomTestHarness();
    const { CodePage, LocaleProvider, toast, client } = modules!;
    // A refused response lets the test inspect the real click without reloading or navigating.
    const invoke = spyOn(client, "invokeCapabilityWithDataSchema").mockResolvedValue({
      ok: false,
      error: { code: "BAD_INPUT", message: "Fixture refusal", status: 400 },
    });
    const notice = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const isEvent = control.startsWith("event-");
    const isRerun = control === "rerun" || isEvent;
    const data = codePageFixture(control.startsWith("resume") ? "paused" : isRerun ? "run-failed" : "overview", "en");
    if (data.state.kind !== "ready") throw new Error("Expected ready fixture");
    if (control === "run") {
      data.state.automations![0]!.kind = "manual";
      data.state.automations![0]!.title = "Review deliveries";
    }
    if (isRerun) data.state.run!.run.title = "Review deliveries";
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
    delegateEvents(["click"]);
    const dispose = render(
      () =>
        createComponent(LocaleProvider, {
          locale: "en",
          get children() {
            return createComponent(CodePage, { data });
          },
        }),
      dom.root,
    );
    if (control === "run" || isRerun) expect(dom.root.textContent).toContain("Review deliveries");
    const button = (label: string) => {
      const match = [...dom.document.querySelectorAll<HTMLElement>("button, [role=menuitem]")].find(
        (element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label,
      );
      if (!match) throw new Error(`Missing control ${label}`);
      return match;
    };
    try {
      if (control === "event-unstarted") {
        expect([...dom.document.querySelectorAll("button")].some((element) => element.textContent?.trim() === "Run again")).toBe(false);
        expect(invoke).not.toHaveBeenCalled();
        return;
      }
      if (control.endsWith("menu")) {
        button("More").click();
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      }
      button(
        control === "pause-menu" ? "Pause" : control.startsWith("resume") ? "Resume" : control === "run" ? "Run now" : "Run again",
      ).click();
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(invoke.mock.calls[0]?.[0]).toMatchObject({
        appId: "core",
        kind: "action",
        capabilityId: control === "pause-menu" ? "code.pause" : control.startsWith("resume") ? "code.resume" : "code.run",
        target: { type: "core.code", id: data.state.code.id },
        input: expectedInput,
      });
      expect(invoke.mock.calls[0]?.[0].input).toEqual(expectedInput);
      const returnedData =
        control === "run" || isRerun ? { runId: "00000000-0000-4000-8000-000000000099", duplicate: false } : { state: "paused" };
      expect(invoke.mock.calls[0]![1].safeParse(returnedData).success).toBe(true);
      expect(invoke.mock.calls[0]?.[0].idempotencyKey).toEqual(isRerun ? `rerun:${data.state.run!.run.id}` : expect.any(String));
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    } finally {
      dispose();
      invoke.mockRestore();
      notice.mockRestore();
      dom.cleanup();
    }
  });
}

test.skipIf(isServer)("“Copy handle” under a target refusal copies the service account's handle, and failing to copy says so", async () => {
  const dom = createDomTestHarness();
  const { CodePage, LocaleProvider, toast } = modules!;
  const written: string[] = [];
  let refuse = false;
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
  delegateEvents(["click"]);
  const dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale: "en",
        get children() {
          return createComponent(CodePage, { data: codePageFixture("refused", "en") });
        },
      }),
    dom.root,
  );
  const copy = () => {
    const button = [...dom.document.querySelectorAll<HTMLElement>("button")].find(
      (element) => element.textContent?.trim() === "Copy handle",
    );
    if (!button) throw new Error("Missing Copy handle");
    button.click();
  };
  try {
    expect(dom.root.textContent).toContain(
      "Whoever manages the target adds the service account in the target's access editor with the handle code-7k2q9m4xwt. The next run tries again.",
    );
    copy();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(written).toEqual(["code-7k2q9m4xwt"]);
    expect(success).toHaveBeenCalledWith("Handle copied");
    refuse = true;
    copy();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(failure).toHaveBeenCalledWith("The handle could not be copied.");
  } finally {
    dispose();
    success.mockRestore();
    failure.mockRestore();
    dom.cleanup();
  }
});
