import { createRoot } from "solid-js";
import { createArtifactAgentRuntime } from "../agent-runtime";
import { CloudError } from "./errors";
import { startArtifactRun } from "./host";
import type { RuntimeEvent, UiNode } from "./protocol";
import { createArtifactSession, type RunSnapshot } from "./session";

type Scenario = { source: { code: string; runtime: string }; events?: RuntimeEvent[]; stopAfterMs?: number };
type Observation = { nodes: UiNode[]; output: unknown; errors: string[]; responsive: boolean; stopped: boolean };
declare global {
  var runArtifactScenario: (scenario: Scenario) => Promise<Observation>;
}
declare global {
  var runArtifactSessionScenario: (source: {
    code: string;
    runtime: string;
  }) => Promise<{ state: RunSnapshot; content: string; invalidRejected: boolean }>;
}
declare global {
  var runArtifactAgentScenario: (source: { code: string; runtime: string }) => Promise<unknown[]>;
}
declare global {
  var runArtifactRecoveryScenario: (source: { code: string; runtime: string }) => Promise<{ failed: RunSnapshot; recovered: RunSnapshot }>;
}

declare global {
  var runArtifactCsvScenario: (source: { code: string; runtime: string }) => Promise<{ state: RunSnapshot; content: string }>;
}
globalThis.runArtifactCsvScenario = async (source) => {
  const ready = Promise.withResolvers<void>();
  const run = createArtifactSession(document.body, source, {
    mode: "test",
    inputs: [new File(["name,amount\nAlice,12\nBob,8"], "one.csv"), new File(["name,amount\nAlice,5"], "two.csv")],
    changed: (state) => {
      if (state.status === "ready") ready.resolve();
      if (state.status === "error") ready.reject(new Error(state.error));
    },
    save: async () => {
      throw new Error("Headless run must not download");
    },
  });
  const timer = setTimeout(() => ready.reject(new Error("CSV run timed out")), 10000);
  try {
    await ready.promise;
    return { state: run.snapshot(), content: await run.files()[0]!.text() };
  } finally {
    clearTimeout(timer);
    await run.stop();
  }
};

globalThis.runArtifactRecoveryScenario = async (source) => {
  const ready = Promise.withResolvers<void>();
  const run = createArtifactSession(document.body, source, {
    mode: "test",
    changed: (state) => {
      if (state.status === "ready") ready.resolve();
    },
  });
  const timer = setTimeout(() => ready.reject(new Error("Recovery scenario timed out")), 10000);
  try {
    await ready.promise;
    await run.event({ id: "retry" }).catch(() => {});
    const failed = run.snapshot();
    await run.event({ id: "retry" });
    return { failed, recovered: run.snapshot() };
  } finally {
    clearTimeout(timer);
    await run.stop();
  }
};

globalThis.runArtifactAgentScenario = async (source) => {
  const originalFetch = window.fetch;
  const results = new Map<string, unknown>();
  const id = "aBc234";
  window.fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.includes("/runtime/claim")) {
        const body = JSON.parse(String(init?.body));
        return Response.json(results.has(body.callId) ? { status: "done", result: results.get(body.callId) } : { status: "execute" });
      }
      if (path.includes("/runtime/complete")) {
        const body = JSON.parse(String(init?.body));
        results.set(body.callId, body.result);
        return Response.json({ saved: true });
      }
      if (path.includes("/compiled")) return Response.json({ ...source, revision: 1 });
      if (path.includes("/files")) return Response.json({ files: [] });
      if (path.includes("/artifacts/")) return Response.json({ kind: "app", id, title: "Test", revision: 1 });
      return originalFetch(url, init);
    },
    { preconnect: originalFetch.preconnect },
  );
  let dispose = () => {};
  const opened: string[] = [];
  const handlers = createRoot((cleanup) => {
    dispose = cleanup;
    return createArtifactAgentRuntime((tab) => opened.push(tab.key));
  });
  const call = (name: string, callId: string, args: unknown) => handlers[name]!({ name, callId, args, turnId: id, conversationId: id });
  try {
    const start = await call("code_run", "start", { id });
    const pending = await call("code_interact", "click", { runId: "start", id: "add" });
    const answer = await call("code_interact", "answer", { runId: "start", id: "@modal:1", answer: "Example" });
    const duplicate = await call("code_interact", "answer", { runId: "start", id: "@modal:1", answer: "Example" });
    const secondAnswer = await call("code_interact", "second-answer", { runId: "start", id: "@modal:2", answer: true });
    const current = await call("code_inspect", "inspect", { runId: "start", nodeId: "tasks" });
    const stop = await call("code_stop", "stop", { runId: "start" });
    await call("code_open", "open", { id });
    return [start, pending, answer, duplicate, current, stop, opened, secondAnswer];
  } finally {
    dispose();
    window.fetch = originalFetch;
  }
};

