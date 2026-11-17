import { refreshCurrentPath } from "@k2b/ssr/nav";
import { Button, NoticeCard, toast } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import type { CodeChatBinding, CodePageReady } from "./data";
import type { PageText } from "./page-kit";

/** The chooser loads only when the owner opens it; the page's first download stays as it was. */
const choose = (codeId: string, binding: CodeChatBinding, text: PageText) =>
  import("./CodeChatChooser").then((module) => module.openCodeChatChooser({ codeId, binding, text }));

/**
 * Under the chat row of "What it may do": for the owner another chat, or a first one when none works. When Core could
 * not say which chat it is (`binding` null), the row says so with a way to read it again instead of going quiet.
 */
export function CodeChatRowAction(props: { codeId: string; binding: CodeChatBinding | null; text: PageText }) {
  const t = props.text.t;
  return (
    <Show
      when={props.binding}
      fallback={
        <span class="cloud-code__row-act cloud-code__row-act--failed">
          {t().chatReadFailed}
          <Button type="button" variant="link" size="sm" onClick={() => refreshCurrentPath()}>
            {t().tryAgain}
          </Button>
        </span>
      }
    >
      {(binding) => (
        <Show when={binding().canChange}>
          <span class="cloud-code__row-act">
            <Button type="button" variant="link" size="sm" onClick={() => void choose(props.codeId, binding(), props.text)}>
              {binding().chat?.state === "available" ? t().chatChooseOther : t().chatChoose}
            </Button>
          </span>
        </Show>
      )}
    </Show>
  );
}

/** Core's current-version notice decides whether this binding is a dependency. */
export const missingCodeChat = (state: CodePageReady) => {
  const binding = state.chatBinding;
  if (!binding || !state.words?.current?.notices.items.some((notice) => notice.code === "chat_missing")) return null;
  if (binding.chat?.state === "unavailable") return binding.chat;
  return binding.chat === null ? ({ state: "unbound" } as const) : null;
};

/**
 * The automation writes to a chat it does not have: never bound (`chat_unbound`), or its chat is archived or deleted
 * (`chat_unavailable`). It writes nothing until a chat is chosen. The owner chooses one or restores the archived chat;
 * anyone else learns who can.
 */
export function CodeChatMissing(props: { codeId: string; binding: CodeChatBinding; state: CodePageReady; text: PageText }) {
  const t = props.text.t;
  const [restoring, setRestoring] = createSignal(false);
  const missing = () => missingCodeChat(props.state);
  const restore = async (id: string, title: string | undefined) => {
    if (restoring()) return;
    setRestoring(true);
    const response = await fetch(`/api/ai/conversations/${encodeURIComponent(id)}/restore`, {
      method: "POST",
      credentials: "same-origin",
    }).catch(() => null);
    setRestoring(false);
    if (!response?.ok) {
      toast.error(t().chatRestoreFailed);
      return;
    }
    if (title) toast.success(t().chatRestored({ title }));
    refreshCurrentPath();
  };
  return (
    <Show when={missing()}>
      {(chat) => (
        <NoticeCard
          tone="danger"
          icon="ti ti-alert-circle"
          title={(() => {
            const current = chat();
            if (current.state === "unbound") return t().chatUnbound;
            if (current.title) return t().chatMissingArchived({ title: current.title });
            return current.reason === "deleted" ? t().chatMissingGone : t().chatMissingSome;
          })()}
          detail={(() => {
            const current = chat();
            if (!props.binding.canChange) return t().chatMissingOther;
            return current.state === "unavailable" && current.reason === "archived" ? t().chatMissingDetailRestore : t().chatMissingDetail;
          })()}
          actions={
            <Show when={props.binding.canChange}>
              <Button type="button" size="sm" variant="secondary" onClick={() => void choose(props.codeId, props.binding, props.text)}>
                {t().chatChoose}
              </Button>
              <Show
                when={(() => {
                  const current = chat();
                  return current.state === "unavailable" && current.reason === "archived" && current.id
                    ? { id: current.id, title: current.title }
                    : undefined;
                })()}
              >
                {(archived) => (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    loading={restoring()}
                    onClick={() => void restore(archived().id, archived().title)}
                  >
                    {t().chatRestore}
                  </Button>
                )}
              </Show>
            </Show>
          }
        />
      )}
    </Show>
  );
}
