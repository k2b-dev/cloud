---
title: Write with the editor package
navTitle: Editor package
section: Frontend
order: 885
description: Place an editor, a toolbar, a bubble menu, and a slash menu on one shared editor state with @k2b/editor.
tags: [editor, markdown, toolbar, slash-menu]
updated: 2026-10-30
---

# Write with the editor package

`@k2b/editor` is a standalone SolidJS package for Markdown writing. It builds
on the [text editor](/ui/text-editor) from `@k2b/ui` and adds building blocks
that an application places where it wants them:

- `<Editor>`: the writing surface;
- `<Toolbar>`: a formatting toolbar, anywhere on the page;
- `<BubbleMenu>`: a compact menu at selected text;
- `<SlashMenu>`: actions that open when a person types `/`.

All of them read and change one shared state from `createEditor()`. There is no
second document model: the state is CodeMirror's. The package does not depend
on `@k2b/cloud`, so any SolidJS application can use it.

## Place the building blocks

Create the handle once per editor and pass it to every building block:

```tsx
import { BubbleMenu, Editor, SlashMenu, Toolbar, createEditor, markdownActions } from "@k2b/editor";

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
      <SlashMenu editor={editor} actions={[]} />
    </>
  );
}
```

`<Editor>` accepts every `TextEditor` prop, such as `presentation`, `host`,
`extensions`, and `onChange`. Pass `toolbar={false}` when you place your own
`<Toolbar>`. A host that mounts `TextEditor` itself adds `editor.extension()`
to its `extensions` and calls `editor.attach(controller, controls)` from
`onReady` and `editor.detach(view)` when it unmounts.

## Describe actions as data

An action is a plain object:

| Field | Meaning |
| --- | --- |
| `id` | Stable identity, the same in every locale. |
| `icon` | Tabler icon class without `ti `, such as `ti-bold`. |
| `label` | Accessible name and tooltip, already in the reader's language. |
| `shortcut` | CodeMirror key spec, such as `Mod-b`. Places show it; the application's keymap binds it. |
| `run(view)` | The command. It may return a promise, for example after a picker. |
| `isActive(state)` | Pressed state of a toggle. |
| `isEnabled(state)` | `false` greys the action out and ignores presses. |

Each place has its own list, so the toolbar can show more than the bubble menu.
`markdownActions(locale)` returns ready actions for bold, italic,
strikethrough, inline code, link, headings, lists, quote, code block, and table.
Applications add their own actions next to them.

`editor.run(action)` runs an action as one undo step, also when it waits for a
picker, and returns focus to the editor. Disabled actions and read-only editors
do nothing. `asUndoStep(view, run)` gives the same boundary to commands that run
outside a place, such as a keymap.

## Add the toolbar and the menus

`<Toolbar>` takes groups of items separated by a line. An item is an action, a
`{ kind: "menu" }` with sections of actions behind one icon, or a
`{ kind: "custom", render }` control for things such as a style picker. `start`
and `end` hold controls before and after the actions, such as navigation or a
sync status. Pressing a control keeps focus and selection in the editor. With
`liftAboveKeyboard`, the toolbar rises to the top edge of a phone keyboard while
the editor has focus.

`<BubbleMenu>` opens at a selection once it settles, not while a pointer still
drags it. Escape, a collapsed selection, or leaving the editor closes it. On
touch screens it sits below the selection, where the system's own menu does not
cover it. Children after the actions hold extra controls, such as **Comment**.

`<SlashMenu>` opens when a person types `/` at the start of a line or after a
space. Exact names and aliases come first, then fuzzy matches. A slash action
adds `name`, optional `aliases`, `description`, and `params`: with
`params: /^(\d+)x(\d+)$/`, typing `/table2x4` passes the match to `run`. A
block action typed after text starts on a new line; set `inline: true` to
insert at the caret instead. CodeMirror shows one completion popup per editor,
so further completion sources, such as links or tags, go into `sources`. A
source that throws drops only its own options.

## Add extensions later

`editor.use(extension)` adds an extension to the view, also before it mounts.
A function is tracked: when its value changes, only its own slot is
reconfigured. The slot leaves the view when the calling owner is disposed. The
building blocks use the same mechanism, so a menu that unmounts takes its
extension with it.

## Locale

The package's own texts, such as the toolbar's accessible name, come from its
English and German catalogs. They follow the locale that `LocaleProvider` from
`@k2b/ui` sets; actions carry labels from the application.