globalThis.runArtifactSessionScenario = async (source) => {
  const personal = new Map<string, unknown>();
  const ready = Promise.withResolvers<void>();
  let invalidRejected = false;
  const run = createArtifactSession(document.body, source, {
    mode: "test",
    inputs: [new File(["name\nAlice"], "input.csv", { type: "text/csv" })],
    changed: (state) => {
      if (state.status === "error") ready.reject(new Error(state.error));
      if (state.status === "ready") ready.resolve();
      if (state.modal)
        queueMicrotask(() => {
          try {
            run.respond({ count: -1 });
          } catch {
            invalidRejected = true;
          }
          run.respond({ count: 3 });
        });
    },
    storage: async (_method, args) => {
      const { RuntimeStorage } = await import("./shared-storage");
      const request = RuntimeStorage.parse(args[0]);
      if (request.scope !== "user") throw new Error("Wrong scope");
      if (request.operation === "write") {
        personal.set(request.key!, request.value);
        return null;
      }
      return personal.get(request.key!) ?? null;
    },
    pick: async () => {
      throw new Error("Test run opened a user file picker");
    },
    save: async () => {
      throw new Error("Test run downloaded a user file");
    },
  });
  const timer = setTimeout(() => ready.reject(new Error("Session scenario timed out")), 10000);
  try {
    await ready.promise;
    return { state: run.snapshot(), content: await run.files()[0]!.text(), invalidRejected };
  } finally {
    clearTimeout(timer);
    await run.stop();
  }
};

globalThis.runArtifactScenario = async (scenario) => {
  let nodes: UiNode[] = [],
    output: unknown = null,
    responsive = false;
  const errors: string[] = [];
  const ready = Promise.withResolvers<void>();
  const run = startArtifactRun(document.body, scenario.source, {
    ui: (value) => {
      nodes = value;
    },
    output: (value) => {
      output = value;
    },
    log: () => {},
    busy: () => {},
    ready: () => ready.resolve(),
    error: (error) => {
      errors.push(error);
      ready.resolve();
    },
    request: async (method, args) => {
      if (method === "runtime.chunk") {
        const response = await fetch(`/api/assistant/artifacts/runtime/chunks/${args[0]}`);
        if (!response.ok || !/^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i.test(response.headers.get("content-type") ?? ""))
          throw new CloudError("unavailable", "The runtime library did not return JavaScript; check the runtime assets.");
        return response.text();
      }
      throw new Error("No host effects configured for this test");
    },
  });
  const watchdog = setTimeout(() => ready.reject(new Error("Browser scenario timed out")), 10000);
  try {
    if (scenario.stopAfterMs !== undefined) {
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          responsive = true;
          resolve();
        }, scenario.stopAfterMs),
      );
    } else {
      await ready.promise;
      for (const event of scenario.events ?? []) {
        await run.event(event);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      responsive = true;
    }
  } finally {
    clearTimeout(watchdog);
    await run.stop();
  }
  return { nodes, output, errors, responsive, stopped: run.stopped };
};

