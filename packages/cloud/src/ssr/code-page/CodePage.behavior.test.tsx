import { expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { CodeRunEventSchema } from "../../code/live-events";
import { capabilityResultSchema } from "../../contracts/capabilities";
import type { CodeLiveFeed } from "./CodeLiveStrip";
import { codePageFixture } from "./code-page.fixture";
import { headActionFixture } from "./head-action.fixture";

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
    if (invocation.capabilityId === "code.run.list") return parse({ data: { items: [], nextCursor: null } });
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

test.skipIf(isServer)("head and overview share one pending start; retry keeps its original key and intent", async () => {
  const { client, toast } = modules!;
  let complete: (() => void) | undefined;
  const invoke = spyOn(client, "invokeCapabilityWithDataSchema").mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
    return { ok: false as const, error: { code: "app_unavailable", status: 503, message: "No connection" } };
  });
  let retry: (() => void) | undefined;
  const error = spyOn(toast, "error").mockImplementation((_text, options) => {
    if (options?.action && "onClick" in options.action) retry = options.action.onClick;
    return { dismiss: () => {}, update: () => {} };
  });
  const data = codePageFixture("personal", "en");
  const page = mount(data, () => undefined);
  try {
    const starts = () =>
      [...page.dom.document.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === "Run now");
    expect(starts()).toHaveLength(2);
    starts()[0]!.click();
    await tick();
    expect(starts().every((button) => button.disabled)).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    const original = invoke.mock.calls[0]![0];
    complete!();
    await tick();
    expect(retry).toBeDefined();
    retry!();
    await tick();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1]![0]).toMatchObject({
      input: original.input,
      idempotencyKey: original.idempotencyKey,
      target: original.target,
    });
    complete!();
    await tick();
    // Pressing the familiar button again after a lost response is the same safe retry too.
    starts()[1]!.click();
    await tick();
    expect(invoke.mock.calls[2]![0].idempotencyKey).toBe(original.idempotencyKey);
    complete!();
    await tick();
  } finally {
    page.dispose();
    invoke.mockRestore();
    error.mockRestore();
  }
});

for (const refusal of ["paused", "approval", "conflict"] as const) {
  test.skipIf(isServer)(`a ${refusal} start refusal offers only the recovery Core confirms`, async () => {
    const { client, toast } = modules!;
    const data = codePageFixture("personal", "en");
    if (data.state.kind !== "ready") throw new Error("Expected ready fixture");
    const code = data.state.code;
    const invoke = spyOn(client, "invokeCapabilityWithDataSchema").mockImplementation(async (invocation, schema) => {
      if (invocation.capabilityId === "code.read")
        return {
          ok: true,
          data: capabilityResultSchema(schema).parse({
            data: {
              code: {
                ...code,
                state: refusal === "paused" ? "paused" : "active",
                pausedBy: refusal === "paused" ? { name: "Lena" } : null,
                pausedAt: "2026-11-14T12:49:04.000Z",
                owner: { kind: "person", userId: "fixture-user" },
              },
              permission: "editor",
            },
          }),
        };
      return {
        ok: false,
        error: {
          code: refusal === "approval" ? "code_approval_required" : "CONFLICT",
          status: refusal === "approval" ? 403 : 409,
          message: "Fixture refusal",
        },
      };
    });
    const notice = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const page = mount(data, () => undefined);
    try {
      page.control("Run now").click();
      await tick();
      expect(notice.mock.calls[0]?.[1]?.duration).toBe(0);
      if (refusal === "paused") {
        expect(page.control("Resume")).toBeDefined();
        expect(notice.mock.calls[0]?.[0]).toBe("Not started: Lena has since paused the automation.");
        expect(page.dom.root.querySelector(".cloud-code__state")?.textContent).toContain("Paused");
        expect(notice.mock.calls[0]?.[1]?.action).toBeNull();
      } else if (refusal === "approval") {
        expect(page.control("Run now")).toBeDefined();
        expect(notice.mock.calls[0]?.[0]).toBe("Not started: This version needs a new approval first.");
        expect(notice.mock.calls[0]?.[1]?.action).toMatchObject({ label: "View version", href: `${data.href}?tab=versions` });
      } else {
        expect(page.dom.root.querySelector(".cloud-code__state")?.textContent).not.toContain("Paused");
        expect(notice.mock.calls[0]?.[1]?.action).toMatchObject({ label: "Try again" });
      }
    } finally {
      page.dispose();
      invoke.mockRestore();
      notice.mockRestore();
    }
  });
}

test.skipIf(isServer)("a terminal live hint before the start receipt stays terminal and reports only the own failed run once", async () => {
  const { client, toast } = modules!;
  const data = codePageFixture("personal", "en");
  if (data.state.kind !== "ready" || !data.state.runs) throw new Error("Expected loaded runs");
  // One preceding run exercises this race; the browser matrix covers the complete history and geometry.
  data.state.runs.items = data.state.runs.items.slice(0, 1);
  const runId = "00000000-0000-4000-8000-999900000001";
  let complete: (() => void) | undefined;
  const invoke = spyOn(client, "invokeCapabilityWithDataSchema").mockImplementation(async (invocation, schema) => {
    if (invocation.capabilityId === "code.run")
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
    return {
      ok: true,
      data: capabilityResultSchema(schema).parse({
        data:
          invocation.capabilityId === "code.run"
            ? { runId, duplicate: false }
            : {
                runId,
                title: "Weekly report",
                state: "failed",
                status: "Failed",
                at: "2026-11-14T12:49:04.000Z",
                reason: "The daily limit was reached.",
                untilThen: { items: [], more: 0, moreText: null },
                complete: true,
              },
      }),
    };
  });
  const notice = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
  const success = spyOn(toast, "success").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
  let feed: CodeLiveFeed | undefined;
  const page = mount(data, (live) => {
    feed = live;
    return undefined;
  });
  try {
    page.control("Run now").click();
    await tick();
    const failed = { id: runId, state: "failed" as const, createdAt: "2026-11-14T12:49:04.000Z" };
    feed!.run(failed);
    await tick();
    expect(notice).not.toHaveBeenCalled();
    complete!();
    await tick();
    expect(page.dom.root.querySelector(".cloud-code__state")?.getAttribute("data-tone")).toBe("danger");
    expect(invoke.mock.calls.filter(([invocation]) => invocation.capabilityId === "code.run.words")).toHaveLength(1);
    expect(notice.mock.calls[0]).toMatchObject([
      "The run failed: The daily limit was reached.",
      { duration: 0, action: { label: "View run", href: `${data.href}?tab=runs&run=${runId}` } },
    ]);
    feed!.run(failed);
    await tick();
    expect(notice).toHaveBeenCalledTimes(1);
  } finally {
    page.dispose();
    invoke.mockRestore();
    notice.mockRestore();
    success.mockRestore();
  }
});

