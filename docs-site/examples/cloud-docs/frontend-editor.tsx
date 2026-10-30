import { BubbleMenu, createEditor, Editor, markdownActions, SlashMenu, Toolbar } from "@k2b/editor";

export function NoteEditor(props: { initial: string; locale: string }) {
  const editor = createEditor();
  const actions = markdownActions(props.locale);
  return (
    <>
      <Toolbar
        editor={editor}
        groups={[
          { items: [actions.bold, actions.italic, actions.strikethrough] },
          { items: [actions.bulletList, actions.numberedList] },
        ]}
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
