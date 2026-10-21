import { Button, ResizeSeparator } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { DemoCard } from "../DemoCard";

export function ResizeSeparatorDemo() {
  const [width, setWidth] = createSignal(240);
  const [open, setOpen] = createSignal(true);
  const [closing, setClosing] = createSignal(false);
  return (
    <DemoCard
      id="resize-separator"
      chip={[{ kind: "component", name: "ResizeSeparator", from: "@k2b/ui" }]}
      description="Drag or use the arrow keys. Double-click to reset. Drag below 120 px and release to close the inspector."
      code={
        '<ResizeSeparator label="Resize inspector" orientation="vertical" min={160} max={360} value={width()} grow="start" onResize={setWidth} onReset={() => setWidth(240)} />'
      }
    >
      <div style={{ display: "flex", height: "180px", overflow: "hidden", background: "var(--k2b-surface-muted)" }}>
        <div style={{ flex: "1", "min-width": "0", padding: "1rem" }}>
          Workspace
          <Show when={!open()}>
            <Button onClick={() => setOpen(true)}>Open inspector</Button>
          </Show>
        </div>
        <Show when={open()}>
          <ResizeSeparator
            label="Resize inspector"
            orientation="vertical"
            controls="demo-resize-inspector"
            min={160}
            max={360}
            value={width()}
            grow="start"
            collapseBelow={120}
            onResize={setWidth}
            onReset={() => setWidth(240)}
            onCollapseIntent={setClosing}
            onCollapse={() => setOpen(false)}
          />
          <div
            id="demo-resize-inspector"
            style={{ width: `${width()}px`, "flex-shrink": "0", padding: "1rem", background: "var(--k2b-surface)" }}
          >
            {closing() ? "Release to close" : `Inspector · ${width()} px`}
          </div>
        </Show>
      </div>
    </DemoCard>
  );
}
