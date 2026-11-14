# Discussion

`Discussion` gives notes, comments, and short collaborative threads one portable visual and accessible structure. It owns the labelled surface, Markdown composer lifecycle, loading and retry presentation, automatic history loading, author alignment, metadata rhythm, and progressive item actions. The application owns storage, permissions, queries, mutations, author identity, and domain copy.

## Import

```tsx
import { Avatar, Discussion, MarkdownView } from "@k2b/ui";
import { For } from "solid-js";
```

## Use Discussion

Pass `label`, an optional `icon`, and a numeric `count` to `Discussion`. The label already names the domain, so the count renders as a number without repeating “comments” or “notes”. Pass the server-side total when pages are incomplete; omit the count while no accurate total is available.

The header is a [detail panel section](/en/ui/layout/detail-panel) heading wherever the discussion appears: the same icon column with a muted icon, the same sentence-case title, the `count` chip immediately after the title (“None yet” for zero), and ghost `actions` in the section action color. Inside a `DetailPanel` the default surface becomes one of the panel's flat frames, the same surface and inset as a `DetailPanel.Group`, with no border. Place it directly in `DetailPanel.Body`; it needs no group or wrapper. Placed in a `DetailPanel.Group` it is one of the group's sections, and inside a section it adds no frame or inset of its own. Outside a detail panel the default surface stays a bordered card.

Use `as="h2"` when the discussion is a primary page section and `surface="bare"` when the host already supplies its surface, such as a paper card or a dialog. Header `actions` hold compact domain commands such as opening a conditional composer; use `size="xs"` buttons so the header keeps the section row height.

Use `fold={3}` on `Discussion.List` to show the newest three loaded entries.
A “Show n older” toggle sits above them and becomes “Show less” while expanded.
Earlier pages load only when the fold is expanded. Omit `fold` to show every
loaded entry. Use `expanded` and `onExpandedChange` to control the fold, for
example when an activity link reveals an older comment. The callback requests
a change; the supplied `expanded` value remains authoritative.

The composer field has the same white field and edge as the other inputs in a panel. `Discussion.Composer` owns its initial Markdown draft, empty-value validation, pending state, Ctrl/Cmd+Enter submission, and submit button. Every `onSubmit` result except `false` accepts the submission and clears the draft. Returning `false` keeps it silently; throwing keeps it and shows the error inline until the draft changes, also when the user clears it. Mutation helpers that capture errors instead of throwing must therefore return `false` explicitly. Use `initialValue` and `onCancel` for an edit composer. `onCancel` only invokes the callback, so unmount the composer there when cancellation should discard its draft. Remount the composer when its resource identity changes so a draft cannot move to another record.

`Discussion.List` renders compact initial-loading and error rows. Render entries chronologically from oldest to newest and prepend each earlier page. With `hasMore` and `onLoadMore`, the list starts with the shared [`LoadMore`](/en/ui/content/load-more) edge: it loads earlier entries when the top of the list comes into view, and its "Load earlier" button remains as an accessible fallback. Return `false` when no page was applied; every other result tells the list to preserve the visible position after the prepend. It guards duplicate requests, and a rejected load shows its message with "Try again" in the edge's row.

Each `Discussion.Item` receives `author` and body content plus optional `avatar`, `timestamp`, `meta`, `replyContext`, and `actions`. Timestamps end at the trailing text edge; item actions sit immediately before
them, after optional metadata. Item actions are progressive with a mouse or trackpad, including a tablet with a mouse, by default; use `actionVisibility="always"` only when they must remain persistently visible.

Do not add a second scroll container to the list. A surrounding `DetailPanel.Body` or page remains the single scroll owner. An empty list renders no placeholder; “None yet” in the discussion header and an available composer are sufficient.

## Example

```tsx
<Discussion label="Comments" icon="ti ti-messages" count={comments.total}>
  <Discussion.Composer
    label="Add comment"
    placeholder="Write a comment in markdown…"
    submitLabel="Post comment"
    onSubmit={(body) => createComment(body)}
  />

  <Discussion.List
    loading={comments.loading}
    loadingLabel="Loading comments"
    error={comments.error}
    onRetry={comments.retry}
    hasMore={comments.hasMore}
    loadingMore={comments.loadingMore}
    loadMoreLabel="Load earlier comments"
    onLoadMore={comments.loadMore}
  >
    <For each={comments.items}>
      {(comment) => (
        <Discussion.Item
          avatar={<Avatar name={comment.authorName} size="xs" />}
          author={comment.authorName}
          timestamp={<time dateTime={comment.createdAt}>{comment.relativeTime}</time>}
          meta={comment.edited ? "edited" : undefined}
          actions={comment.actions}
        >
          <MarkdownView markdown={comment.body} headingScale="compact" />
        </Discussion.Item>
      )}
    </For>
  </Discussion.List>
</Discussion>
```

Applications still decide whether the composer is present, map domain records to items, and enforce create, edit, or delete permissions. `Discussion` never receives domain records or authorization rules.

## Compact thread

`Discussion.Thread` is a compact thread for a place that is already a surface,
such as a comment on a line of code. It has no surface of its own: one 1px line
in `--k2b-control-border-soft` runs at its start and turns 2px in
`--k2b-edge-focus` while someone writes; the padding gives the pixel back, so no
text moves. The line is the logical start edge, so it follows the reading
direction and shows in forced colours.

