# Discussion

`Discussion` gives notes, comments, and short collaborative threads one portable visual and accessible structure. It owns the labelled surface, Markdown composer lifecycle, loading and retry presentation, automatic history loading, author alignment, metadata rhythm, and progressive item actions. The application owns storage, permissions, queries, mutations, author identity, and domain copy.

## Import

```tsx
import { Avatar, Discussion, MarkdownView } from "@k2b/ui";
import { For } from "solid-js";
```

## Use Discussion

Pass `label`, an optional `icon`, and a numeric `count` to `Discussion`. The label already names the domain, so the count renders as a number without repeating “comments” or “notes”. Pass the server-side total when pages are incomplete; omit the count while no accurate total is available.

Use `as="h2"` when the discussion is a primary page section and `surface="bare"` when the host already supplies its surface. Header `actions` hold compact domain commands such as opening a conditional composer.

`Discussion.Composer` owns its initial Markdown draft, empty-value validation, pending state, Ctrl/Cmd+Enter submission, and submit button. Every `onSubmit` result except `false` accepts the submission and clears the draft. Returning `false` keeps it silently; throwing keeps it and shows the error inline. Mutation helpers that capture errors instead of throwing must therefore return `false` explicitly. Use `initialValue` and `onCancel` for an edit composer. `onCancel` only invokes the callback, so unmount the composer there when cancellation should discard its draft. Remount the composer when its resource identity changes so a draft cannot move to another record.

`Discussion.List` renders compact initial-loading and error rows. Render entries chronologically from oldest to newest and prepend each earlier page. With `hasMore` and `onLoadMore`, the list automatically loads earlier entries when its upper sentinel becomes visible. Return `false` when no page was applied; every other result tells the list to preserve the visible position after the prepend. It guards duplicate requests, and the small load action remains as an accessible fallback.

Each `Discussion.Item` receives `author` and body content plus optional `avatar`, `timestamp`, `meta`, `replyContext`, and `actions`. Item actions are progressive on fine pointers by default; use `actionVisibility="always"` only when they must remain persistently visible.

Do not add a second scroll container to the list. A surrounding `DetailPanel.Body` or page remains the single scroll owner. An empty list renders no placeholder; the numeric `0` in the discussion header and an available composer are sufficient.

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
  onLoadMore?: () => boolean | void | Promise<boolean | void>; class?: string;
};

type DiscussionItemProps = Omit<JSX.LiHTMLAttributes<HTMLLIElement>, "children" | "class"> & {
  author: JSX.Element; children: JSX.Element; avatar?: JSX.Element; timestamp?: JSX.Element;
  meta?: JSX.Element; replyContext?: JSX.Element; actions?: JSX.Element;
  actionVisibility?: "always" | "progressive"; class?: string;
};
```

These props map to `Discussion`, `.Composer`, `.List`, and `.Item`. JSX slots remain application content; asynchronous submit and pagination behavior is described above.

## Accessibility

The root is a labelled `section`, the entries are an ordered list, and the composer is a native form. Loading and failures use status semantics, retry remains keyboard accessible, and automatic history loading has a manual fallback. Supply real `<time dateTime>` markup for timestamps and accessible names for every icon-only action. Progressive item actions remain discoverable through keyboard focus and are never hidden on touch devices.

## Runtime

The root, list, and existing items are server-renderable. Composer state and automatic history loading activate after hydration. Applications should seed the first authorized page during SSR and use an owner-local query for subsequent pages.
