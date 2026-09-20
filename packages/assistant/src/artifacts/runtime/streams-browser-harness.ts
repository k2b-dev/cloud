import type { RunSnapshot } from "./session";
import { createArtifactSession } from "./session";

declare global {
  var runStreamScenario: (source: { code: string; runtime: string }) => Promise<{ state: RunSnapshot; uploaded: number }>;
}
globalThis.runStreamScenario = async (source) => {
  const complete = Promise.withResolvers<void>();
  let uploaded = 0;
  const bytes = new Uint8Array(5 * 1024 * 1024).fill(42);
  const original = window.fetch;
  window.fetch = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith("/read")) return new Response(bytes);
      if (String(url).endsWith("/write")) {
        uploaded = (await new Response(init?.body).arrayBuffer()).byteLength;
        return Response.json({ data: { saved: true } });
      }
      return Response.json({ state: "completed", result: { data: { saved: true } } });
    },
    { preconnect: original.preconnect },
  );
  const run = createArtifactSession(document.body, source, {
    mode: "test",
    capability: async (name) => ({
      data: {},
      stream: {
        id: name,
        callId: crypto.randomUUID(),
        direction: name.endsWith("read") ? "read" : "write",
        mediaType: "application/octet-stream",
        size: bytes.length,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
    changed: (state) => {
      if (state.status === "ready") complete.resolve();
      if (state.status === "error") complete.reject(new Error(state.error));
    },
  });
  try {
    await complete.promise;
    return { state: run.snapshot(), uploaded };
  } finally {
    await run.stop();
    window.fetch = original;
  }
};