- Every entry is a `Discussion.Item` with the same form: an 18px avatar, name
  and time in one line (pass the role as `meta` on the first entry), and the
  text below. All entries stand flush on one edge 11px from the line, 8px
  apart; replies are not indented, a reply to a reply simply follows. An item
  action, such as "Delete" on someone's own comment, sits at the end of the
  header line without making it taller.
- The last line is a real field with the `placeholder`, such as "Reply …", on
  the avatars' edge; the placeholder also names both fields. A click, Enter,
  the first character, or focus from outside the thread opens the writing
  field in the same place. Tab from the thread itself, as after cancelling,
  reaches the field without opening it. An input method finishes composing
  first.
- The writing field has at least two lines and grows with its text, always one
  line more than it holds, measured at the width the comment will have after
  its avatar, and again when the column gets narrower. With its action row it
  is exactly as high as the comment it becomes plus the reply line, so posting
  changes no height. The row holds `hint` at its start, at most two lines, such
  as who will see the comment and when, and "Cancel" and `submitLabel` at its
  end. An empty comment cannot be posted.
- Cmd/Ctrl+Enter posts. Escape leaves an empty field; written text stays until
  "Cancel". An empty field also closes when the focus leaves the thread, so
  moving through a page leaves no thread open. When posting fails, the text
  stays, the focus stays in the field, the hint line names the cause through an
  alert region that is always there, and the button reads "Retry"; nothing
  moves. After posting or cancelling, the focus stays on the thread.
- Without `onSubmit` the thread is read only, as after a decision: no reply
  field and no writing.
- Type: name 13/600, text 13/400, role, time, and hint 12/400.

Control the writing state with `writing` and `onWritingChange`, or open a new
thread on a line with `defaultWriting`. The host still owns the entries,
permissions, deleting (as an item action), and paging: with `hasMore`, "Load
earlier" above the first entry calls `onLoadMore`; it never loads by itself.
Pass the entries directly; do not wrap them in `Discussion.List`.

```tsx
<Discussion.Thread
  label="Comments on line 3"
  placeholder="Reply …"
  hint="Visible with your decision"
  submitLabel="Comment"
  onSubmit={(text) => saveComment(text)}
>
  <For each={comments()}>
    {(comment, index) => (
      <Discussion.Item
        avatar={<Avatar name={comment.name} size="sm" />}
        author={comment.name}
        meta={index() === 0 ? comment.role : undefined}
        timestamp={<time dateTime={comment.at}>{comment.ago}</time>}
      >
        {comment.text}
      </Discussion.Item>
    )}
  </For>
</Discussion.Thread>
```

## API reference

```ts
type DiscussionProps = Omit<JSX.HTMLAttributes<HTMLElement>, "children" | "class"> & {
  label: JSX.Element; children: JSX.Element; icon?: string | false; count?: number; actions?: JSX.Element;
  as?: "h2" | "h3"; surface?: "default" | "bare"; class?: string;
};

type DiscussionComposerProps = Omit<JSX.FormHTMLAttributes<HTMLFormElement>, "children" | "class" | "onSubmit"> & {
  label: string; onSubmit: (message: string) => boolean | void | Promise<boolean | void>;
  initialValue?: string; placeholder?: string; submitLabel?: string; cancelLabel?: string;
  onCancel?: () => void; lines?: number; class?: string;
};

type DiscussionListProps = {
  children?: JSX.Element; loading?: boolean; loadingLabel?: string; error?: string | null;
  onRetry?: () => void | Promise<void>; hasMore?: boolean; loadingMore?: boolean; loadMoreLabel?: string;
  onLoadMore?: () => boolean | void | Promise<boolean | void>; fold?: number;
  expanded?: boolean; onExpandedChange?: (expanded: boolean) => void; class?: string;
};

type DiscussionItemProps = Omit<JSX.LiHTMLAttributes<HTMLLIElement>, "children" | "class"> & {
  author: JSX.Element; children: JSX.Element; avatar?: JSX.Element; timestamp?: JSX.Element;
  meta?: JSX.Element; replyContext?: JSX.Element; actions?: JSX.Element;
  actionVisibility?: "always" | "progressive"; class?: string;
};
type DiscussionThreadProps = {
  label: string; children?: JSX.Element; onSubmit?: (message: string) => boolean | void | Promise<boolean | void>;
  placeholder: string; hint?: JSX.Element; submitLabel: string; cancelLabel?: string;
  writing?: boolean; onWritingChange?: (writing: boolean) => void; defaultWriting?: boolean;
  hasMore?: boolean; onLoadMore?: () => boolean | void | Promise<boolean | void>; loadMoreLabel?: string;
};
```

These props map to `Discussion`, `.Composer`, `.List`, `.Item`, and `.Thread`. JSX slots remain application content; asynchronous submit and pagination behavior is described above.

## Accessibility

The root is a labelled `section`, the entries are an ordered list, and the composer is a native form. Loading and failures use status semantics, retry remains keyboard accessible, and automatic history loading has a manual fallback. Supply real `<time dateTime>` markup for timestamps and accessible names for every icon-only action. With any pointer that can hover, progressive item actions stay hidden until their row is hovered, keyboard-focused, or has its menu open. Touch-only screens always show them.

## Runtime

The root, list, and existing items are server-renderable. Composer state and automatic history loading activate after mount. Applications should seed the first authorized page during SSR and use an owner-local query for subsequent pages.
