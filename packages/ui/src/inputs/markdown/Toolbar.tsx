import { For, type JSX, Show } from "solid-js";
import { Tooltip } from "../../feedback/Tooltip";
import {
  insertLink,
  toggleBold,
  toggleBulletList,
  toggleCode,
  toggleHeading,
  toggleItalic,
  toggleNumberedList,
  toggleQuote,
} from "./actions";
import { useMarkdownToolbarMessages } from "./toolbar-messages";

type ToolbarProps = {
  textarea: () => HTMLTextAreaElement | null;
  activeFormats?: () => Set<string>;
  disabled?: boolean;
  trailing?: JSX.Element;
};

type Tool =
  | {
      kind: "button";
      id: string;
      icon: string;
      title: string;
      run: (textarea: HTMLTextAreaElement) => void;
    }
  | { kind: "separator" };

const TOOLS: readonly Tool[] = [
  { kind: "button", id: "bold", icon: "ti ti-bold", title: "Bold (Ctrl/Cmd+B)", run: toggleBold },
  { kind: "button", id: "italic", icon: "ti ti-italic", title: "Italic (Ctrl/Cmd+I)", run: toggleItalic },
  { kind: "button", id: "code", icon: "ti ti-code", title: "Inline code (Ctrl/Cmd+E)", run: toggleCode },
  { kind: "button", id: "link", icon: "ti ti-link", title: "Link (Ctrl/Cmd+K)", run: insertLink },
  { kind: "separator" },
  { kind: "button", id: "h1", icon: "ti ti-h-1", title: "Heading 1 (Ctrl/Cmd+Shift+1)", run: (textarea) => toggleHeading(textarea, 1) },
  { kind: "button", id: "h2", icon: "ti ti-h-2", title: "Heading 2 (Ctrl/Cmd+Shift+2)", run: (textarea) => toggleHeading(textarea, 2) },
  { kind: "button", id: "h3", icon: "ti ti-h-3", title: "Heading 3 (Ctrl/Cmd+Shift+3)", run: (textarea) => toggleHeading(textarea, 3) },
  { kind: "separator" },
  { kind: "button", id: "bullet", icon: "ti ti-list", title: "Bullet list (Ctrl/Cmd+Shift+8)", run: toggleBulletList },
  { kind: "button", id: "ordered", icon: "ti ti-list-numbers", title: "Numbered list (Ctrl/Cmd+Shift+7)", run: toggleNumberedList },
  { kind: "button", id: "quote", icon: "ti ti-quote", title: "Quote", run: toggleQuote },
];

export default function Toolbar(props: ToolbarProps): JSX.Element {
  const markdownToolbarMessages = useMarkdownToolbarMessages();
  const title = (id: string, fallback: string): string =>
    ({
      bold: markdownToolbarMessages().boldShortcut,
      italic: markdownToolbarMessages().italicShortcut,
      code: markdownToolbarMessages().inlineCodeShortcut,
      link: markdownToolbarMessages().linkShortcut,
      h1: markdownToolbarMessages().heading1Shortcut,
      h2: markdownToolbarMessages().heading2Shortcut,
      h3: markdownToolbarMessages().heading3Shortcut,
      bullet: markdownToolbarMessages().bulletListShortcut,
      ordered: markdownToolbarMessages().numberedListShortcut,
      quote: markdownToolbarMessages().quote,
    })[id] ?? fallback;
  let toolbar!: HTMLDivElement;
  const moveFocus = (event: KeyboardEvent): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(toolbar.querySelectorAll<HTMLButtonElement>(".k2b-markdown-editor__tool:not(:disabled)"));
    if (buttons.length === 0) return;
    const current = Math.max(
      0,
      buttons.findIndex((button) => button === document.activeElement),
    );
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowLeft"
            ? (current - 1 + buttons.length) % buttons.length
            : (current + 1) % buttons.length;
    event.preventDefault();
    for (const button of buttons) button.tabIndex = -1;
    buttons[next]!.tabIndex = 0;
    buttons[next]!.focus();
  };

  return (
    <div
      ref={toolbar}
      class="k2b-markdown-editor__toolbar"
      role="toolbar"
      aria-label={markdownToolbarMessages().markdownFormatting}
      onKeyDown={moveFocus}
    >
      <For each={TOOLS}>
        {(tool, index) =>
          tool.kind === "separator" ? (
            <span class="k2b-markdown-editor__separator" aria-hidden="true" />
          ) : (
            <Tooltip.Trigger
              type="button"
              class="k2b-markdown-editor__tool"
              content={title(tool.id, tool.title)}
              aria-label={title(tool.id, tool.title)}
              aria-pressed={props.activeFormats?.().has(tool.id) ? "true" : undefined}
              disabled={props.disabled}
              tabIndex={index() === 0 ? 0 : -1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const textarea = props.textarea();
                if (textarea) tool.run(textarea);
              }}
            >
              <i class={tool.icon} aria-hidden="true" />
            </Tooltip.Trigger>
          )
        }
      </For>
      <Show when={props.trailing}>
        <span class="k2b-markdown-editor__trailing">{props.trailing}</span>
      </Show>
    </div>
  );
}
