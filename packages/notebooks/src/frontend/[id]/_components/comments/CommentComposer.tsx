import { CloudAvatar } from "@k2b/cloud/account/ui";
import { Button, TextInput } from "@k2b/ui";
import { type JSX, Show } from "solid-js";
import { SuggestionDiff } from "./CommentCard";
import type { CommentsUi } from "./comments-ui";

/**
 * Writing a new comment at its passage: the text, an optional replacement for the passage with its difference, and
 * the save that keeps the text when it fails.
 */
export function CommentComposer(props: { ui: CommentsUi; ref?: (element: HTMLElement) => void; style?: JSX.CSSProperties }) {
  const t = () => props.ui.t();
  const draft = () => props.ui.draft();
  // A retry of the same text keeps its key, so a save that did arrive is not made twice; changed text is a new save.
  const update = (patch: Partial<NonNullable<ReturnType<CommentsUi["draft"]>>>) =>
    props.ui.setDraft(
      (current) =>
        current && { ...current, ...patch, failed: false, idempotencyKey: current.failed ? crypto.randomUUID() : current.idempotencyKey },
    );
  const changed = () => {
    const current = draft();
    return !!current && current.suggestion !== null && current.suggestion !== current.quote;
  };
  const ready = () => !!draft()?.body.trim() || changed();
  const keys = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void props.ui.saveDraft();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.ui.setDraft(null);
    }
  };
  return (
    <Show when={draft()}>
      {(current) => (
        <section
          ref={(element) => {
            props.ref?.(element);
            requestAnimationFrame(() => element.querySelector("textarea")?.focus({ preventScroll: true }));
          }}
          class="notebook-comment"
          data-active=""
          data-composer=""
          style={props.style}
          aria-label={t().commentLabel}
          onKeyDown={keys}
        >
          <div class="notebook-comment__who">
            <CloudAvatar username={props.ui.me.name} userId={props.ui.me.id} size="xs" />
            <b>{t().you}</b>
          </div>
          <div class="notebook-comment__compose">
            <TextInput
              icon={false}
              multiline
              lines={3}
              aria-label={t().commentLabel}
              placeholder={t().write}
              value={current().body}
              disabled={current().saving}
              onValueChange={(body: string) => update({ body })}
            />
            <Show
              when={current().suggestion !== null}
              fallback={
                <button type="button" class="notebook-comment__suggest" onClick={() => update({ suggestion: current().quote })}>
                  <i class="ti ti-pencil" aria-hidden="true" />
                  {t().suggest}
                </button>
              }
            >
              <TextInput
                icon={false}
                multiline
                lines={2}
                label={t().replaceWith}
                value={current().suggestion ?? ""}
                disabled={current().saving}
                onValueChange={(suggestion: string) => update({ suggestion })}
              />
              <p class="notebook-comment__diff" aria-live="polite">
                <Show when={changed()} fallback={<span class="notebook-comment__hint">{t().diffHint}</span>}>
                  <SuggestionDiff from={current().quote} to={current().suggestion ?? ""} />
                </Show>
              </p>
            </Show>
            <Show when={current().failed}>
              <p class="notebook-comment__error" role="alert">
                {t().notSaved}
              </p>
            </Show>
            <div class="notebook-comment__row">
              <span class="notebook-comment__hint">⌘↵</span>
              <Button size="sm" variant="ghost" disabled={current().saving} onClick={() => props.ui.setDraft(null)}>
                {t().cancel}
              </Button>
              <Button size="sm" loading={current().saving} disabled={!ready()} onClick={() => void props.ui.saveDraft()}>
                {current().saving ? t().saving : current().failed ? t().retry : t().comment}
              </Button>
            </div>
          </div>
        </section>
      )}
    </Show>
  );
}
