# @k2b/editor

Configurable Markdown editor for SolidJS. An editor, a toolbar, a bubble menu,
and a slash menu share one editor state; applications place them where they
want and describe their actions as data.

```tsx
import { Editor, Toolbar, createEditor, markdownActions } from "@k2b/editor";

const editor = createEditor();
const actions = markdownActions(editor, "en");

<Toolbar editor={editor} groups={[{ items: [actions.bold, actions.italic] }]} />
<Editor editor={editor} label="Note" maxLength={100_000} toolbar={false} />
```

Optional CodeMirror extensions and source parsers are exported from
`@k2b/editor/markdown`. Hosts supply directive ranges, URL resolution and
opening callbacks, and Mermaid configuration. Import `@k2b/editor/styles.css`
in the host's Tailwind stylesheet; the themes use `--editor-measure`
for the reading column.

The package builds on `@k2b/ui`'s text editor and does not depend on Cloud.
It ships TypeScript and Solid JSX source; bundle it with a Solid compiler, as
for `@k2b/ui` islands.

Documentation: <https://github.com/k2b-dev/cloud/blob/main/docs-site/docs/en/frontend/editor.md>

License: AGPL-3.0-or-later.

Source parsers also have direct `@k2b/editor/markdown/lib/*` entry points,
so server and CLI consumers can load them without the editor widgets.
