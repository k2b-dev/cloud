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
  const actions = markdownActions(editor, props.locale);
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
to its `extensions`, calls `editor.attach(controller.view, { controller, controls })`
from `onReady`, and calls `editor.detach(view)` when it unmounts.

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
`markdownActions(editor, locale)` returns ready actions for bold, italic,
strikethrough, inline code, link, headings, lists, quote, code block, and table.
In a focused table cell, the inline formats apply to the cell and the block
formats are off. Applications add their own actions next to them.

`editor.run(action)` keeps an action's edits apart from the surrounding typing
in the undo history, also when it waits for a picker, and returns focus to the
editor. An action that should undo at once dispatches one transaction. Disabled
actions do nothing, and every action is off in a read-only editor.
`asUndoStep(view, run)` gives the same boundary to commands that run outside a
place, such as a keymap.

## Add the toolbar and the menus

`<Toolbar>` takes groups of items separated by a line. An item is an action, a
`{ kind: "menu" }` with sections of actions behind one icon, or a
`{ kind: "custom", render }` control for things such as a style picker. `start`
and `end` hold controls before and after the actions, such as navigation or a
sync status. Pressing a control keeps focus and selection in the editor. With
`liftAboveKeyboard`, the toolbar rises to the top edge of a phone keyboard while
the editor has focus.

`<BubbleMenu>` opens at a selection once it settles, not while a pointer still
drags it. It stays open while focus moves between the text and the menu. Escape,
a collapsed selection, or leaving both closes it. On
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

## Compose Markdown extensions

Import the package stylesheet in the host's Tailwind stylesheet so widget
utilities and the completion palette are included:

```css
@import "@k2b/editor/styles.css";
```

Import optional Markdown extensions from `@k2b/editor/markdown`. Add them to
`editor.use()` or the CodeMirror view that the application already owns:

```ts
import {
  basicExtensions, codeFontExtension, initialMarkdownDecorationRefreshExtension,
  markdownExtension, markupExtension, pointerSelectionMarkdownRefreshExtension,
} from "@k2b/editor/markdown";

editor.use([
  basicExtensions(), markdownExtension(), markupExtension(), codeFontExtension(),
  initialMarkdownDecorationRefreshExtension(), pointerSelectionMarkdownRefreshExtension(),
]);
```

The subpath includes lists and list commands, display ligatures, marks,
subscript and superscript, notices, named data blocks, images, links, math,
Mermaid, completions, themes, and scroll helpers. The Markdown parsers are also
available to render the same source outside an editor. Extensions preserve the
source text; editing a rendered block reveals its Markdown. The math extension
expects the host to load KaTeX’s stylesheet and fonts.

| Extension | Application options |
| --- | --- |
| `listsExtension`, `ligaturesExtension` | `excludedRanges(markdown)` returns source spans that stay literal, such as application directives. |
| `listCommandsExtension` | The same `excludedRanges`, plus `isRemoteTransaction(transaction)` to prevent automatic number repairs on collaboration updates. Supply the same range callback to lists and commands. |
| `imageExtension`, `linksExtension` | `resolveUrl(kind, ref)` resolves application schemes. `openImage(image, url, label)` and `openLink(url, ref, label)` keep previews and navigation in the host. Without callbacks, links use document navigation and images open their URL in a new tab. Unresolved custom schemes stay source. |
| `imageExtension` | `foreignImagesAsLinks: true` renders images from other origins as links without fetching them. The default renders images as before. |
| `mermaidExtension` | Required `configuration({ dark })` returns a Mermaid configuration. Optional `title(markdown)` names fullscreen views and exports; `locale` sets the detached preview's locale. Rendering is serialized, and cached SVGs are separated by configuration callback and theme. |
| `infoBlocksExtension` | Pass the current locale for untitled notice labels. |

For application directive ranges, the subpath exports `extractDataBlocks` and
`extractNotebookDirectiveRanges`. The latter scans `query`, `toc`, `chart`, and
`map` source geometry; query validation, data access, and chart rendering stay
with the application.

`customLightInit`, `customDarkInit`, `rawLightInit`, and `rawDarkInit` use
`--editor-measure` for the content width, defaulting to the available width.
Set this variable on the editor or an ancestor to match the host's reading
column. The themes retain their CodeMirror selectors, so host styles for
comments and document layout can still target the editor.

Source parsers also have direct `@k2b/editor/markdown/lib/*` entry points,
so server and CLI consumers can load them without the editor widgets.

The preview helpers `inline-syntax`, `math-syntax`, `fade-scroll-margins`,
`mermaid-render`, `mermaid-viewport`, and `urls` also have direct imports
under `@k2b/editor/markdown/` to keep read-only previews and print independent
of the full extension set.
