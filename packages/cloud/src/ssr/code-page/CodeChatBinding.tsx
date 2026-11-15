import { refreshCurrentPath } from "@k2b/ssr/nav";
import { Button, NoticeCard, toast } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import type { CodeChatBinding } from "./data";
import type { PageText } from "./page-kit";

/** The chooser loads only when the owner opens it; the page's first download stays as it was. */
const choose = (codeId: string, binding: CodeChatBinding, text: PageText) =>
  import("./CodeChatChooser").then((module) => module.openCodeChatChooser({ codeId, binding, text }));

/** Under the chat row of "What it may do", only for the owner: another chat, or a first one when none works. */
export function CodeChatChooseOther(props: { codeId: string; binding: CodeChatBinding; text: PageText }) {
  return (
    <Show when={props.binding.canChange}>
      <span class="cloud-code__row-act">
        <Button variant="text" size="sm" onClick={() => void choose(props.codeId, props.binding, props.text)}>
          {props.binding.chat?.state === "available" ? props.text.t().chatChooseOther : props.text.t().chatChoose}
        </Button>
      </span>
    </Show>
  );
}

/**
 * The automation writes to a chat it does not have: never bound (`chat_unbound`), or its chat is archived or deleted
 * (`chat_unavailable`). It writes nothing until a chat is chosen. The owner chooses one or restores the archived chat;
 * anyone else learns who can. `usesChat`: the running version writes to its chat at all.
 */
export function CodeChatMissing(props: { codeId: string; binding: CodeChatBinding; usesChat: boolean; text: PageText }) {
  const t = props.text.t;
  const [restoring, setRestoring] = createSignal(false);
  const missing = () =>
    props.binding.chat?.state === "unavailable"
      ? props.binding.chat
      : props.binding.chat === null && props.usesChat
        ? ({ state: "unbound" } as const)
        : null;
  const restore = async (id: string) => {
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
          detail={props.binding.canChange ? t().chatMissingDetail : t().chatMissingOther}
          actions={
            <Show when={props.binding.canChange}>
              <Button type="button" size="sm" variant="secondary" onClick={() => void choose(props.codeId, props.binding, props.text)}>
                {t().chatChoose}
              </Button>
              <Show
                when={(() => {
                  const current = chat();
                  return current.state === "unavailable" && current.reason === "archived" ? current.id : undefined;
                })()}
              >
                {(id) => (
                  <Button type="button" size="sm" variant="secondary" loading={restoring()} onClick={() => void restore(id())}>
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