declare global {
  var runArtifactFolderScenario: (source: { code: string; runtime: string }, mode: "user" | "test") => Promise<RunSnapshot>;
}
globalThis.runArtifactFolderScenario = async (source, mode) => {
  const ready = Promise.withResolvers<void>();
  const files = Array.from({ length: 3000 }, (_, index) => {
    const file = new File(["x".repeat(8192)], `folder-${index}/ledger.csv`);
    Object.defineProperty(file, "webkitRelativePath", { value: `folder-${index}/ledger.csv` });
    return file;
  });
  const run = createArtifactSession(document.body, source, {
    mode,
    inputs: [],
    pickerInputs: files,
    pick: async () => files,
    save: async () => {},
    changed: (state) => {
      if (state.status === "ready") ready.resolve();
      if (state.status === "error") ready.reject(new Error(state.error));
    },
  });
  const timer = setTimeout(() => ready.reject(new Error("Folder scenario timed out")), 20000);
  try {
    await ready.promise;
    await run.event({ id: "pick" });
    const state = run.snapshot();
    const result = state.nodes.find((node) => node.id === "result");
    if (result?.type !== "text") throw new Error("Missing selection result");
    return { ...state, output: JSON.parse(result.value) };
  } finally {
    clearTimeout(timer);
    await run.stop();
  }
};

declare global {
  var runArtifactWorkScenario: (source: { code: string; runtime: string }) => Promise<{ finished: RunSnapshot; cancelled: RunSnapshot }>;
}
globalThis.runArtifactWorkScenario = async (source) => {
  const wait = async (check: () => boolean) => {
    const deadline = Date.now() + 22000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("Progress scenario timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const first = createArtifactSession(document.body, source, { mode: "test", changed: () => {} });
  let second: ReturnType<typeof createArtifactSession> | undefined;
  try {
    await wait(() => first.snapshot().status === "ready" || first.snapshot().status === "error");
    const finished = first.snapshot();
    second = createArtifactSession(document.body, source, { mode: "test", changed: () => {} });
    await wait(() => second!.snapshot().work?.status === "running");
    await second.stop();
    return { finished, cancelled: second.snapshot() };
  } finally {
    await first.stop();
    await second?.stop();
  }
};

declare global {
  var runArtifactStoragePages: () => Promise<{ counts: number[]; unique: number; first: string; last: string }>;
}
globalThis.runArtifactStoragePages = async () => {
  const { sharedStorage, RuntimeStorage } = await import("./shared-storage");
  const original = window.fetch;
  const keys = Array.from({ length: 1005 }, (_, i) => `file-${String(i).padStart(5, "0")}.txt`);
  window.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      return Response.json({
        items: keys
          .filter((key) => key > request.after)
          .slice(0, request.limit)
          .map((key) => ({ key })),
      });
    },
    { preconnect: fetch.preconnect },
  );
  try {
    const collected: string[] = [],
      counts: number[] = [];
    let after = "";
    for (;;) {
      const page = await sharedStorage(
        "fixture-resource",
        RuntimeStorage.parse({ scope: "shared", area: "files", operation: "list", after, limit: 500 }),
      );
      if (!Array.isArray(page)) throw new Error("Invalid storage page");
      const values = page.map(String);
      counts.push(values.length);
      collected.push(...values);
      if (values.length < 500) break;
      after = values.at(-1)!;
    }
    return { counts, unique: new Set(collected).size, first: collected[0]!, last: collected.at(-1)! };
  } finally {
    window.fetch = original;
  }
};

declare global {
  var prepareLocalScriptPicker: (source: { runtime: string; code: string }) => void;
  var localScriptPickerResult: RunSnapshot | undefined;
}
globalThis.prepareLocalScriptPicker = (source) => {
  const button = document.createElement("button");
  button.id = "start-local-script";
  button.textContent = "Start script";
  button.onclick = async () => {
    const { pickFiles } = await import("../ArtifactPanel");
    let picked = false;
    const run = createArtifactSession(document.body, source, {
      mode: "user",
      pick: pickFiles,
      changed: (state) => {
        globalThis.localScriptPickerResult = state;
        if (!picked && state.status === "ready") {
          picked = true;
          queueMicrotask(() => void run.event({ id: "pick" }));
        }
      },
    });
    // Host cleanup is the page lifetime in this focused picker scenario.
  };
  document.body.append(button);
};
