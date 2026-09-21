import { createArtifactSession } from "./session";

declare global { var runAiScenario: (source: { code: string; runtime: string }, cancel: boolean) => Promise<unknown>; }
globalThis.runAiScenario = async (source, cancel) => {
  const done = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  let output: unknown;
  let aborted = false;
  const session = createArtifactSession(document.body, source, {
    mode: "test",
    ai: async (request, signal) => {
      requested.resolve();
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      const response = await fetch("/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    changed(state) {
      if (state.status === "error") done.reject(new Error(state.error));
      if (state.status === "ready") { output = state.output; done.resolve(); }
    },
  });
  const timeout = setTimeout(() => done.reject(new Error("AI scenario timed out")), 30000);
  try {
    if (cancel) { await requested.promise; await session.stop(); return { aborted, output: session.snapshot().output ?? null }; }
    await done.promise; return output;
  } finally { clearTimeout(timeout); await session.stop(); }
};
