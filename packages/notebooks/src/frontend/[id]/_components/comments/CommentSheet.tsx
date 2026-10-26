import { BottomSheet, bottomSheetOptions, dialogCore, LocaleProvider } from "@k2b/ui";
import { createEffect, For, Show } from "solid-js";
import { CommentCard } from "./CommentCard";
import { CommentComposer } from "./CommentComposer";
import { type CommentsUi, isOpen } from "./comments-ui";

/** A passage in a sheet's title, short enough for one line on a phone. */
const short = (quote: string) => (quote.length > 34 ? `${quote.slice(0, 32)} …` : quote);

/**
 * Comments on a phone: one sheet that shows what is going on, the comment being written, the comment opened from its
 * passage, or the list of open comments. It closes when there is nothing left to show.
 */
export const openCommentSheet = (ui: CommentsUi, locale: string, list: () => boolean, onClosed: () => void) =>
  dialogCore
    .open<void>((close, context) => {
      const t = () => ui.t();
      const active = () => ui.byId(ui.active());
      const empty = () => !ui.draft() && !active() && !list();
      createEffect(() => {
        if (empty()) close();
      });
      const dismiss = () => {
        ui.setDraft(null);
        ui.setActive(null);
        void context.requestDismiss();
      };
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
                      <BottomSheet.Body>
                        <div class="notebook-comments-sheet">
                          <For each={ui.visible().filter(isOpen)}>{(item) => <CommentCard ui={ui} item={item} />}</For>
                        </div>
                      </BottomSheet.Body>
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
    }, bottomSheetOptions)
    .finally(onClosed);
