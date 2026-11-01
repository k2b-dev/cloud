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

for (const control of ["pause-menu", "resume-menu", "resume-notice", "run", "rerun"] as const) {
  test.skipIf(isServer)(`${control} names the Code target and keeps its ID out of input`, async () => {
    const dom = createDomTestHarness();
    const { CodePage, LocaleProvider, toast, client } = modules!;
    // A refused response lets the test inspect the real click without reloading or navigating.
    const invoke = spyOn(client, "invokeCapabilityWithDataSchema").mockResolvedValue({
      ok: false,
      error: { code: "BAD_INPUT", message: "Fixture refusal", status: 400 },
    });
    const notice = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const data = codePageFixture(control.startsWith("resume") ? "paused" : control === "rerun" ? "run-failed" : "overview", "en");
    if (data.state.kind !== "ready") throw new Error("Expected ready fixture");
    if (control === "run") data.state.automations![0]!.kind = "manual";
    const expectedInput =
      control === "run"
        ? { entrypoint: data.state.automations![0]!.entrypoint, input: null }
        : control === "rerun"
          ? { entrypoint: data.state.run!.run.entrypoint, input: data.state.run!.input }
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
    const button = (label: string) => {
      const match = [...dom.document.querySelectorAll<HTMLElement>("button, [role=menuitem]")].find(
        (element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label,
      );
      if (!match) throw new Error(`Missing control ${label}`);
      return match;
    };
    try {
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
      expect(invoke.mock.calls[0]?.[0].idempotencyKey).toEqual(
        control === "rerun" ? `rerun:${data.state.run!.run.id}` : expect.any(String),
      );
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    } finally {
      dispose();
      invoke.mockRestore();
      notice.mockRestore();
      dom.cleanup();
    }
  });
}
