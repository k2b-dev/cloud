import { createArtifactSession } from "./session";
import { encodePdfRequest } from "../pdf-contracts";

declare global { var runPdfScenario: (source: { code: string; runtime: string }) => Promise<unknown>; }
globalThis.runPdfScenario = async source => {
  const ready = Promise.withResolvers<void>();
  let output: unknown;
  const session = createArtifactSession(document.body, source, {
    mode: "test",
    pdf: async (request, signal) => {
      const response = await fetch("/pdf", { method: "POST", body: encodePdfRequest(request), signal });
      if (!response.ok) throw new Error(await response.text());
      return response.blob();
    },
    changed(state) {
      if (state.status === "error") ready.reject(new Error(state.error));
      if (state.status === "ready") { output = state.output; ready.resolve(); }
    },
  });
  const timeout = setTimeout(() => ready.reject(new Error("PDF scenario timed out")), 45000);
  try { await ready.promise; return output; }
  finally { clearTimeout(timeout); await session.stop(); }
};
