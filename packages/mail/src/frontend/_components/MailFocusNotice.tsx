import { AppWorkspace, Button, NoticeCard, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { mailOverviewMessages } from "../mail-overview-messages";
import { readApiError } from "./api-response";

/**
 * Tells the person once, at the top of the sidebar, that Focus is gone and where its work is now. The server decides
 * `open`, so a closed notice never flashes on reload; closing it is stored for the person only on their click.
 */
export default function MailFocusNotice(props: { open: boolean }) {
  const locale = useLocale();
  const messages = createMemo(() => mailOverviewMessages.resolve([locale()]).t);
  const [open, setOpen] = createSignal(props.open);
  let notice: HTMLElement | undefined;
  const dismiss = async () => {
    // Keyboard focus moves on to the mailboxes instead of falling back to the page.
    const next = notice?.closest(".mail-sidebar")?.querySelector<HTMLElement>(".mail-sidebar-mailbox a");
    const hadFocus = notice?.contains(document.activeElement) ?? false;
    setOpen(false);
    if (hadFocus) next?.focus();
    try {
      const response = await apiClient.mailboxes.preferences["focus-notice"].$put();
      if (!response.ok) throw new Error(await readApiError(response, messages().failedCloseFocusNotice));
    } catch (error) {
      // Nothing was stored, so the notice comes back and can be closed again.
      setOpen(true);
      toast.error(error instanceof Error ? error.message : messages().failedCloseFocusNotice);
    }
  };
  return (
    <Show when={open()}>
      <AppWorkspace.SidebarSection>
        <NoticeCard
          ref={notice}
          role="status"
          class="mail-focus-notice"
          title={messages().focusNoticeTitle}
          detail={messages().focusNoticeDetail}
        >
          <Button variant="text" size="xs" onClick={() => void dismiss()}>
            {messages().focusNoticeDismiss}
          </Button>
        </NoticeCard>
      </AppWorkspace.SidebarSection>
    </Show>
  );
}
