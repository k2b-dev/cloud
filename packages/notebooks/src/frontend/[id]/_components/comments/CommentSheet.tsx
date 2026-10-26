import { BottomSheet, Button, bottomSheetAdaptiveOptions, bottomSheetOptions, dialogCore, LocaleProvider } from "@k2b/ui";
import { createEffect, createMemo, For, Show } from "solid-js";
import { CommentCard } from "./CommentCard";
import { CommentComposer } from "./CommentComposer";
import type { CommentsUi } from "./comments-ui";

/** A passage in a sheet's title, short enough for one line on a phone. */
const short = (quote: string) => (quote.length > 34 ? `${quote.slice(0, 32)} …` : quote);

/**
 * Comments on a phone: one sheet that shows what is going on, the comment being written, the comment opened from its
 * passage, or the list of comments. It closes when there is nothing left to show. Where dots stand beside the lines,
 * the same list opens as a dialog, and a comment chosen there opens at its passage instead.
 */
export const openCommentSheet = (ui: CommentsUi, locale: string, list: () => boolean, listOnly: () => boolean, onClosed: () => void) =>
  dialogCore
    .open<void>(
      (close, context) => {
        const t = () => ui.t();
        const active = () => ui.byId(ui.active());
        const empty = () => !ui.draft() && !active() && !list();
        createEffect(() => {
          if (empty() || (listOnly() && (ui.active() || ui.draft()))) close();
        });
        // Cards keep their identity across reloads, so a reply being typed survives a live update.
        const ids = createMemo(() => ui.visible().map((item) => item.id), [], { equals: (a, b) => a.join() === b.join() });
        const dismiss = () => {
          ui.setDraft(null);
          ui.setActive(null);
          void context.requestDismiss();
        };
        const listBody = () => (
          <div class="notebook-comments-sheet" aria-live="polite">
            <Show
              when={!ui.store.error()}
              fallback={
                <p class="notebook-comments-sheet__state" role="alert">
                  <span class="notebook-comments__error">{t().loadFailed}</span>{" "}
                  <Button size="sm" variant="ghost" onClick={() => void ui.store.refresh()}>
                    {t().retry}
                  </Button>
                </p>
              }
            >
              <Show when={ui.store.projection()} fallback={<p class="notebook-comments-sheet__state">{t().loading}</p>}>
                <Show when={ui.counts().resolved}>
                  <button
                    type="button"
                    class="notebook-comments__toggle notebook-comments-sheet__toggle"
                    onClick={() => ui.setShowResolved(!ui.showResolved())}
                  >
                    {ui.showResolved() ? t().hideResolved : t().resolvedCount({ count: ui.counts().resolved })}
                  </button>
                </Show>
                <Show when={ids().length} fallback={<p class="notebook-comments-sheet__state">{t().empty}</p>}>
                  <For each={ids()}>{(id) => <Show when={ui.byId(id)}>{(item) => <CommentCard ui={ui} item={item()} />}</Show>}</For>
                </Show>
              </Show>
            </Show>
          </div>
        );
        return (
          <LocaleProvider locale={locale}>
            <BottomSheet onDismiss={dismiss} dismissLabel={t().close}>
              <Show
                when={ui.draft()}
                fallback={
                  <Show
                    when={active()}
                    fallback={
                      <>
                        <BottomSheet.Header title={t().open({ count: ui.counts().open })} close={dismiss} />
                        <BottomSheet.Body>{listBody()}</BottomSheet.Body>
                      </>
                    }
                  >
                    {(item) => (
                      <>
                        <BottomSheet.Header title={`„${short(item().quote)}“`} close={dismiss} />
                        <BottomSheet.Body>
                          <div class="notebook-comments-sheet">
                            <CommentCard ui={ui} item={item()} />
                          </div>
                        </BottomSheet.Body>
                      </>
                    )}
                  </Show>
                }
              >
                {(draft) => (
                  <>
                    <BottomSheet.Header title={t().commentOn({ quote: short(draft().quote) })} close={dismiss} />
                    <BottomSheet.Body>
                      <div class="notebook-comments-sheet">
                        <CommentComposer ui={ui} />
                      </div>
                    </BottomSheet.Body>
                  </>
                )}
              </Show>
            </BottomSheet>
          </LocaleProvider>
        );
      },
      listOnly() ? bottomSheetAdaptiveOptions : bottomSheetOptions,
    )
    .finally(onClosed);
