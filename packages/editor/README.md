# @k2b/editor

Configurable Markdown editor for SolidJS. An editor, a toolbar, a bubble menu,
and a slash menu share one editor state; applications place them where they
want and describe their actions as data.

```tsx
import { Editor, Toolbar, createEditor, markdownActions } from "@k2b/editor";

const editor = createEditor();
const actions = markdownActions("en");

<Toolbar editor={editor} groups={[{ items: [actions.bold, actions.italic] }]} />
<Editor editor={editor} label="Note" maxLength={100_000} toolbar={false} />
```

The package builds on `@k2b/ui`'s text editor and does not depend on Cloud.
It ships TypeScript and Solid JSX source; bundle it with a Solid compiler, as
for `@k2b/ui` islands.

Documentation: <https://github.com/k2b-dev/cloud/blob/main/docs-site/docs/en/frontend/editor.md>

License: AGPL-3.0-or-later.
