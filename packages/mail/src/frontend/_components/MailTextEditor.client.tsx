import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { Transaction } from "@codemirror/state";
import { Button, type Completion, Dropdown, useLocale } from "@k2b/ui";
import { type TableHost, TextEditor, type TextEditorController, type TextEditorControls } from "@k2b/ui/text-editor";
import { type Accessor, createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import { type MailDraftDocumentClient, type MailSharedDraftState, mailSharedDraftMessages } from "../../lib/draft-document-client";
import { mailComposerMessages } from "./mail-composer-messages";
import { isolateYjsHistory } from "./mail-draft-document-history";
import { mailDraftPeers, mailDraftTablePresence } from "./mail-draft-document-presence";
import { createMailDraftTableStructure, type UnknownTableAction } from "./mail-draft-document-table";

/** Mail owns templates, attachments and draft replacement; the shared editor owns text and tables. */
export default function MailTextEditor(props: {
  shared?: MailDraftDocumentClient;
  sharedState?: Accessor<MailSharedDraftState | null>;
  onTableCheck?: (needsCheck: boolean) => void;
  format: Accessor<"plain" | "markdown">;
  body: Accessor<string>;
  onBodyInput: (value: string) => void;
  editable: Accessor<boolean>;
  completions: Accessor<Completion[]>;
  onEditorReady: (editor: TextEditorController) => void;
  onAttachImages?: () => void;
  onDroppedImages?: (files: File[]) => void;
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
  const [peers, setPeers] = createSignal<string[]>([]);
  if (binding) {
    const changed = () =>
      setPeers([...new Set(mailDraftPeers(binding.doc.getText("codemirror"), binding.awareness).map((peer) => peer.name))]);
    binding.awareness.on("change", changed);
    onCleanup(() => binding.awareness.off("change", changed));
    changed();
  }
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
  const sharedStatus = () => {
    const current = props.sharedState?.();
    if (!current) return "";
    if (current.terminal || current.error) return current.message;
    if (current.structuring) return st().tablePending;
    if (current.message === st().retainedColumn) return current.message;
    return !current.connected
      ? st().offline.replace("{count}", String(current.changes))
      : current.dirty
        ? st().pending
        : !current.ready
          ? st().connecting
          : st().saved;
  };
  const copy = async () => {
    if (!binding) return;
    try {
      const content = binding.content();
      await navigator.clipboard.writeText(
        `${content.to.map((entry) => entry.address).join(", ")}\nCc: ${content.cc.map((entry) => entry.address).join(", ")}\nBcc: ${content.bcc.map((entry) => entry.address).join(", ")}\n${content.subject}\n\n${content.body}`,
      );
    } catch {
      controls?.notify(t().copyTextFailed);
    }
  };
  const retry = () => {
    if (binding) void binding.retry().catch((error: unknown) => controls?.notify(error instanceof Error ? error.message : st().pending));
  };
  return (
    <div class="relative h-full min-h-72">
      <TextEditor
        class="h-full min-h-72"
        label={t().messageBody}
        placeholder={t().writeMessage}
        initialValue={binding ? binding.doc.getText("codemirror").toString() : untrack(props.body)}
        onTableCheck={props.onTableCheck}
        status={
          binding ? (
            <span class="flex h-6 w-64 max-w-full min-w-0 items-center justify-between gap-2">
              <span class="min-w-0 truncate" title={sharedStatus()}>
                {sharedStatus()}
                {peers().length ? ` · ${peers().join(", ")}` : ""}
              </span>
              <Dropdown.Root
                position="bottom-right"
                items={[
                  { label: st().retry, icon: "ti ti-refresh", action: retry },
                  { label: st().copy, icon: "ti ti-copy", action: () => void copy() },
                  {
                    label: props.sharedState?.()?.remembering ? st().forget : st().remember,
                    icon: "ti ti-device-laptop",
                    action: () => {
                      void binding
                        .setRemembering(!binding.state().remembering)
                        .catch((error: unknown) => controls?.notify(error instanceof Error ? error.message : st().storageFailed));
                    },
                  },
                  ...(props.sharedState?.()?.terminal ? [{ label: st().recover, icon: "ti ti-history", action: retry }] : []),
                  ...(props.sharedState?.()?.terminal && !props.sharedState?.()?.dirty && !props.sharedState?.()?.structuring
                    ? [{ label: st().reopen, icon: "ti ti-external-link", action: () => window.location.reload() }]
                    : []),
                ]}
              >
                <Dropdown.Trigger appearance="plain" class="focus-ui shrink-0 rounded px-1" aria-label={t().messageOptions}>
                  <i class="ti ti-dots" aria-hidden="true" />
                </Dropdown.Trigger>
              </Dropdown.Root>
            </span>
          ) : undefined
        }
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
        readOnly={!props.editable()}
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
          props.onEditorReady(value);
        }}
        onAttachImages={props.onAttachImages}
        onDroppedImages={(_count, files) => {
          if (!props.onDroppedImages || !files.length) return;
          props.onDroppedImages(files);
          return true;
        }}
      />
      <Show when={binding && (!props.sharedState?.()?.remembering || props.sharedState?.()?.error || unknownAction())}>
        <div
          class="absolute inset-x-2 bottom-2 z-20 flex flex-wrap items-center gap-2 rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-[var(--ui-surface)] p-2 text-xs text-primary shadow-sm"
          role="status"
        >
          <span class="min-w-0 flex-1">
            {unknownAction() ? st().tableUnknown : props.sharedState?.()?.error ? props.sharedState?.()?.message : st().notRemembered}
          </span>
          <Show
            when={unknownAction()}
            fallback={
              <>
                <Button size="sm" variant="secondary" onClick={retry}>
                  {st().retry}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void copy()}>
                  {st().copy}
                </Button>
              </>
            }
          >
            <Button size="sm" variant="secondary" onClick={() => unknownAction()?.stopWaiting()}>
              {st().stopWaiting}
            </Button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
