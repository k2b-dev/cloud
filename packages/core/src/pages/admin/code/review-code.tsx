import { CloudAvatar } from "@k2b/cloud/account/ui";
import { formatRelative } from "@k2b/cloud/shared";
import type { DateContext } from "@k2b/stdlib";
import { Discussion, IconButton } from "@k2b/ui";
import { CodeDiff, type CodeDiffFile, type CodeDiffLocation } from "@k2b/ui/code-diff";
import { type Accessor, createMemo, For, Show } from "solid-js";
import type { CodeReviewComment } from "../../../code/review-contracts";
import type { CodeVersionDiffFile } from "../../../code/version-contracts";
import type { CodeReviewMessages } from "./review-messages";

/** Comments of one line, in time order; a reply stays under its line even without its root. */
export type ReviewThread = { key: string; path: string; line: number; entries: CodeReviewComment[]; rootId: string };

export type ReviewCodeProps = {
  view: "code" | "diff";
  files: CodeVersionDiffFile[] | null;
  /** Decided, or its outcome unclear: comments can no longer change. */
  closed: Accessor<boolean>;
  threads: Accessor<ReviewThread[]>;
  opened: Accessor<CodeDiffLocation | null>;
  setOpened: (location: CodeDiffLocation | null) => void;
  post: (path: string, line: number, body: string, parentId?: string) => Promise<boolean>;
  remove: (comment: CodeReviewComment) => void;
  deleteFailed: Accessor<string | null>;
  file: Accessor<string | undefined>;
  setFile: (path: string) => void;
  viewerId: string;
  dateConfig: DateContext;
  t: Accessor<CodeReviewMessages>;
};

/**
 * The code of one version under review with the comments at their lines, read only.
 *
 * k2b-ui gap: v2 has no code view with highlighting and no line threads yet; this keeps the code field of @k2b/ui
 * (CodeDiff with one tab stop, arrow keys and a comment action per line) and its Discussion threads as the inner
 * component of the review, which the v2 frame places in a Canvas.
 */
export function ReviewCode(props: ReviewCodeProps) {
  const t = () => props.t();
  const when = (iso: string) => formatRelative(iso, props.dateConfig);
  const threadAt = (path: string, line: number) => props.threads().find((thread) => thread.path === path && thread.line === line);
  const entry = (comment: CodeReviewComment, editable: boolean) => {
    const mine = comment.author.id === props.viewerId;
    const name = mine ? t().youCap : (comment.author.name ?? t().unknownAuthor);
    return (
      <Discussion.Item
        author={name}
        avatar={
          <CloudAvatar username={comment.author.name ?? name} userId={comment.author.id} avatarHash={comment.author.avatarHash} size="xs" />
        }
        meta={mine ? undefined : t().cloudAdmin}
        timestamp={<time dateTime={comment.createdAt}>{when(comment.createdAt)}</time>}
        actions={
          editable && mine ? (
            <IconButton label={t().deleteComment} size="sm" variant="ghost" onClick={() => props.remove(comment)}>
              <i class="ti ti-trash" aria-hidden="true" />
            </IconButton>
          ) : undefined
        }
      >
        <p class="core-code-review__comment">{comment.body}</p>
        <Show when={props.deleteFailed() === comment.id}>
          <p class="core-code-review__comment-error" role="alert">
            {t().deleteFailed}
          </p>
        </Show>
      </Discussion.Item>
    );
  };

  /** The thread directly under a line: comments flush, "Reply …" as its last line, writing in place. */
  const LineThread = (line: { path: string; line: number }) => {
    const thread = createMemo(() => threadAt(line.path, line.line));
    const writingHere = () => {
      const open = props.opened();
      return open?.path === line.path && open.line === line.line;
    };
    const editable = () => !props.closed();
    let box: HTMLDivElement | undefined;
    return (
      <div class="core-code-review__thread" ref={box}>
        <Discussion.Thread
          label={t().threadLabel({ path: line.path, n: line.line })}
          placeholder={thread() ? t().replyPlaceholder : t().commentPlaceholder({ n: line.line })}
          hint={t().visibleWithDecision}
          submitLabel={t().commentSubmit}
          cancelLabel={t().commentCancel}
          writing={writingHere() ? true : undefined}
          onWritingChange={(writing) => {
            if (writing) return;
            // Sent or cancelled: the focus goes back to the "+" of this line, also when a new thread closes with it.
            const code = box?.closest('[role="region"]');
            if (writingHere()) props.setOpened(null);
            setTimeout(() => code?.querySelector<HTMLElement>(`[data-action-line="${line.line}"]`)?.focus());
          }}
          onSubmit={editable() ? (message) => props.post(line.path, line.line, message, thread()?.rootId) : undefined}
        >
          <For each={thread()?.entries ?? []}>{(comment) => entry(comment, editable())}</For>
        </Discussion.Thread>
      </div>
    );
  };
  /** Lines that carry a thread now, plus the line whose new thread is open; CodeDiff keeps one element per line. */
  const slotLines = createMemo<CodeDiffLocation[]>(() => {
    const lines = props.threads().map((thread) => ({ path: thread.path, line: thread.line, side: "new" as const }));
    const open = props.opened();
    if (open && !lines.some((line) => line.path === open.path && line.line === open.line))
      lines.push({ path: open.path, line: open.line, side: "new" });
    return lines;
  });
  const files = createMemo<CodeDiffFile[]>(() =>
    props.view === "diff"
      ? (props.files ?? []).map((file) => ({ path: file.path, lines: file.lines }))
      : (props.files ?? [])
          .map((file) => ({
            path: file.path,
            lines: file.lines.filter((line) => line.kind !== "del").map((line) => ({ kind: "add" as const, text: line.text })),
          }))
          .filter((file) => file.lines.length > 0),
  );
  return (
    <div class="core-code-review__field" data-code-source-region="admin-approval">
      <CodeDiff
        files={files()}
        file={props.file()}
        onFileChange={props.setFile}
        status={props.files ? undefined : "error"}
        errorDescription={t().codeFailed}
        onRetry={() => window.location.reload()}
        label={t().codeLabel}
        toolbarStart={<i class="ti ti-file-code core-code-review__files-icon" aria-hidden="true" />}
        lineAction={
          props.closed()
            ? undefined
            : {
                label: (location) => t().commentOnLine({ n: location.line }),
                onSelect: (location) => {
                  if (threadAt(location.path, location.line)) props.setOpened({ ...location });
                  else props.setOpened({ path: location.path, line: location.line, side: "new" });
                },
              }
        }
        slotLines={slotLines()}
        lineSlot={(location) => <LineThread path={location.path} line={location.line} />}
      />
      <Show when={!props.closed()}>
        <p class="core-code-review__foot">
          <span class="core-code-review__keys">{t().keysHint}</span>
        </p>
      </Show>
    </div>
  );
}
