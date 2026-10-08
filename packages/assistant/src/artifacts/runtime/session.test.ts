import { expect, spyOn, test } from "bun:test";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { LIMITS } from "../contracts";
import * as host from "./host";
import { createArtifactSession } from "./session";

function session() {
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
