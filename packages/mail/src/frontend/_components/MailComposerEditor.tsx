import { importOnDemand } from "@k2b/cloud/browser/reload";
import { Button, type Completion, Panes, type PanesItem, type PanesLayout, Placeholder, useLocale } from "@k2b/ui";
import type { TextEditorController } from "@k2b/ui/text-editor";
import type { Accessor, JSX } from "solid-js";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import type { ComposePreview } from "../../contracts";
import type { MailDraftDocumentClient, MailSharedDraftState } from "../../lib/draft-document-client";
import MailFormattingWarnings from "./MailFormattingWarnings";
import { mailComposerMessages } from "./mail-composer-messages";

/** The preview loads nothing from the network: the mailbox logo and every other image arrive as `data:` URLs. */
const PREVIEW_POLICY =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\">";

export default function MailComposerEditor(props: {
  shared?: Accessor<MailDraftDocumentClient | null>;
  sharedState?: Accessor<MailSharedDraftState | null>;
  onTableCheck?: (needsCheck: boolean) => void;
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
  onEditorReady: (editor: TextEditorController) => void;
  onAttachImages?: () => void;
  onDroppedImages?: (files: File[]) => void;
  history?: () => JSX.Element;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const hasHistory = () => props.history !== undefined;
  const usesPanes = () => props.format() === "markdown" || hasHistory();
  const [editorModule, setEditorModule] = createSignal<typeof import("./MailTextEditor.client")>();
  const [editorFailed, setEditorFailed] = createSignal(false);
  const loadEditor = async () => {
    setEditorFailed(false);
    const loaded = await importOnDemand(() => import("./MailTextEditor.client"));
    if (loaded) setEditorModule(loaded);
    else setEditorFailed(true);
  };
  onMount(() => void loadEditor());
  const writeSurface = () => (
    <Show
      when={editorModule()}
      fallback={
        <Placeholder
          state={editorFailed() ? "error" : "loading"}
          variant="panel"
          class="h-full min-h-72"
          title={editorFailed() ? t().editorFailed : t().preparingDraft}
          action={
            editorFailed() ? (
              <Button variant="secondary" onClick={() => void loadEditor()}>
                {t().retry}
              </Button>
            ) : undefined
          }
        />
      }
    >
      {(module) => {
        const Editor = module().default;
        return (
          <For each={[props.shared?.() ?? null]}>
            {(binding) => (
              <Editor
                shared={binding ?? undefined}
                sharedState={props.sharedState}
                onTableCheck={props.onTableCheck}
                format={props.format}
                body={props.body}
                onBodyInput={props.onBodyInput}
                editable={props.editable}
                completions={props.completions}
                onEditorReady={props.onEditorReady}
                onAttachImages={props.onAttachImages}
                onDroppedImages={props.onDroppedImages}
              />
            )}
          </For>
        );
      }}
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
                  srcdoc={`${PREVIEW_POLICY}<style>body{margin:0}</style>${value().html}`}
                  title={t().emailPreview}
                />
                <MailFormattingWarnings warnings={value().formattingWarnings} />
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
