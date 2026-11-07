import type { Mermaid, MermaidConfig } from "mermaid";

let pending = Promise.resolve();

/** Mermaid reads global config during rendering, so configure and render as one queued operation. */
export function renderMermaid(
  mermaid: Pick<Mermaid, "initialize" | "render">,
  config: MermaidConfig,
  id: string,
  source: string,
  container?: Element,
) {
  const result = pending.then(() => {
    mermaid.initialize(config);
    return mermaid.render(id, source, container);
  });
  pending = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
