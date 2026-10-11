import { expect, spyOn, test } from "bun:test";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { LIMITS } from "../contracts";
import * as host from "./host";
import { createArtifactSession, type SessionOptions } from "./session";

function session(options: Partial<SessionOptions> = {}) {
  const dom = createDomTestHarness();
  let hooks: host.RuntimeHooks | undefined;
  const start = spyOn(host, "startArtifactRun").mockImplementation((_container, _source, value) => {
    hooks = value;
    return { stop: async () => {}, stopped: false };
  });
  // The mocked host owns the container; requests exercise the real session boundary.
  const run = createArtifactSession(
    dom.root,
    { runtime: "", code: "" },
    {
      ...options,
      changed() {},
      inputFiles: [{ name: "missing.csv", size: 1, type: "text/csv" }],
      readInput: async () => {
        throw new Error("Unexpected read");
      },
    },
  );
  const request = (method: string, args: unknown[]) => {
    if (!hooks) throw new Error("Host not initialized");
    return hooks.request(method, args, new AbortController().signal);
  };
  return {
    run,
    request,
    hooks: () => hooks,
    cleanup: async () => {
      await run.stop();
      start.mockRestore();
      dom.cleanup();
    },
  };
}

test("session host rejects invalid download names with the documented rule", async () => {
  const fixture = session();
  try {
    for (const name of ["", "a".repeat(181), "dir/file", "dir\\file", "nul\0file"]) {
      await expect(fixture.request("file.save", ["content", name])).rejects.toMatchObject({
        code: "invalid",
        message: expect.stringContaining("1-180 characters"),
      });
    }
  } finally {
    await fixture.cleanup();
  }
});

test("session host preserves output limits and missing input/hook errors", async () => {
  const fixture = session();
  try {
    await expect(fixture.request("file.read", ["unknown.csv"])).rejects.toMatchObject({ code: "not_found" });
    for (const method of ["database", "storage"]) {
      await expect(fixture.request(method, [{ scope: "shared", area: "kv", operation: "list" }])).rejects.toMatchObject({
        code: "unavailable",
        message: expect.stringContaining("requires a saved app or script"),
      });
    }
    for (let index = 0; index < LIMITS.files; index++) await fixture.request("file.save", ["small", `${index}.txt`]);
    await expect(fixture.request("file.save", ["small", "overflow.txt"])).rejects.toMatchObject({ code: "limit" });
  } finally {
    await fixture.cleanup();
  }
});

test("session host reports a manifest input whose bytes are missing as not_found", async () => {
  const dom = createDomTestHarness();
  let hooks: host.RuntimeHooks | undefined;
  const start = spyOn(host, "startArtifactRun").mockImplementation((_container, _source, value) => {
    hooks = value;
    return { stop: async () => {}, stopped: false };
  });
  const run = createArtifactSession(
    dom.root,
    { runtime: "", code: "" },
    { changed() {}, inputFiles: [{ name: "missing.csv", size: 1, type: "text/csv" }] },
  );
  try {
    if (!hooks) throw new Error("Host not initialized");
    await expect(hooks.request("file.read", ["missing.csv"], new AbortController().signal)).rejects.toMatchObject({ code: "not_found" });
    await expect(hooks.request("ui.modal", [{ title: "Gone" }], new AbortController().signal)).rejects.toMatchObject({ code: "invalid" });
  } finally {
    await run.stop();
    start.mockRestore();
    dom.cleanup();
  }
});

test("views require a chat service and start empty", async () => {
  const fixture = session();
  try {
    expect(fixture.run.snapshot().views).toEqual([]);
    await expect(fixture.request("view.save", [{}])).rejects.toMatchObject({
      code: "unavailable",
      message: "Views need a code_run in a chat.",
    });
  } finally {
    await fixture.cleanup();
  }
});

test("parallel views reserve distinct indexes and share the output budget with downloads", async () => {
  const indexes: number[] = [];
  const pending: (() => void)[] = [];
  const fixture = session({
    view: async (_spec, index) => {
      indexes.push(index);
      await new Promise<void>((resolve) => pending.push(resolve));
      return { path: `/views/table-${index}.view.json`, view: "table", title: "Rows", rows: 0, columns: 1, footer: false };
    },
  });
  try {
    for (let i = 0; i < 62; i++) await fixture.request("file.save", ["small", `${i}.txt`]);
    const first = fixture.request("view.save", [{}]),
      second = fixture.request("view.save", [{}]);
    expect(indexes).toEqual([0, 1]);
    expect(fixture.run.snapshot().inputPending).toBe(true);
    await expect(fixture.request("view.save", [{}])).rejects.toMatchObject({
      code: "limit",
      message: "A run keeps at most 64 output files and views.",
    });
    await expect(fixture.request("file.save", ["small", "overflow.txt"])).rejects.toMatchObject({
      code: "limit",
      message: "A run keeps at most 64 output files and views.",
    });
    await fixture.request("file.save", ["replacement", "0.txt"]);
    pending[1]!();
    await second;
    pending[0]!();
    await first;
    expect(fixture.run.snapshot().views.map((view) => view.path)).toEqual(["/views/table-1.view.json", "/views/table-0.view.json"]);
    expect(fixture.run.snapshot().inputPending).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

test("run snapshots retain stats and details summaries without their values", async () => {
  const { checkCloudAiView, cloudAiViewSummary } = await import("@k2b/cloud/ai/browser");
  const { ViewRefSchema } = await import("./views");
  const fixture = session({
    view: async (spec, index) => {
      const checked = checkCloudAiView(spec);
      if ("issues" in checked) throw new Error(checked.issues.join("; "));
      return { path: `/views/w1-${index}.view.json`, ...cloudAiViewSummary(checked.view) };
    },
  });
  try {
    const stats = await fixture.request("view.save", [
      { view: "stats", title: "Overview", items: [{ label: "Count", value: 12, delta: 0, sub: "Month", sparkline: [10, 12] }] },
    ]);
    const details = await fixture.request("view.save", [
      { view: "details", title: "Record", items: [{ label: "Amount", type: "number", value: 12 }] },
    ]);
    expect(fixture.run.snapshot().views).toEqual([ViewRefSchema.parse(stats), ViewRefSchema.parse(details)]);
    expect(stats).toEqual({
      path: "/views/w1-0.view.json",
      view: "stats",
      title: "Overview",
      items: [{ label: "Count", sparkline: true, sub: true, delta: true }],
    });
    expect(details).toEqual({ path: "/views/w1-1.view.json", view: "details", title: "Record", items: 1 });
  } finally {
    await fixture.cleanup();
  }
});
