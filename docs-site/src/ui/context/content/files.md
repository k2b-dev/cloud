# File browser

`FileBrowserPanel`, `FileTree`, and `FileView` present application-owned file
data. They do not depend on Cloud storage, routes, permissions, or mutation
APIs.

## Use file components

Use `FileBrowserPanel` for the ready tree-and-preview composition over a
`FileSource`. Use `FileTree` for a different layout or selection flow. Use
`FileView` when a page already owns the selected file.

## Import

```tsx
import {
  FileBrowserPanel,
  FileTree,
  FileView,
  canPreviewFile,
  formatFileViewSize,
  getFileViewPreviewKind,
  openFileBrowser,
  type FileBrowserPanelProps,
  type FileSource,
  type FileTreeActions,
  type FileTreeEntry,
  type FileTreeProps,
  type FileViewContent,
  type FileViewFile,
  type FileViewPreviewKind,
  type FileViewProps,
  type FileViewRenderer,
  type FileViewRendererProps,
} from "@k2b/ui";
```

## FileSource

`FileSource` is the asynchronous boundary:

```ts
type FileSource = {
  list(): Promise<FileTreeEntry[]>;
  read(path: string): Promise<FileViewContent>;
  write?(path: string, content: string, encoding?: "utf8" | "base64"):
    Promise<void>;
  remove?(path: string): Promise<void>;
  rename?(from: string, to: string): Promise<void>;
  upload?(dirPath: string, files: File[]): Promise<void>;
  downloadHref?(path: string): string | null;
  isReadOnly?(path: string): boolean;
};
```

Only supplied capabilities receive matching controls. `readOnly` on
`FileBrowserPanel` hides every mutation even when the source implements it.
`isReadOnly` can protect individual paths such as generated inputs.
Capabilities are independent: for example, a source may offer `rename` or
`remove` without offering `write`.

The host authenticates every operation and checks authorization again inside
the source. Hiding a control is not an authorization boundary.

## Path-first tree

Each `FileTreeEntry` has an absolute-style path such as `/src/app.tsx`.
Folders are derived from file paths; explicit `{ path, kind: "folder" }`
entries represent empty folders. Optional `displayName` changes the visible and
accessible label; selection, reading, and renaming still use the original path.

`selectedPath` and `onSelect` own selection. `expandedPaths` and
`onExpandedChange` provide controlled expansion; otherwise folders start
expanded. `FileTreeActions` enables rename, remove, create, move, and download
affordances individually.

`contextMenu` adds application-specific menu items without replacing the
built-in actions.

## File previews

`FileView` receives a `FileViewFile`, an asynchronous `load` function, and
optional preview and download URLs. Text, Markdown, JSON, delimited text,
images, PDF, audio, and video use built-in renderers. Supplying `save` enables
editing for compatible text renderers.

Pass `revision` to refetch a `FileView` whose path did not change. A
`FileBrowserPanel` forwards its `refreshKey` to both the file list and the
selected preview.

Markdown files edit through `MarkdownEditor`. Other UTF-8 source and text files
use a plain monospace textarea inside the same editor chrome, so Markdown
formatting controls and completions are not offered for code.

`FileViewContent` is either UTF-8 or base64:

```ts
type FileViewContent = {
  encoding: "utf8" | "base64";
  content: string;
  mediaType: string;
};
```

`getFileViewPreviewKind` returns the inferred `FileViewPreviewKind`.
Both helpers apply the built-in size limits when `size` is supplied: 2 MiB for text, Markdown, JSON and delimited text; 25 MiB for images; 50 MiB for PDF, audio, and video. Unsupported or oversized files return `null` from `getFileViewPreviewKind` and `false` from `canPreviewFile`.
`formatFileViewSize` produces the compact size label used by the preview.

Pass `renderers` to `FileView` or `FileBrowserPanel` to add
application-specific renderers before the built-ins. Extensions are scoped to
that component instance, so concurrent SSR requests and independently mounted
applications cannot mutate each other's renderer set.

`FileView` reports local edits through `onDirtyChange`. `FileBrowserPanel`
uses that signal to guard selection changes; pass `confirmDiscard` to own the
confirmation copy and policy. Without it, the shared confirmation prompt is
used.

## Dialog helper

`openFileBrowser({ source, title, subtitle, icon })` opens the shared panel in
a dialog and resolves when it closes. The supplied source has the same
capability and authorization responsibilities as an inline panel.

## API reference

```ts
type FileTreeEntry = {
  path: string; displayName?: string; kind?: "file" | "folder"; size?: number; mediaType?: string;
  updatedAt?: string; icon?: string; badge?: string;
};

type FileTreeActions = {
  rename?: (path: string, nextName: string) => void | Promise<void>;
  remove?: (path: string) => void | Promise<void>; createFile?: (dirPath: string) => void | Promise<void>;
  createFolder?: (dirPath: string) => void | Promise<void>;
  move?: (path: string, targetDir: string) => void | Promise<void>;
  download?: (path: string, isFolder: boolean) => void | Promise<void>;
};

type FileTreeProps = {
  entries: FileTreeEntry[]; selectedPath?: string | null; onSelect?: (entry: FileTreeEntry) => void;
  expandedPaths?: Set<string>; onExpandedChange?: (expanded: Set<string>) => void;
  contextMenu?: (entry: FileTreeEntry) => DropdownItem[]; actions?: FileTreeActions; label?: string;
  class?: string;
};

type FileViewFile = {
  path: string; mediaType?: string; size?: number;
};

type FileViewPreviewKind = "markdown" | "image" | "pdf" | "json" | "delimited-text" | "audio" | "video" | "text";

type FileViewRendererProps = {
  file: FileViewFile; content: FileViewContent; previewHref: string | null; downloadHref: string | null;
  editor: {
    draft: () => string;
    setDraft: (value: string) => void;
    dirty: () => boolean;
    saving: () => boolean;
    save: () => Promise<void>;
  } | null;
};

type FileViewRenderer = {
  id: string; match: (file: FileViewFile, content: FileViewContent) => boolean;
  component: Component<FileViewRendererProps>; editable?: boolean;
};

type FileViewProps = {
  file: FileViewFile; load: () => Promise<FileViewContent>; revision?: unknown;
  registerRefresh?: (refresh: () => Promise<void>) => void | (() => void);
  save?: (content: string) => Promise<void>; previewHref?: string | null; downloadHref?: string | null;
  renderers?: readonly FileViewRenderer[]; onDirtyChange?: (dirty: boolean) => void; class?: string;
};

type FileBrowserPanelProps = {
  source: FileSource; readOnly?: boolean; refreshKey?: unknown; initialPath?: string;
  onSelectedPathChange?: (path: string | null) => void; renderers?: readonly FileViewRenderer[];
  confirmDiscard?: (path: string, nextPath: string | null) => boolean | Promise<boolean>; class?: string;
  registerRefresh?: (refresh: () => Promise<void>) => void | (() => void);
};
```

