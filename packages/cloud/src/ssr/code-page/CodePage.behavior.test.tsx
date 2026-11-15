import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { capabilityResultSchema } from "../../contracts/capabilities";
import type { CodeLiveFeed } from "./CodeLiveStrip";
import { codePageFixture } from "./code-page.fixture";

const load = async () => {
  const dom = createDomTestHarness();
  try {
    const [{ default: CodePage }, { LocaleProvider, toast, prompts }, client, codeLive] = await Promise.all([
      import("./CodePage"),
      import("@k2b/ui"),
      import("../../capabilities/client"),
      import("./code-live"),
    ]);
    return { CodePage, LocaleProvider, toast, prompts, client, codeLive };
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
      feed.run({ id: runId, state: "succeeded", createdAt: "2026-11-14T12:49:00.000Z", title: "Create tasks · 1 confirmed" });
      await tick();
      expect(strip().at(-1)?.dataset.state).toBe("success");
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

// #65 in the browser: a finished run reads the week's results once; each new result is named by its target's reader
// with the person's session. A target they may not read keeps the kind-only sentence, without link or ID.
test.skipIf(isServer)("a new result after a live run is named only where the reader may read its target", async () => {
  const { client, codeLive } = modules!;
  let onRun: Parameters<typeof codeLive.followCodeRuns>[1] | undefined;
  const follow = spyOn(codeLive, "followCodeRuns").mockImplementation((_codeId, run) => {
    onRun = run;
    return () => {};
  });
  const runId = "44444444-4444-4444-8444-444444444499";
  const result = (id: string) => ({
    text: "Created task",
    app: "Spaces",
    state: "succeeded",
    at: "2026-11-14T10:00:00.000Z",
    runId,
    target: { ref: { type: "spaces.item", id }, text: "Created task “{name}”" },
  });
  const reads: string[] = [];
  const invoke = spyOn(client, "invokeCapabilityWithDataSchema").mockImplementation(async (invocation, schema) => {
    const parse = (body: unknown) => ({ ok: true as const, data: capabilityResultSchema(schema).parse(body) });
    if (invocation.capabilityId === "code.activity.words") {
      const fixture = codePageFixture("overview", "en");
      if (fixture.state.kind !== "ready" || !fixture.state.words?.activity) throw new Error("Expected ready fixture");
      return parse({ data: { ...fixture.state.words.activity, recent: [result("UxrUVC"), result("HidN3x")] } });
    }
    reads.push(`${invocation.appId}/${invocation.capabilityId}/${(invocation.input as { id: string }).id}`);
    if ((invocation.input as { id: string }).id === "HidN3x")
      return { ok: false as const, error: { code: "FORBIDDEN", message: "Hidden", status: 403 as const } };
    return parse({
      data: { view: { title: "Delivery Weber", permission: "read" } },
      links: [{ rel: "open", href: "/app/spaces/GPzX93/UxrUVC" }],
    });
  });
  const data = codePageFixture("overview", "en");
  if (data.state.kind !== "ready") throw new Error("Expected ready fixture");
  data.state.recentReaders = { "spaces.item": "item.read" };
  const page = mount(data);
  try {
    expect(onRun).toBeDefined();
    onRun!({ runId, state: "succeeded", at: "2026-11-14T10:00:00.000Z" });
    for (let index = 0; index < 20 && reads.length < 2; index++) await tick();
    await tick();
    expect(reads.sort()).toEqual(["spaces/item.read/HidN3x", "spaces/item.read/UxrUVC"]);
    const rows = [...page.dom.document.querySelectorAll(".cloud-code__feed li .cloud-code__feed-text")];
    // The link marks the name, so the quotation marks around it go.
    const named = rows.find((row) => row.textContent === "Created task Delivery Weber");
    expect(named?.querySelector("a")?.textContent).toBe("Delivery Weber");
    expect(named?.querySelector("a")?.getAttribute("href")).toBe("/app/spaces/GPzX93/UxrUVC");
    const hidden = rows.find((row) => row.textContent === "Created task");
    expect(hidden).toBeDefined();
    expect(hidden?.querySelector("a")).toBeNull();
    expect(page.dom.root.innerHTML).not.toMatch(/HidN3x|\{name\}/);
  } finally {
    page.dispose();
    follow.mockRestore();
    invoke.mockRestore();
  }
});

// #77 in the browser: "What it may do" names a target only where the server read its name as the person; a target
// they may not read keeps Core's type-only words, without reference. Places are text, never links.
test.skipIf(isServer)("what it may do shows its places as text, named only for the person", () => {
  const data = codePageFixture("overview", "en");
  const current = data.state.kind === "ready" ? data.state.words?.current : null;
  if (!current) throw new Error("Expected ready fixture with version words");
  current.mayDo = {
    items: [
      { text: "Create task · Space “Logistics”", app: "Spaces", href: "/app/spaces/GPzX93" },
      {
        text: "Create task · a target of type Space",
        app: "Spaces",
        target: { ref: { type: "spaces.space", id: "HidN3x" }, text: "Create task · Space “{name}”" },
      },
    ],
    more: 0,
    moreText: null,
  };
  const page = mount(data);
  try {
    const list = page.dom.document.querySelector(".cloud-code__rows[data-plain]");
    // The place is quiet text, named only where the server could read it, and never a link (v12 picture 19).
    expect(list?.textContent).toContain("Spaces · Space “Logistics”");
    expect(list?.querySelectorAll("a")).toHaveLength(0);
    expect(list?.textContent).toContain("a target of type Space");
    expect(page.dom.root.innerHTML).not.toMatch(/HidN3x|\{name\}/);
  } finally {
    page.dispose();
  }
});
