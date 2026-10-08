import { createRoot } from "solid-js";
import { createArtifactAgentRuntime } from "../agent-runtime";
import { CloudError } from "./errors";
import { startArtifactRun } from "./host";
import { createArtifactSession, type RunSnapshot } from "./session";

type Scenario = { source: { code: string; runtime: string }; stopAfterMs?: number };
type Observation = { output: unknown; errors: string[]; responsive: boolean; stopped: boolean };
declare global {
  var runArtifactScenario: (scenario: Scenario) => Promise<Observation>;
}
declare global {
  var runArtifactSessionScenario: (source: { code: string; runtime: string }) => Promise<{ state: RunSnapshot; content: string }>;
}
declare global {
  var runArtifactAgentScenario: (source: { code: string; runtime: string }) => Promise<unknown[]>;
}

declare global {
  var runArtifactCsvScenario: (source: { code: string; runtime: string }) => Promise<{ state: RunSnapshot; content: string }>;
}
globalThis.runArtifactCsvScenario = async (source) => {
  const ready = Promise.withResolvers<void>();
  const run = createArtifactSession(document.body, source, {
    inputs: [new File(["name,amount\nAlice,12\nBob,8"], "one.csv"), new File(["name,amount\nAlice,5"], "two.csv")],
    changed: (state) => {
      if (state.status === "ready") ready.resolve();
      if (state.status === "error") ready.reject(new Error(state.error));
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

globalThis.runArtifactAgentScenario = async (source) => {
  const originalFetch = window.fetch;
  const results = new Map<string, unknown>();
  const posted: unknown[] = [];
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
      if (path.endsWith("/presentations")) {
        posted.push(JSON.parse(String(init?.body)));
        return Response.json({ presentationId: crypto.randomUUID(), title: "Overview" });
      }
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
    const current = await call("code_inspect", "inspect", { runId: "start", waitMs: 2000 });
    const stop = await call("code_stop", "stop", { runId: "start" });
    await call("code_open", "open", { id });
    const rejected = await call("code_present", "broken", {
      title: "Broken",
      files: [{ path: "index.html", content: '<h1 onclick="go()">Hi</h1><script src="https://cdn.example.com/x.js"></script>' }],
    });
    const presented = await call("code_present", "present", {
      title: "Overview",
      files: [
        { path: "index.html", content: "<h1>Overview</h1>" },
        { path: "app.js", content: "console.log(cloud.locale);" },
      ],
    });
    return [start, current, stop, opened, rejected, presented, posted];
  } finally {
    dispose();
    window.fetch = originalFetch;
  }
};

globalThis.runArtifactSessionScenario = async (source) => {
  const personal = new Map<string, unknown>();
  const ready = Promise.withResolvers<void>();
  const run = createArtifactSession(document.body, source, {
    inputs: [new File(["name\nAlice"], "input.csv", { type: "text/csv" })],
    changed: (state) => {
      if (state.status === "error") ready.reject(new Error(state.error));
      if (state.status === "ready") ready.resolve();
    },
    storage: async (request) => {
      if (request.scope !== "user") throw new Error("Wrong scope");
      if (request.operation === "write") {
        personal.set(request.key!, request.value);
        return null;
      }
      return personal.get(request.key!) ?? null;
    },
  });
  const timer = setTimeout(() => ready.reject(new Error("Session scenario timed out")), 10000);
  try {
    await ready.promise;
    return { state: run.snapshot(), content: await run.files()[0]!.text() };
  } finally {
    clearTimeout(timer);
    await run.stop();
  }
};

globalThis.runArtifactScenario = async (scenario) => {
  let output: unknown = null,
    responsive = false;
  const errors: string[] = [];
  const ready = Promise.withResolvers<void>();
  const run = startArtifactRun(document.body, scenario.source, {
    output: (value) => {
      output = value;
    },
    log: () => {},
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
      responsive = true;
    }
  } finally {
    clearTimeout(watchdog);
    await run.stop();
  }
  return { output, errors, responsive, stopped: run.stopped };
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
  const first = createArtifactSession(document.body, source, { changed: () => {} });
  let second: ReturnType<typeof createArtifactSession> | undefined;
  try {
    await wait(() => first.snapshot().status === "ready" || first.snapshot().status === "error");
    const finished = first.snapshot();
    second = createArtifactSession(document.body, source, { changed: () => {} });
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
