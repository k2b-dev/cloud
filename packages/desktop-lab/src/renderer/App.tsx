import { createMemo, createSignal, onMount, Show } from "solid-js";
import { desktop } from "@k2b/cloud/desktop";
import { defineDesktopWindows, DesktopWindowHost, DesktopWorkspace } from "@k2b/cloud/desktop/solid";
import { Button, MarkdownEditor, MarkdownView, SegmentedControl, toast } from "@k2b/ui";
import type { DesktopEnvironment, DesktopLabBridge } from "../bridge/types";
import { getDesktopBridge } from "./bridge";
import { MarkdownEditorApp, renderMarkdown } from "./MarkdownEditorApp";

type Mode = "edit" | "preview";

const browserEnvironment: DesktopEnvironment = {
  runtime: "browser",
  platform: "browser",
  windowControls: "browser",
  supportsNativeDialogs: false,
  supportsNativeMenus: false,
  supportsContextMenus: false,
};

const readResult = async <T,>(action: Promise<{ ok: true; data: T } | { ok: false; error: string }>): Promise<T> => {
  const result = await action;
  if (!result.ok) throw new Error(result.error);
  return result.data;
};

function DocumentWindow(props: { bridge: DesktopLabBridge; filePath: string; fileName: string }) {
  const [mode, setMode] = createSignal<Mode>("edit");
  const [draft, setDraft] = createSignal("");
  const [loaded, setLoaded] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [savedDraft, setSavedDraft] = createSignal("");
  const dirty = createMemo(() => draft() !== savedDraft());
  const previewHtml = createMemo(() => renderMarkdown(draft()));

  onMount(() => {
    void readResult(props.bridge.readMarkdownFile({ path: props.filePath }))
      .then((file) => {
        setDraft(file.markdown);
        setSavedDraft(file.markdown);
        setLoaded(true);
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
  });

  const save = async () => {
    setSaving(true);
    try {
      const file = await readResult(props.bridge.saveMarkdownFile({ path: props.filePath, markdown: draft() }));
      setDraft(file.markdown);
      setSavedDraft(file.markdown);
      toast.success("Saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DesktopWorkspace storageKey={`document-window:${props.filePath}`}>
      <DesktopWorkspace.TopBar drag>
        <DesktopWorkspace.DragRegion class="flex h-full min-w-0 select-none items-center gap-3 pl-24 pr-2">
          <p class="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{props.fileName}</p>
          <DesktopWorkspace.NoDrag class="ml-auto flex items-center gap-2">
            <SegmentedControl<Mode>
              options={[
                { value: "edit", label: "Edit", icon: "ti ti-pencil" },
                { value: "preview", label: "Preview", icon: "ti ti-eye" },
              ]}
              value={mode}
              onValueChange={setMode}
            />
            <Button variant="secondary" size="sm" class="shrink-0" disabled={!dirty() || saving()} onClick={() => void save()}>
              <i class={saving() ? "ti ti-loader-2 animate-spin" : "ti ti-device-floppy"} />
              Save
            </Button>
            <button
              type="button"
              class="desktop-panel-toggle"
              aria-label="Close window"
              title="Close window"
              onClick={() => void desktop.window.close()}
            >
              <i class="ti ti-x" />
            </button>
          </DesktopWorkspace.NoDrag>
        </DesktopWorkspace.DragRegion>
      </DesktopWorkspace.TopBar>
      <DesktopWorkspace.Main>
        <Show
          when={loaded()}
          fallback={
            <section class="desktop-surface flex h-full items-center justify-center text-xs text-zinc-500 dark:text-zinc-400">
              <i class="ti ti-loader-2 mr-2 animate-spin" />
              Loading document
            </section>
          }
        >
          <Show
            when={mode() === "edit"}
            fallback={<MarkdownView trustedHtml={previewHtml()} class="markdown-preview-pane h-full overflow-auto" />}
          >
            <div class="markdown-editor-pane h-full min-h-0">
              <MarkdownEditor value={draft} onValueChange={setDraft} lines={26} placeholder="Write markdown..." variant="paper" />
            </div>
          </Show>
        </Show>
      </DesktopWorkspace.Main>
    </DesktopWorkspace>
  );
}

export default function App() {
  const bridge: DesktopLabBridge = getDesktopBridge();
  const [environment, setEnvironment] = createSignal<DesktopEnvironment>(browserEnvironment);
  const windows = defineDesktopWindows({
    Document: (props: { filePath: string; fileName: string }) => (
      <DocumentWindow bridge={bridge} filePath={props.filePath} fileName={props.fileName} />
    ),
  });

  onMount(() => {
    void readResult(bridge.getDesktopEnvironment())
      .then((next) => {
        setEnvironment(next);
        window.cloudDesktopEnvironment = next;
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
  });

  return (
    <div
      class={`desktop-lab-root h-screen overflow-hidden bg-zinc-100 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100 platform-${environment().platform}`}
    >
      <DesktopWindowHost windows={windows}>
        <MarkdownEditorApp bridge={bridge} DocumentWindow={windows.Document!} />
      </DesktopWindowHost>
    </div>
  );
}
