import { startArtifactRun } from "./host";
import type { UiNode, RuntimeEvent } from "./protocol";
import { createArtifactSession, type RunSnapshot } from "./session";
import { createArtifactAgentRuntime } from "../agent-runtime";
import { createRoot } from "solid-js";

type Scenario = { source: { code: string; runtime: string }; events?: RuntimeEvent[]; stopAfterMs?: number };
type Observation = { nodes: UiNode[]; output: unknown; errors: string[]; responsive: boolean; stopped: boolean };
declare global { var runArtifactScenario: (scenario: Scenario) => Promise<Observation>; }
declare global { var runArtifactSessionScenario: (source: { code: string; runtime: string }) => Promise<{ state: RunSnapshot; content: string; invalidRejected: boolean }>; }
declare global { var runArtifactAgentScenario: (source: { code: string; runtime: string }) => Promise<unknown[]>; }
declare global { var runArtifactRecoveryScenario: (source: { code: string; runtime: string }) => Promise<{ failed: RunSnapshot; recovered: RunSnapshot }>; }

declare global { var runArtifactCsvScenario: (source: { code: string; runtime: string }) => Promise<{ state: RunSnapshot; content: string }>; }
globalThis.runArtifactCsvScenario = async (source) => {
  const ready = Promise.withResolvers<void>();
  const run = createArtifactSession(document.body, source, {
    mode: "test", inputs: [new File(["name,amount\nAlice,12\nBob,8"], "one.csv"), new File(["name,amount\nAlice,5"], "two.csv")],
    changed: state => { if (state.status === "ready") ready.resolve(); if (state.status === "error") ready.reject(new Error(state.error)); },
    save: async () => { throw new Error("Headless run must not download"); },
  });
  const timer = setTimeout(() => ready.reject(new Error("CSV run timed out")), 10000);
  try { await ready.promise; return { state: run.snapshot(), content: await run.files()[0]!.text() }; }
  finally { clearTimeout(timer); await run.stop(); }
};

globalThis.runArtifactRecoveryScenario = async (source) => {
  const ready = Promise.withResolvers<void>();
  const run = createArtifactSession(document.body, source, {
    mode: "test", changed: (state) => { if (state.status === "ready") ready.resolve(); },
  });
  const timer = setTimeout(() => ready.reject(new Error("Recovery scenario timed out")), 10000);
  try {
    await ready.promise;
    await run.event({ id: "retry" }).catch(() => {});
    const failed = run.snapshot();
    await run.event({ id: "retry" });
    return { failed, recovered: run.snapshot() };
  } finally { clearTimeout(timer); await run.stop(); }
};

globalThis.runArtifactAgentScenario = async (source) => {
  const originalFetch = window.fetch;
  const results = new Map<string, unknown>();
  const id = "00000000-0000-4000-8000-000000000001";
  window.fetch = Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.includes("/runtime/claim")) {
      const body = JSON.parse(String(init?.body));
      return Response.json(results.has(body.callId) ? { status: "done", result: results.get(body.callId) } : { status: "execute" });
    }
    if (path.includes("/runtime/complete")) {
      const body = JSON.parse(String(init?.body)); results.set(body.callId, body.result); return Response.json({ saved: true });
    }
    if (path.includes("/compiled")) return Response.json({ ...source, revision: 1 });
    if (path.includes("/files")) return Response.json({ files: [] });
    if (path.includes("/artifacts/")) return Response.json({ id, title: "Test", revision: 1 });
    return originalFetch(url, init);
  }, { preconnect: originalFetch.preconnect });
  let dispose = () => {};
  const opened: string[] = [];
  const handlers = createRoot((cleanup) => { dispose = cleanup; return createArtifactAgentRuntime((tab) => opened.push(tab.key)); });
  const call = (name: string, callId: string, args: unknown) => handlers[name]!({ name, callId, args, turnId: id, conversationId: id });
  try {
    const start = await call("code_run", "start", { id });
    const pending = await call("code_interact", "click", { runId: "start", id: "add" });
    const answer = await call("code_interact", "answer", { runId: "start", id: "@modal:1", value: "Example" });
    const duplicate = await call("code_interact", "answer", { runId: "start", id: "@modal:1", value: "Example" });
    const secondAnswer = await call("code_interact", "second-answer", { runId: "start", id: "@modal:2", value: true });
    const current = await call("code_inspect", "inspect", { runId: "start", nodeId: "tasks" });
    const stop = await call("code_stop", "stop", { runId: "start" });
    await call("code_open", "open", { id });
    return [start, pending, answer, duplicate, current, stop, opened, secondAnswer];
  } finally { dispose(); window.fetch = originalFetch; }
};

globalThis.runArtifactSessionScenario = async (source) => {
  const ready = Promise.withResolvers<void>();
  let invalidRejected = false;
  const run = createArtifactSession(document.body, source, {
    mode: "test", inputs: [new File(["name\nAlice"], "input.csv", { type: "text/csv" })],
    changed: (state) => {
      if (state.status === "error") ready.reject(new Error(state.error));
      if (state.status === "ready") ready.resolve();
      if (state.modal) queueMicrotask(() => {
        try { run.respond({ count: -1 }); } catch { invalidRejected = true; }
        run.respond({ count: 3 });
      });
    },
    storage: async () => { throw new Error("Test run touched persistent storage"); },
    pick: async () => { throw new Error("Test run opened a user file picker"); },
    save: async () => { throw new Error("Test run downloaded a user file"); },
  });
  const timer = setTimeout(() => ready.reject(new Error("Session scenario timed out")), 10000);
  try {
    await ready.promise;
    return { state: run.snapshot(), content: await run.files()[0]!.text(), invalidRejected };
  } finally { clearTimeout(timer); await run.stop(); }
};

globalThis.runArtifactScenario = async (scenario) => {
  let nodes: UiNode[] = [], output: unknown = null, responsive = false;
  const errors: string[] = [];
  const ready = Promise.withResolvers<void>();
  const run = startArtifactRun(document.body,scenario.source,{
    ui: (value) => { nodes = value; }, output: (value) => { output = value; },
    log: () => {}, busy: () => {}, ready: () => ready.resolve(),
    error: (error) => { errors.push(error); ready.resolve(); },
    request: async () => { throw new Error("No host effects configured for this test"); },
  });
  const watchdog = setTimeout(() => ready.reject(new Error("Browser scenario timed out")),10000);
  try {
    if (scenario.stopAfterMs !== undefined) {
      await new Promise<void>((resolve) => setTimeout(() => { responsive = true; resolve(); },scenario.stopAfterMs));
    } else {
      await ready.promise;
      for (const event of scenario.events ?? []) { await run.event(event); await new Promise((resolve) => setTimeout(resolve,10)); }
      responsive = true;
    }
  } finally { clearTimeout(watchdog); await run.stop(); }
  return { nodes,output,errors,responsive,stopped: run.stopped };
};
