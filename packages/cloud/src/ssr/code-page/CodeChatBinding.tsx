import { refreshCurrentPath } from "@k2b/ssr/nav";
import { Button, NoticeCard, toast } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import type { CodeChatBinding } from "./data";
import type { PageText } from "./page-kit";

/** The chooser loads only when the owner opens it; the page's first download stays as it was. */
const choose = (codeId: string, binding: CodeChatBinding, text: PageText) =>
  import("./CodeChatChooser").then((module) => module.openCodeChatChooser({ codeId, binding, text }));

/** "Choose another chat" under the chat row of "What it may do", only for the owner. */
export function CodeChatChooseOther(props: { codeId: string; binding: CodeChatBinding; text: PageText }) {
  return (
    <Show when={props.binding.canChange}>
      <span class="cloud-code__row-act">
        <Button variant="text" size="sm" onClick={() => void choose(props.codeId, props.binding, props.text)}>
          {props.text.t().chatChooseOther}
        </Button>
      </span>
    </Show>
  );
}

/**
 * The chat of the automation is archived or deleted: it writes nothing until a chat is chosen. The owner chooses one
 * or restores the archived chat; anyone else learns who can.
 */
export function CodeChatMissing(props: { codeId: string; binding: CodeChatBinding; text: PageText }) {
  const t = props.text.t;
  const [restoring, setRestoring] = createSignal(false);
  const missing = () => (props.binding.chat?.state === "unavailable" ? props.binding.chat : null);
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
          title={
            chat().title
              ? t().chatMissingArchived({ title: chat().title! })
              : chat().reason === "deleted"
                ? t().chatMissingGone
                : t().chatMissingSome
          }
          detail={props.binding.canChange ? t().chatMissingDetail : t().chatMissingOther}
          actions={
            <Show when={props.binding.canChange}>
              <Button type="button" size="sm" variant="secondary" onClick={() => void choose(props.codeId, props.binding, props.text)}>
                {t().chatChoose}
              </Button>
              <Show when={chat().reason === "archived" && chat().id}>
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
