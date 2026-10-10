import {
  AutocompleteEditor,
  Button,
  type Completion,
  InlineGuidance,
  MarkdownEditor,
  Panes,
  type PanesItem,
  type PanesLayout,
  Placeholder,
  useLocale,
} from "@k2b/ui";
import type { Accessor, JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import { composeFormattingMessages, describeComposeFormattingWarning } from "../../compose-formatting-messages";
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
  previewPending: Accessor<boolean>;
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

  // A failed preview takes the whole pane until a later one succeeds, so its message never covers an outdated preview.
  const previewSurface = () => (
    <div class="h-full min-h-72 overflow-hidden">
      <Show
        when={props.previewError()}
        fallback={
          <Show
            when={props.preview()}
            fallback={<Placeholder state="loading" variant="panel" class="h-full min-h-72" title={t().preparingPreview} />}
          >
            {(value) => (
              <div class="flex h-full min-h-72 flex-col">
                <iframe
                  class="min-h-0 w-full flex-1 border-0 bg-white"
                  sandbox=""
                  srcdoc={`<style>body{margin:0}</style>${value().html}`}
                  title={t().emailPreview}
                />
                {/* Below the message, so the preview content never moves when the hint appears. */}
                <Show when={value().formattingWarnings.length > 0}>
                  <InlineGuidance icon="ti ti-info-circle" class="max-h-28 shrink-0 overflow-y-auto px-3 py-2">
                    <p>{composeFormattingMessages.resolve([locale()]).t.title}</p>
                    <ul>
                      <For each={value().formattingWarnings}>
                        {(warning) => <li>{describeComposeFormattingWarning(warning, locale())}</li>}
                      </For>
                    </ul>
                  </InlineGuidance>
                </Show>
              </div>
            )}
          </Show>
        }
      >
        {(message) => (
          <Placeholder
            state="error"
            variant="panel"
            class="h-full min-h-72 overflow-y-auto"
            title={t().previewFailed}
            description={message() === t().previewFailed ? undefined : message()}
            action={
              <Button variant="secondary" size="sm" type="button" loading={props.previewPending()} onClick={props.onRetryPreview}>
                {t().retry}
              </Button>
            }
          />
        )}
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
