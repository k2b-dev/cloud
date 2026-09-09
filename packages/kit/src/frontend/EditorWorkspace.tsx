import { Button, MarkdownEditor, Panes, type PanesLayout, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createRoot, createSignal, getOwner, type JSX, onCleanup } from "solid-js";
import { Editor } from "./Editor";
import { messages } from "./messages";
export function EditorWorkspace(props: {
  files: {
    path: string;
    content: string;
  }[];
  selected: string;
  onSelect: (path: string) => void;
  onChange: (path: string, content: string) => void;
  onSave: () => void;
  onAdd: (entry?: boolean) => void;
  preview: () => JSX.Element;
  previews: {
    path: string;
    name: string;
  }[];
  selectedPreview: string;
  onPreviewSelect: (path: string) => Promise<boolean>;
}) {
  const locale = useLocale(),
    t = () => messages.resolve([locale()]).t;
  const [ratio, setRatio] = createSignal(0.55);
  const [mobile, setMobile] = createSignal("code");
  const owner = getOwner();
  const ids = new Map<string, string>();
  const fileId = (path: string) => {
    if (!ids.has(path)) ids.set(path, `file-${ids.size}`);
    return ids.get(path)!;
  };
  // Kit owns editor sessions. Panes may unmount its active content without destroying the textarea's undo history.
  const sessions = new Map<
    string,
    {
      element: JSX.Element;
      dispose: () => void;
    }
  >();
  function editor(path: string) {
    let session = sessions.get(path);
    if (!session) {
      session = createRoot(
        (dispose) => ({
          dispose,
          element: path.endsWith(".md") ? (
            <div class="kit-code">
              <MarkdownEditor
                aria-label={path}
                value={() => props.files.find((file) => file.path === path)?.content ?? ""}
                onValueChange={(content) => props.onChange(path, content)}
                onSave={props.onSave}
                fill
                showStats={false}
                variant="paper"
              />
            </div>
          ) : (
            <Editor
              path={path}
              content={props.files.find((file) => file.path === path)?.content ?? ""}
              onChange={(content) => props.onChange(path, content)}
              onSave={props.onSave}
            />
          ),
        }),
        owner,
      );
      sessions.set(path, session);
    }
    return session.element;
  }
  createEffect(() => {
    const paths = new Set(props.files.map((file) => file.path));
    for (const [path, session] of sessions)
      if (!paths.has(path)) {
        session.dispose();
        sessions.delete(path);
      }
  });
  onCleanup(() => {
    for (const session of sessions.values()) session.dispose();
  });
  const view = createMemo(() => {
    const fileIds = props.files.map((file) => fileId(file.path));
    const previewIds = props.previews.map((entry) => `preview-${fileId(entry.path)}`);
    const items = [
      ...props.files.map((file) => ({
        id: fileId(file.path),
        title: file.path,
        icon: file.path.endsWith(".md") ? "ti ti-file-text" : "ti ti-file-code",
        render: () => editor(file.path),
      })),
      ...props.previews.map((entry) => ({
        id: `preview-${fileId(entry.path)}`,
        title: entry.name,
        icon: entry.path.endsWith(".md") ? "ti ti-file-text" : "ti ti-player-play",
        render: props.preview,
      })),
    ];
    const fileActive = fileIds.includes(fileId(props.selected)) ? fileId(props.selected) : fileIds[0]!;
    const previewActive = previewIds.includes(`preview-${fileId(props.selectedPreview)}`)
      ? `preview-${fileId(props.selectedPreview)}`
      : previewIds[0]!;
    const left = fileIds.length ? { type: "group" as const, items: fileIds, active: fileActive } : null;
    const right = previewIds.length ? { type: "group" as const, items: previewIds, active: previewActive } : null;
    const layout: PanesLayout = {
      version: 2,
      root: left && right ? { type: "split", direction: "horizontal", ratio: ratio(), first: left, second: right } : (left ?? right),
    };
    return { items, layout };
  });
  return (
    <div class="kit-editor-workspace" data-mobile={mobile()}>
      <div role="group" class="kit-editor-mobile-tabs" aria-label={t().workspace}>
        <Button variant="ghost" aria-pressed={mobile() === "code"} onClick={() => setMobile("code")}>
          {t().code}
        </Button>
        <Button variant="ghost" aria-pressed={mobile() === "preview"} onClick={() => setMobile("preview")}>
          {t().preview}
        </Button>
      </div>
      <Panes
        class="kit-editor-panes"
        ariaLabel={t().workspace}
        layout={view().layout}
        items={view().items}
        split={false}
        movable={false}
        onAddItem={(id) => props.onAdd(id?.startsWith("preview-") ?? false)}
        onLayoutChange={async (next) => {
          const root = next.root;
          if (root?.type !== "split" || root.first.type !== "group" || root.second.type !== "group") return;
          const rightActive = root.second.active,
            leftActive = root.first.active;
          const selected = props.previews.find((entry) => `preview-${fileId(entry.path)}` === rightActive)?.path;
          if (!selected) return;
          if (selected !== props.selectedPreview && !(await props.onPreviewSelect(selected))) return;
          setRatio(root.ratio);
          const path = props.files.find((file) => fileId(file.path) === leftActive)?.path;
          if (path) props.onSelect(path);
        }}
      />
    </div>
  );
}
