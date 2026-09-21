import { createMemo, ErrorBoundary, For, type JSX, onMount } from "solid-js";
import { AnalyticsView, createAnalyticsCursors } from "./AnalyticsView";
import type { RuntimeEvent, UiNode } from "./runtime/protocol";

export function RuntimeView(props: { nodes: UiNode[]; busy: boolean; event: (event: RuntimeEvent) => void }) {
  const cursor = createAnalyticsCursors();
  const by = createMemo(() => new Map(props.nodes.map((node) => [node.id, node])));
  const roots = createMemo(() => {
    const children = new Set(props.nodes.flatMap((node) => (node.type === "layout" ? node.children : [])));
    return props.nodes.filter((node) => !children.has(node.id));
  });
  function Children(p: { ids: string[] }) {
    return <For each={p.ids}>{(id) => <NodeView id={id} />}</For>;
  }
  function Failure(p: { id: string; error: unknown }) {
    const message = () => (p.error instanceof Error ? p.error.message : "Invalid UI data");
    onMount(() => props.event({ id: p.id, event: { type: "renderError", message: message().slice(0, 16000) } }));
    return <p role="alert">{message()}</p>;
  }
  function NodeView(p: { id: string }): JSX.Element {
    const node = () => by().get(p.id)!;
    return (
      <div data-artifact-id={p.id} class={`artifact-node artifact-node-${node().type}`}>
        <ErrorBoundary fallback={(error) => <Failure id={p.id} error={error} />}>
          <AnalyticsView
            node={node()}
            busy={props.busy}
            cursor={cursor}
            event={(event) => props.event({ id: p.id, event })}
            children={(ids) => <Children ids={ids()} />}
          />
        </ErrorBoundary>
      </div>
    );
  }
  return (
    <div class="artifact-runtime-root">
      <Children ids={roots().map((node) => node.id)} />
    </div>
  );
}