for (const permission of ["reader", "editor"] as const) {
  test.skipIf(isServer)(`payload-free live hints assign foreign runs once in one authorized snapshot for ${permission}`, async () => {
    const { client, codeLive, toast } = modules!;
    const data = headActionFixture("schedules", "en");
    if (data.state.kind !== "ready") throw new Error("Expected ready fixture");
    const state = data.state;
    state.permission = permission;
    if (!state.runs) throw new Error("Expected loaded runs");
    state.runs.items = state.runs.items.slice(0, 1);
    state.words = undefined;
    const entries = state.automations!.filter((item) => item.kind === "schedule");
    const ids = ["00000000-0000-4000-8000-999900000010", "00000000-0000-4000-8000-999900000011"];
    let onRun: Parameters<typeof codeLive.followCodeRuns>[1] | undefined;
    let complete: (() => void) | undefined;
    const follow = spyOn(codeLive, "followCodeRuns").mockImplementation((_id, receive) => {
      onRun = receive;
      return () => {};
    });
    const error = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
    const invoke = spyOn(client, "invokeCapabilityWithDataSchema").mockImplementation(async (invocation, schema) => {
      expect(invocation).toMatchObject({
        appId: "core",
        capabilityId: "code.run.list",
        kind: "query",
        input: { codeId: state.code.id, limit: 30 },
      });
      expect(invocation.input).not.toHaveProperty("content");
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return {
        ok: true,
        data: capabilityResultSchema(schema).parse({
          data: {
            items: ids.map((id, index) => ({
              id,
              versionId: state.code.activeVersionId,
              trigger: "schedule",
              entrypoint: entries[index]!.entrypoint,
              state: "queued",
              outcome: null,
              createdAt: "2026-11-14T12:49:00.000Z",
              startedAt: null,
              endedAt: null,
            })),
            nextCursor: null,
          },
        }),
      };
    });
    const page = mount(data);
    const hint = (index: number, value: "queued" | "running" | "succeeded") =>
      onRun!(
        CodeRunEventSchema.parse({
          type: "code.run",
          runId: ids[index],
          state: value,
          at: "2026-11-14T12:49:04.000Z",
        }),
      );
    try {
      hint(0, "queued");
      hint(1, "running");
      await tick();
      await tick();
      expect(invoke).toHaveBeenCalledTimes(1);
      hint(0, "running");
      complete!();
      await tick();
      await tick();
      const rows = () => [...page.dom.root.querySelectorAll(".cloud-code__when .cloud-code__row")];
      expect(rows().filter((row) => row.textContent?.includes("Running now"))).toHaveLength(2);
      hint(0, "succeeded");
      hint(0, "succeeded");
      await tick();
      await tick();
      expect(rows().filter((row) => row.textContent?.includes("Running now"))).toHaveLength(1);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(error).not.toHaveBeenCalled();
    } finally {
      page.dispose();
      follow.mockRestore();
      invoke.mockRestore();
      error.mockRestore();
    }
  });
}

test.skipIf(isServer)("a refused identity snapshot leaves recovery and repeated hints do not repeat the read", async () => {
  const { client, codeLive, toast } = modules!;
  let onRun: Parameters<typeof codeLive.followCodeRuns>[1] | undefined;
  const follow = spyOn(codeLive, "followCodeRuns").mockImplementation((_id, receive) => {
    onRun = receive;
    return () => {};
  });
  const invoke = spyOn(client, "invokeCapabilityWithDataSchema").mockResolvedValue({
    ok: false,
    error: { code: "FORBIDDEN", message: "Hidden", status: 403 },
  });
  const error = spyOn(toast, "error").mockImplementation(() => ({ dismiss: () => {}, update: () => {} }));
  const data = headActionFixture("schedule", "en");
  if (data.state.kind !== "ready" || !data.state.runs) throw new Error("Expected loaded runs");
  data.state.runs.items = data.state.runs.items.slice(0, 1);
  const page = mount(data);
  const hint = CodeRunEventSchema.parse({
    type: "code.run",
    runId: "00000000-0000-4000-8000-999900000012",
    state: "running",
    at: "2026-11-14T12:49:04.000Z",
  });
  try {
    onRun!(hint);
    await tick();
    await tick();
    onRun!(hint);
    await tick();
    await tick();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith("Run updates could not be assigned. Reload to see the current state.", {
      duration: 0,
      action: { label: "Try again", onClick: expect.any(Function) },
    });
  } finally {
    page.dispose();
    follow.mockRestore();
    invoke.mockRestore();
    error.mockRestore();
  }
});
