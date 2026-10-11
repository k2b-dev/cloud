import { expect, spyOn, test } from "bun:test";
import { createRoot } from "solid-js";
import { createDomTestHarness } from "../../../ui/test/dom";
import { createArtifactAgentRuntime } from "./agent-runtime";
import { artifactClient } from "./client";
import * as sessions from "./runtime/session";
import type { ViewRef } from "./runtime/views";

test("script view transport carries run identity, keeps the route's error codes and bounds service failures", async () => {
  const dom = createDomTestHarness();
  let dispose = () => {};
  let save: sessions.SessionOptions["view"];
  const session = spyOn(sessions, "createArtifactSession").mockImplementation((_container, _source, options) => {
    save = options.view;
    return {
      snapshot: () => ({ status: "ready", files: [], views: [], logs: [] }),
      files: () => [],
      stop: async () => {},
    };
  });
  const compile = spyOn(artifactClient, "compile").mockResolvedValue({ runtime: "", code: "" });
  const fetch = spyOn(globalThis, "fetch");
  const ref: ViewRef = { path: "/views/result-12345678.view.json", view: "table", title: "Result", rows: 0, columns: 1, footer: false };
  try {
    const runtime = createRoot((cleanup) => {
      dispose = cleanup;
      return createArtifactAgentRuntime(null, undefined, "standalone");
    });
    const run = runtime.code_run;
    if (!run) throw new Error("Missing code_run handler");
    const result = await run({
      name: "code_run",
      args: { code: "export default () => null", inputPaths: [] },
      conversationId: "chat",
      turnId: "turn",
      callId: "run",
    });
    expect(result).toMatchObject({ runId: "run", views: [] });
    if (!save) throw new Error("Missing view service");
    const signal = new AbortController().signal;
    const spec = { view: "table", title: "Result", columns: [{ id: "n", type: "number" }], rows: [] };
    fetch.mockResolvedValue(Response.json(ref));
    expect(await save(spec, 3, signal)).toEqual(ref);
    expect(fetch).toHaveBeenLastCalledWith("/api/assistant/artifacts/runtime/views", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ conversationId: "chat", turnId: "turn", runId: "run", index: 3, view: spec }),
    });
    fetch.mockResolvedValue(Response.json({ message: "View rejected: rows[0].n: Expected a number or null." }, { status: 400 }));
    await expect(save(spec, 3, signal)).rejects.toMatchObject({
      code: "invalid",
      message: "View rejected: rows[0].n: Expected a number or null.",
    });
    // The route's own codes keep their meaning: a full chat is a limit, a foreign file at the path a conflict.
    fetch.mockResolvedValue(Response.json({ code: "STORAGE_FULL", message: "Conversation storage limit exceeded." }, { status: 400 }));
    await expect(save(spec, 3, signal)).rejects.toMatchObject({ code: "limit" });
    fetch.mockResolvedValue(Response.json({ code: "CONFLICT", message: "Destination file already exists." }, { status: 409 }));
    await expect(save(spec, 3, signal)).rejects.toMatchObject({ code: "conflict" });
    fetch.mockResolvedValue(Response.json({ message: "Storage unavailable" }, { status: 503 }));
    await expect(save(spec, 3, signal)).rejects.toMatchObject({ code: "unavailable", message: "Storage unavailable" });
    fetch.mockResolvedValue(Response.json({ path: "/other.json" }));
    await expect(save(spec, 3, signal)).rejects.toMatchObject({
      code: "unavailable",
      message: "The view service returned an invalid reference.",
    });
    fetch.mockResolvedValue(new Response("Not JSON", { status: 502 }));
    await expect(save(spec, 3, signal)).rejects.toMatchObject({ code: "unavailable" });
    fetch.mockRejectedValue(new Error("Network disconnected"));
    await expect(save(spec, 3, signal)).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    dispose();
    fetch.mockRestore();
    compile.mockRestore();
    session.mockRestore();
    dom.cleanup();
  }
});
