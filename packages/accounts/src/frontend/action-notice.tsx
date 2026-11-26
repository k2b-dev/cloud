import type { AccountActionNoticeInput } from "@k2b/cloud/shared";
import { i18n } from "@k2b/stdlib";
import { Button, Dialog, Prose, useToast } from "@k2b/ui/v2";
import { createSignal, type JSX, onMount } from "solid-js";
import { render } from "solid-js/web";
import { apiClient } from "../api/client";
import type { AccountsMessages } from "./messages";

/** The two short words of the notice's own surfaces. */
const noticeMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: { done: "Done", failed: "Notice not shown" },
    de: { done: "Fertig", failed: "Hinweis nicht angezeigt" },
  },
});

/**
 * Shows a surface that belongs to no island, such as the notice after a deed: in a v2 scope of its own at the end of
 * the page, removed again when it is done. The words follow the page's language.
 */
// k2b-ui gap: v2 has no way to show a dialog or a toast from code outside an island; Dialog.confirm does exactly this
// inside @k2b/ui (a `k2-ui` host at the end of the body), so the notice repeats that until v2 offers it.
const showOutside = (view: (done: () => void) => JSX.Element) =>
  new Promise<void>((resolve) => {
    const host = document.createElement("div");
    host.className = "k2-ui";
    host.style.display = "contents";
    document.body.append(host);
    let stop = () => {};
    const done = () => {
      stop();
      host.remove();
      resolve();
    };
    stop = render(() => view(done), host);
  });

const words = () => noticeMessages.resolve([document.documentElement.lang || "en"]).t;

/** The follow-up steps an operator configured for a deed, as Markdown in a dialog the person closes. */
const NoticeDialog = (props: { title: string; markdown: string; done: () => void }) => {
  const [open, setOpen] = createSignal(true);
  const close = () => {
    setOpen(false);
    props.done();
  };
  return (
    <Dialog
      title={props.title}
      open={open()}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      foot={
        <Button variant="primary" onClick={close}>
          {words().done}
        </Button>
      }
    >
      <Prose markdown={props.markdown} />
    </Dialog>
  );
};

/** One toast that says the notice could not be shown; it leaves when the toast does. */
const NoticeFailed = (props: { done: () => void }) => {
  const toast = useToast();
  onMount(() => {
    toast(words().failed, { status: "bad" });
    // the toast stands five seconds; its region leaves with this host after that
    setTimeout(props.done, 6_000);
  });
  return null;
};

/**
 * Shows the operator's follow-up notice for a deed that succeeded. Never turn a successful mutation into a failure
 * because a follow-up failed: a notice that cannot be read says so in a short toast. `messages` names the dialog.
 */
export const showAccountActionNotice = async (
  input: AccountActionNoticeInput,
  messages: Pick<AccountsMessages, "actionNotice" | "creationNoticeFailed">,
) => {
  try {
    // A non-essential follow-up gets five seconds; the completed action must
    // remain usable even when the notice endpoint is unavailable.
    const response = await apiClient["action-notice"].$post({ json: input }, { init: { signal: AbortSignal.timeout(5_000) } });
    if (!response.ok) throw new Error("Notice unavailable");
    const notice = await response.json();
    if (notice.failed) throw new Error("Notice unavailable");
    const markdown = notice.markdown;
    if (markdown) await showOutside((done) => <NoticeDialog title={messages.actionNotice} markdown={markdown} done={done} />);
  } catch {
    void showOutside((done) => <NoticeFailed done={done} />);
  }
};
