import { BubbleMenu, createEditor, Editor, markdownActions, SlashMenu, Toolbar } from "@k2b/editor";
import { type CollabOptions, collab } from "@k2b/editor/collab";

import {
  basicExtensions,
  codeFontExtension,
  initialMarkdownDecorationRefreshExtension,
  markdownExtension,
  markupExtension,
  pointerSelectionMarkdownRefreshExtension,
} from "@k2b/editor/markdown";

import {
  basicExtensions,
  codeFontExtension,
  initialMarkdownDecorationRefreshExtension,
  markdownExtension,
  markupExtension,
  pointerSelectionMarkdownRefreshExtension,
} from "@k2b/editor/markdown";

export function NoteEditor(props: { initial: string; locale: string }) {
  const editor = createEditor();
  const actions = markdownActions(editor, props.locale);
  editor.use([
    basicExtensions(),
    markdownExtension(),
    markupExtension(),
    codeFontExtension(),
    initialMarkdownDecorationRefreshExtension(),
    pointerSelectionMarkdownRefreshExtension(),
  ]);
  return (
    <>
      <Toolbar
        editor={editor}
        groups={[{ items: [actions.bold, actions.italic, actions.strikethrough] }, { items: [actions.bulletList, actions.numberedList] }]}
      />
      <Editor editor={editor} label="Note" initialValue={props.initial} maxLength={2_097_152} toolbar={false} />
      <BubbleMenu editor={editor} groups={[[actions.bold, actions.italic, actions.code, actions.link]]} />
      <SlashMenu
        editor={editor}
        actions={[
          {
            id: "table",
            name: "table",
            label: "Table",
            icon: "ti-table",
            params: /^(\d+)x(\d+)$/,
            run: (view) => {
              actions.table.run(view);
            },
          },
        ]}
      />
    </>
  );
}

export function SharedNoteEditor(props: CollabOptions & { undoManager: NonNullable<CollabOptions["undoManager"]> }) {
  const editor = createEditor();
  const { undoManager } = props;
  return (
    <Editor
      editor={editor}
      label="Note"
      initialValue={props.text.toString()}
      maxLength={2_097_152}
      extensions={collab({ text: props.text, undoManager, awareness: props.awareness })}
      host={{ undo: () => undoManager.undo(), redo: () => undoManager.redo(), boundary: () => undoManager.stopCapturing() }}
    />
  );
}
