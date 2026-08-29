import {
  Button,
  Dropdown,
  dialogCore,
  MarkdownEditor,
  type MarkdownEditorProps,
  PanelDialog,
  panelDialogWorkspaceOptions,
  StatusBadge,
} from "@k2b/ui";
import { createMemo, For } from "solid-js";
import type { DslQueryContextKey } from "../../../query-dsl/parameters";
import { useCustomAppBuilderMessages } from "./builder-messages";

type CustomAppMarkdownFieldProps = {
  contextKeys: readonly DslQueryContextKey[];
  value: () => string;
  onValueChange: (value: string) => void;
};

type MarkdownCompletion = NonNullable<MarkdownEditorProps["completions"]>[number];

const contextLabel = (key: DslQueryContextKey): string => `@${key}`;

const contextCompletion = (keys: readonly DslQueryContextKey[], hint: string): MarkdownCompletion => ({
  trigger: "@",
  dropdown: true,
  knownLabels: keys.map(contextLabel),
  suggest: (query) => {
    const normalized = query.toLowerCase();
    return keys
      .filter((key) => key.toLowerCase().startsWith(normalized))
      .map((key) => ({ text: contextLabel(key), label: contextLabel(key), hint }));
  },
});

export function CustomAppMarkdownField(props: CustomAppMarkdownFieldProps) {
  const messages = useCustomAppBuilderMessages();
  const text = messages().text;
  const completions = createMemo(() => [contextCompletion(props.contextKeys, text({ value: "App context" }))]);
  const insertPlaceholder = (key: DslQueryContextKey, textarea?: HTMLTextAreaElement) => {
    const source = props.value();
    const start = textarea?.selectionStart ?? source.length;
    const end = textarea?.selectionEnd ?? start;
    const placeholder = contextLabel(key);
    props.onValueChange(`${source.slice(0, start)}${placeholder}${source.slice(end)}`);
    queueMicrotask(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + placeholder.length, start + placeholder.length);
    });
  };
  const placeholderItems = (textarea: () => HTMLTextAreaElement | undefined) =>
    props.contextKeys.map((key) => ({
      icon: "ti ti-at",
      label: contextLabel(key),
      description: key.startsWith("auth.") ? text({ value: "Signed-in reader" }) : text({ value: "App request context" }),
      action: () => insertPlaceholder(key, textarea()),
    }));

  const openLargeEditor = () =>
    dialogCore.open<void>((close) => {
      let textarea: HTMLTextAreaElement | undefined;
      return (
        <PanelDialog>
          <PanelDialog.Header
            title={text({ value: "Markdown content" })}
            subtitle={text({ value: "The content edits the same automatically saved draft as the inspector." })}
            icon="ti ti-markdown"
            close={close}
            closeLabel={text({ value: "Close Markdown editor" })}
          />
          <PanelDialog.Body scrollPreserveKey="custom-app-markdown-editor">
            <div class="flex min-h-0 flex-1 flex-col gap-3">
              <MarkdownEditor
                label={text({ value: "Content" })}
                description={text({ value: "Type @ or add a placeholder. Values are inserted safely when the published app renders." })}
                value={props.value}
                onValueChange={props.onValueChange}
                completions={completions()}
                fill
                lines={24}
                textareaRef={(element) => {
                  textarea = element;
                }}
              />
              <div class="flex flex-wrap items-center gap-2">
                <Dropdown.Root
                  items={placeholderItems(() => textarea)}
                  position="top-left"
                  width="18rem"
                  label={text({ value: "Add placeholder" })}
                >
                  <Dropdown.Trigger size="xs" variant="secondary">
                    <i class="ti ti-at" aria-hidden="true" /> {text({ value: "Add placeholder" })}
                  </Dropdown.Trigger>
                </Dropdown.Root>
                <div
                  class="flex flex-wrap items-center gap-1.5"
                  role="group"
                  aria-label={text({ value: "Available Markdown placeholders" })}
                >
                  <For each={props.contextKeys}>{(key) => <StatusBadge tone="neutral" icon={null} label={contextLabel(key)} />}</For>
                </div>
              </div>
            </div>
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <span class="mr-auto text-xs text-dimmed">{text({ value: "Changes save automatically." })}</span>
            <Button size="sm" onClick={() => close()}>
              {text({ value: "Done" })}
            </Button>
          </PanelDialog.Footer>
        </PanelDialog>
      );
    }, panelDialogWorkspaceOptions);

  return (
    <div class="flex flex-col gap-2">
      <MarkdownEditor
        label={text({ value: "Content" })}
        description={text({ value: "Type @ to insert App context. Values are inserted safely when the published app renders." })}
        value={props.value}
        onValueChange={props.onValueChange}
        completions={completions()}
        lines={6}
      />
      <Button size="xs" variant="secondary" class="self-start" onClick={() => void openLargeEditor()}>
        <i class="ti ti-arrows-maximize" aria-hidden="true" /> {text({ value: "Open large editor" })}
      </Button>
    </div>
  );
}
