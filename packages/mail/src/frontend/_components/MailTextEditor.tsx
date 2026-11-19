import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { Transaction } from "@codemirror/state";
import { createLiveDictationSource } from "@k2b/cloud/ai/browser";
import { isolateYjsHistory } from "@k2b/editor/collab";
import { Button, type Completion, useLocale } from "@k2b/ui";
import { type TableHost, TextEditor, type TextEditorController, type TextEditorControls } from "@k2b/ui/text-editor";
import { type Accessor, createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import { type MailDraftDocumentClient, type MailSharedDraftState, mailSharedDraftMessages } from "../../lib/draft-document-client";
import { mailComposerMessages } from "./mail-composer-messages";
import { copySharedDraft } from "./mail-draft-document-actions";
import { mailDraftTablePresence } from "./mail-draft-document-presence";
import { createMailDraftTableStructure, type UnknownTableAction } from "./mail-draft-document-table";

const liveDictationSource = createLiveDictationSource({ app: "mail" });

/** Edits the composer starts for the person, such as an inserted attachment link. */
export type MailTextEditorActions = {
  /** Appends text after a blank line, as one step of the person's undo history, also in a shared draft. */
  appendText: (text: string) => void;
};

/** Mail owns templates, attachments and draft replacement; the shared editor owns text and tables. */
export default function MailTextEditor(props: {
  shared?: MailDraftDocumentClient;
  sharedState?: Accessor<MailSharedDraftState | null>;
  /** Where the shared draft's hint stands, such as right above the composer's bar; without it, under the text. */
  hintMount?: Accessor<HTMLElement | undefined>;
  onTableCheck?: (needsCheck: boolean) => void;
  format: Accessor<"plain" | "markdown">;
  body: Accessor<string>;
  onBodyInput: (value: string) => void;
  editable: Accessor<boolean>;
  /** Input waits for a moment; the text keeps its caret, focus, and toolbar. */
  paused?: Accessor<boolean>;
  completions: Accessor<Completion[]>;
  onEditorReady: (editor: TextEditorController, actions: MailTextEditorActions) => void;
  onAttachImages?: () => void;
  onDroppedImages?: (files: File[]) => void;
  /** Live dictation into the body, from the editor toolbar. */
  liveDictation?: boolean;
  /** Whether the formatting bar shows; the draft inside a conversation toggles it from its own tools. */
  toolbar?: Accessor<boolean>;
  /** Inside a conversation the text grows with its content and the conversation scrolls, not the editor. */
  inline?: boolean;
  /** What the empty text says, such as the reply box's "Write a reply …". */
  placeholder?: string;
}) {
  const locale = useLocale();
  const t = () => mailComposerMessages.resolve([locale()]).t;
  const st = () => mailSharedDraftMessages.resolve([locale()]).t;
  const [unknownAction, setUnknownAction] = createSignal<UnknownTableAction | null>(null);
  const [editor, setEditor] = createSignal<TextEditorController>();
  const [mode, setMode] = createSignal<"formatted" | "source">("formatted");
  let controls: TextEditorControls | undefined;
  let applying = false;
  const requests = new Set<AbortController>();
  onCleanup(() => {
    for (const request of requests) request.abort();
  });
  const complete = async (context: CompletionContext) => {
    if (!props.editable() || !context.state.selection.main.empty) return null;
    const match = context.matchBefore(/[^\s]*$/u);
    if (!match) return null;
    const source = props.completions().find((item) => item.trigger && match.text.startsWith(item.trigger));
    if (!source?.trigger) return null;
    const controller = new AbortController();
    requests.add(controller);
    context.addEventListener("abort", () => controller.abort(), { onDocChange: true });
    try {
      const suggestions = await source.suggest(
        match.text.slice(source.trigger.length),
        {
          fullText: context.state.doc.toString(),
          caret: context.pos,
          tokenStart: match.from,
        },
        controller.signal,
      );
      if (context.aborted || controller.signal.aborted) return null;
      return {
        from: match.from,
        options: suggestions.map((suggestion) => ({
          label: suggestion.label ?? suggestion.text,
          detail: suggestion.hint,
          apply: (view: TextEditorController["view"], _completion: unknown, from: number, to: number) => {
            if (view.state.readOnly) return;
            const edit = suggestion.textEdit ?? { start: from, end: to, text: suggestion.expansion ?? suggestion.text };
            view.dispatch({
              changes: { from: edit.start, to: edit.end, insert: edit.text },
              selection: { anchor: edit.start + edit.text.length },
              userEvent: "input.complete",
            });
          },
        })),
      };
    } catch (error) {
      if (!controller.signal.aborted) controls?.notify(error instanceof Error ? error.message : t().templatesFailed);
      return null;
    } finally {
      requests.delete(controller);
    }
  };
  createEffect(() => {
    const current = editor();
    const value = props.body();
    if (!current || props.shared) return;
    untrack(() => {
      const before = current.view.state.doc.toString();
      if (before === value) return;
      let from = 0;
      while (from < before.length && from < value.length && before[from] === value[from]) from++;
      let oldEnd = before.length,
        newEnd = value.length;
      while (oldEnd > from && newEnd > from && before[oldEnd - 1] === value[newEnd - 1]) {
        oldEnd--;
        newEnd--;
      }
      applying = true;
      try {
        current.view.dispatch({
          changes: { from, to: oldEnd, insert: value.slice(from, newEnd) },
          annotations: Transaction.addToHistory.of(false),
        });
      } finally {
        applying = false;
      }
    });
  });
  const binding = props.shared;
  const structure = binding
    ? createMailDraftTableStructure({
        ytext: binding.doc.getText("codemirror"),
        provider: { ...binding.provider, generation: () => binding.generation },
        track: () => props.sharedState?.(),
        post: async (request) => {
          const controller = new AbortController();
          requests.add(controller);
          try {
            return await binding.postAction(request, controller.signal);
          } finally {
            requests.delete(controller);
          }
        },
        notify: (message) => controls?.notify(message),
        fallback: () => st().tableFailed,
        onUnknown: setUnknownAction,
      })
    : undefined;
  const runHistory = (action: "undo" | "redo") => {
    if (!props.editable() || !binding) return;
    void binding.provider[action]().catch((error: unknown) => controls?.notify(error instanceof Error ? error.message : st().tableFailed));
  };
  const host: TableHost["onCellSelection"] = (selection) => {
    if (!binding || !selection || !props.editable()) return;
    const text = binding.doc.getText("codemirror");
    binding.awareness.setLocalStateField("cursor", {
      anchor: Y.createRelativePositionFromTypeIndex(text, selection.anchor),
      head: Y.createRelativePositionFromTypeIndex(text, selection.head),
    });
  };
  createEffect(() => {
    if (props.sharedState?.()?.message === st().retainedColumn) controls?.notify(st().retainedColumn);
  });
  const copy = async () => {
    if (!binding) return;
    try {
      await copySharedDraft(binding);
    } catch {
      controls?.notify(t().copyTextFailed);
    }
  };
  const retry = () => {
    if (binding) void binding.retry().catch((error: unknown) => controls?.notify(error instanceof Error ? error.message : st().pending));
  };
  const restoreProposal = () => {
    try {
      binding?.restoreRejectedEdit();
    } catch (error) {
      controls?.notify(error instanceof Error ? error.message : st().bodyEditFailed);
    }
  };
  const hint = () => (
    <div class="mail-draft-hint" data-tone={props.sharedState?.()?.error ? "danger" : undefined} role="status" data-mail-draft-hint>
      <span class="mail-draft-hint-text">
        {unknownAction() ? st().tableUnknown : props.sharedState?.()?.error ? props.sharedState?.()?.message : st().notRemembered}
      </span>
      <span class="mail-draft-hint-actions">
        <Show
          when={unknownAction()}
          fallback={
            <>
              <Show when={props.sharedState?.()?.rejectedEdit}>
                <Button size="sm" variant="secondary" disabled={props.sharedState?.()?.terminal} onClick={restoreProposal}>
                  {st().restoreProposal}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => binding?.discardRejectedEdit()}>
                  {st().discardProposal}
                </Button>
              </Show>
              <Button size="sm" variant="secondary" onClick={retry}>
                {t().draftHintRetry}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void copy()}>
                {t().draftHintCopy}
              </Button>
            </>
          }
        >
          <Button size="sm" variant="secondary" onClick={() => unknownAction()?.stopWaiting()}>
            {st().stopWaiting}
          </Button>
        </Show>
      </span>
    </div>
  );
  return (
    <div class={props.inline ? "mail-inline-text-editor" : "flex h-full min-h-72 flex-col"}>
      {/* The message scrolls here, under the editor's toolbar; the hint below takes its own line under the text. */}
      <div class={props.inline ? undefined : "min-h-0 flex-1 overflow-y-auto overscroll-contain"}>
        <TextEditor
          class={props.inline ? undefined : "min-h-full"}
          toolbar={props.toolbar ? props.toolbar() : undefined}
          label={t().messageBody}
          placeholder={props.placeholder ?? t().writeMessage}
          initialValue={binding ? binding.doc.getText("codemirror").toString() : untrack(props.body)}
          onTableCheck={props.onTableCheck}
          host={
            binding
              ? {
                  undo: () => runHistory("undo"),
                  redo: () => runHistory("redo"),
                  boundary: () => binding.undoManager.stopCapturing(),
                  structure,
                  onCellSelection: host,
                }
              : undefined
          }
          mode={props.format() === "plain" ? "plain" : mode()}
          onModeChange={(next) => {
            if (next !== "plain") setMode(next);
          }}
          readOnly={!props.editable() && !props.paused?.()}
          locked={props.paused?.()}
          dictation={props.liveDictation ? { source: liveDictationSource } : undefined}
          maxLength={2_097_152}
          extensions={[
            autocompletion({ override: [complete], activateOnTypingDelay: 180 }),
            ...(binding
              ? [
                  yCollab(binding.doc.getText("codemirror"), binding.awareness, { undoManager: binding.undoManager }),
                  isolateYjsHistory(binding.undoManager),
                  mailDraftTablePresence(binding.doc.getText("codemirror"), binding.awareness),
                ]
              : []),
          ]}
          onChange={(value) => {
            // Yjs projects shared input to the composer. A CodeMirror callback
            // can run before that projection during remote delivery; feeding it
            // back as a local edit would insert the peer's text a second time.
            if (!applying && !binding) props.onBodyInput(value);
          }}
          onReady={(value, nextControls) => {
            controls = nextControls;
            setEditor(value);
            if (binding) {
              const blur = () =>
                queueMicrotask(() => {
                  if (!value.view.dom.contains(document.activeElement)) binding.awareness.setLocalStateField("cursor", null);
                });
              value.view.dom.addEventListener("focusout", blur);
              onCleanup(() => value.view.dom.removeEventListener("focusout", blur));
            }
            props.onEditorReady(value, {
              appendText: (text) => {
                const doc = value.view.state.doc;
                const before = doc.toString();
                value.view.dispatch({
                  changes: { from: doc.length, insert: `${before.endsWith("\n") || !before ? "" : "\n\n"}${text}` },
                  userEvent: "input.paste",
                  annotations: isolateHistory.of("full"),
                });
              },
            });
          }}
          onAttachImages={props.onAttachImages}
          onDroppedImages={(_count, files) => {
            if (!props.onDroppedImages || !files.length) return;
            props.onDroppedImages(files);
            return true;
          }}
        />
      </div>
      {/* A quiet line, never over the text: what keeps the draft from saving normally, with its way out. In a composer
          it stands right above the bar; the saved state itself stands once, in the composer's head. */}
      <Show when={binding && (!props.sharedState?.()?.remembering || props.sharedState?.()?.error || unknownAction())}>
        <Show when={props.hintMount?.()} fallback={hint()}>
          {(mount) => <Portal mount={mount()}>{hint()}</Portal>}
        </Show>
      </Show>
    </div>
  );
}