`FileSource` and `FileViewContent` are defined above. `Component<P>` is a Solid component taking `P` and returning JSX. Renderer order matters: the first matching custom renderer wins before built-ins. Its `editable` capability and the supplied `save` determine editing availability. `registerRefresh` receives a refresh function and may return cleanup; the host should release stored references on cleanup. `onSelectedPathChange` reports selection; `initialPath` initializes it rather than controlling it. `refreshKey`/`revision` may be any changing identity.

`contextMenu` returns [DropdownItem](/en/ui/actions/menus#api-reference) entries. `FileTreeActions.rename` receives a path and new **name**; `FileSource.rename` receives full from/to **paths**. Size fields are bytes. `getFileViewPreviewKind(file: FileViewFile): FileViewPreviewKind | null` infers the format; `canPreviewFile(file: FileViewFile): boolean` applies format and size support; `formatFileViewSize(bytes: number): string` formats bytes.

## Accessibility

`FileTree` exposes tree and tree-item roles with arrow-key navigation.
Selection, expansion, context actions, preview actions, and text editing
remain keyboard reachable.

## Runtime

The static tree and preview shells render on the server. Resource loading,
selection, editing, drag and drop, media controls, prompts, and dialogs
require hydration.

## Example

```tsx
const entries = (): FileTreeEntry[] =>
  Object.entries(contentByPath).map(([path, content]) => ({
    path,
    mediaType: path.endsWith(".md") ? "text/markdown" : "text/plain",
    size: new TextEncoder().encode(content).byteLength,
  }));

const source: FileSource = {
  list: async () => entries(),
  read: async (path) => ({
    encoding: "utf8",
    content: contentByPath[path] ?? "",
    mediaType: path.endsWith(".md") ? "text/markdown" : "text/plain",
  }),
  write: async (path, content) => {
    contentByPath[path] = content;
  },
  rename: async (from, to) => {
    contentByPath[to] = contentByPath[from] ?? "";
    delete contentByPath[from];
  },
  remove: async (path) => {
    delete contentByPath[path];
  },
};

<FileBrowserPanel
  source={source}
  initialPath="/README.md"
  renderers={applicationRenderers}
  confirmDiscard={(path) => confirm(`Discard changes to ${path}?`)}
/>;
```

## Direct composition

```tsx
<FileTree
  entries={entries()}
  selectedPath={selectedPath()}
  onSelect={(entry) => setSelectedPath(entry.path)}
/>

<FileView
  file={{ path: selectedPath(), mediaType: "text/plain" }}
  load={() => source.read(selectedPath())}
  save={(content) => source.write!(selectedPath(), content)}
  renderers={applicationRenderers}
/>
```

## Paginated list and grid views

Use `FileGrid` with `createCollectionSelection` when the host owns a paginated
collection rather than an entire tree. Pass the same controller to
`DataTable.selection` and `FileGrid.selection` to preserve selection when changing
views. Both require stable `getRowId` values. The controller's `ids` accessor is
the selectable collection in display order; removed IDs are pruned.

```tsx
const selection = createCollectionSelection({ ids: () => entries().map(file => file.path) });
<FileGrid
  rows={entries()}
  getRowId={file => file.path}
  selection={selection}
  label="Files"
  size="md"
  renderPreview={file => <i class={file.icon} aria-hidden="true" />}
  renderLabel={file => file.name}
  renderMeta={file => file.sizeLabel}
  onOpen={openFile}
/>
```

Click selects, Ctrl/Cmd-click toggles, and Shift-click selects a range. Arrow keys,
Home, and End navigate; Space toggles, Ctrl/Cmd-A selects the supplied collection,
and Escape clears it. Enter and double-click call `onOpen` (or
`DataTable.onRowDoubleClick`). Nested controls retain their own behavior.
`renderActions` accepts host-owned buttons or checkboxes; `itemProps` adds
host attributes such as drag-and-drop handlers to each tile. The host owns data,
context menus, authorization, previews, and navigation; `onContextMenu` can align
selection before opening a menu. Use `sm`, `md`, or `lg` for tile size. `FileGrid`
has no scroll owner; place it in `ScrollArea`. A `DataTable` already owns scrolling.

For signed native media URLs, `FileView.crossOrigin="anonymous"` omits credentials
on cross-origin media requests. `onPreviewError` reports native image/audio/video
load errors so the host can request a fresh URL and offer retry. These options
leave existing media behavior unchanged when omitted. PDF and text content can
instead be fetched by the host with an abort signal and explicit byte limit.
