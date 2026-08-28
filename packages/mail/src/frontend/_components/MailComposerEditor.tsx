import {
  AutocompleteEditor,
  Button,
  type Completion,
  MarkdownEditor,
  Panes,
  type PanesItem,
  type PanesLayout,
  Placeholder,
  useLocale,
} from "@k2b/ui";
import type { Accessor, JSX } from "solid-js";
import { createMemo, Show } from "solid-js";
import type { ComposePreview } from "../../contracts";
import { mailComposerMessages } from "./mail-composer-messages";

export default function MailComposerEditor(props: {
  format: Accessor<"plain" | "markdown">;
  body: Accessor<string>;
  onBodyInput: (value: string) => void;
  editable: Accessor<boolean>;
  completions: Accessor<Completion[]>;
  panes: Accessor<PanesLayout>;
  onPanesChange: (value: PanesLayout) => void;
  preview: Accessor<ComposePreview | null>;
  previewError: Accessor<string | undefined>;
  onRetryPreview: () => void;
  onEditorReady: (element: HTMLTextAreaElement) => void;
  history?: () => JSX.Element;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const hasHistory = () => props.history !== undefined;
  const usesPanes = () => props.format() === "markdown" || hasHistory();
  const writeSurface = () => (
    <Show
      when={props.format() === "markdown"}
      fallback={
        <AutocompleteEditor
          value={props.body}
          onValueChange={props.onBodyInput}
          lines={26}
          placeholder={t().writeMessage}
          aria-label={t().messageBody}
          spellcheck
          disabled={!props.editable()}
          completions={props.completions()}
          textareaRef={props.onEditorReady}
          fill
        />
      }
    >
      <MarkdownEditor
        value={props.body}
        onValueChange={props.onBodyInput}
        placeholder={t().writeMessage}
        aria-label={t().messageBody}
        lines={26}
        spellcheck
        disabled={!props.editable()}
        completions={props.completions()}
        textareaRef={props.onEditorReady}
        fill
      />
    </Show>
  );

  const previewSurface = () => (
    <div class="relative h-full min-h-72 overflow-hidden bg-white">
      <Show
        when={props.preview()}
        fallback={
          <Show
            when={props.previewError()}
            fallback={<Placeholder state="loading" variant="panel" class="h-full min-h-72" title={t().preparingPreview} />}
          >
            {(message) => (
              <div class="flex h-full min-h-72 flex-col items-center justify-center gap-2 p-4 text-sm text-red-600">
                <span>{message()}</span>
                <Button variant="secondary" size="sm" type="button" onClick={props.onRetryPreview}>
                  {t().retry}
                </Button>
              </div>
            )}
          </Show>
        }
      >
        {(value) => (
          <iframe
            class="h-full min-h-72 w-full border-0 bg-white"
            sandbox=""
            srcdoc={`<style>body{margin:0}</style>${value().html}`}
            title={t().emailPreview}
          />
        )}
      </Show>
      <Show when={props.preview() && props.previewError()}>
        <div class="absolute inset-x-2 top-2 flex items-center gap-2 border border-red-200 bg-white px-2 py-1 text-xs text-red-600 shadow-sm">
          <span class="min-w-0 flex-1 truncate">{props.previewError()}</span>
          <Button variant="ghost" size="sm" type="button" onClick={props.onRetryPreview}>
            {t().retry}
          </Button>
        </div>
      </Show>
    </div>
  );
  const items = createMemo<PanesItem[]>(() => [
    {
      id: "editor",
      title: t().write,
      icon: "ti ti-pencil",
      render: () => <div class="h-full min-h-0 overflow-hidden">{writeSurface()}</div>,
    },
    ...(props.format() === "markdown" ? [{ id: "preview", title: t().preview, icon: "ti ti-eye", render: previewSurface }] : []),
    ...(props.history ? [{ id: "history", title: t().history, icon: "ti ti-history", render: props.history }] : []),
  ]);

  return (
    <div class="min-h-72 flex-1 py-2">
      <Show when={usesPanes()} fallback={<div class="h-full min-h-72 overflow-hidden">{writeSurface()}</div>}>
        <Panes
          layout={props.panes()}
          onLayoutChange={props.onPanesChange}
          items={items()}
          class="h-full w-full"
          movable
          resizable
          split="horizontal"
          ariaLabel={t().editorPanes}
        />
      </Show>
    </div>
  );
}
