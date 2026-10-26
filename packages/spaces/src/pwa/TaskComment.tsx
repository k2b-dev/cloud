import { pwaDrafts } from "@k2b/cloud/browser/pwa-drafts";
import { Button, TextInput, toast, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { apiClient } from "@/api/client";
import { createRetryToasts } from "../frontend/lib/feedback";
import { overviewMessages } from "../frontend/overview-messages";
import { myTasksMessages } from "./messages";
import type { PwaTask } from "./task";

type Props = {
  task: Pick<PwaTask, "shortId" | "spaceShortId" | "spaceName" | "title">;
  userId: string;
};

/** Spaces' own limit for one comment. */
const COMMENT_MAX_LENGTH = 5000;

/**
 * A comment on the open task. What the person types stays a draft on the device until it is sent, so turning the
 * device, switching apps or the system ending the app loses nothing. A send that fails keeps the text and offers Retry.
 */
export default function TaskComment(props: Props) {
  const locale = useLocale();
  const t = () => myTasksMessages.resolve([locale()]).t;
  const o = () => overviewMessages.resolve([locale()]).t;
  const retryToast = createRetryToasts();
  const field = () => `spaces.comment:${props.task.spaceShortId}:${props.task.shortId}`;
  const requestField = () => `${field()}:request`;
  let requestId: string | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const [text, setText] = createSignal("");
  const [sending, setSending] = createSignal(false);
  // The server renders an empty field; the draft arrives after mounting, so both renders agree.
  const [mounted, setMounted] = createSignal(false);
  onMount(() => {
    setText(pwaDrafts.read(props.userId, field()) ?? "");
    requestId = text() ? pwaDrafts.read(props.userId, requestField()) : undefined;
    if (!text()) pwaDrafts.remove(props.userId, requestField());
    setMounted(true);
  });

  const change = (value: string) => {
    if (value !== text()) {
      requestId = undefined;
      pwaDrafts.remove(props.userId, requestField());
    }
    setText(value);
    if (value) pwaDrafts.write(props.userId, field(), value);
    else pwaDrafts.remove(props.userId, field());
  };

  const send = async () => {
    const content = text().trim();
    if (!content || sending() || disposed) return;
    requestId ??= crypto.randomUUID();
    const id = requestId;
    // A plain request token follows the device draft across a restart. An ambiguous send retries the same comment.
    pwaDrafts.write(props.userId, requestField(), id);
    setSending(true);
    const response = await apiClient[":id"].items[":itemId"].comments
      .$post({ param: { id: props.task.spaceShortId, itemId: props.task.shortId }, query: {}, json: { requestId: id, content } })
      .catch(() => null);
    if (disposed) return;
    setSending(false);
    if (response?.ok) {
      // Text typed while the comment was on its way stays.
      if (requestId === id && pwaDrafts.read(props.userId, requestField()) === id) change("");
      toast.success(t().commentSent);
      return;
    }
    if (response?.status === 409) {
      toast.error(t().commentChanged);
      return;
    }
    if (response && (response.status === 403 || response.status === 404)) {
      toast.error(response.status === 403 ? t().notAllowed({ space: props.task.spaceName }) : t().gone({ title: props.task.title }));
      return;
    }
    retryToast(t().commentFailed({ title: props.task.title }), o().retry, () => void send());
  };

  return (
    <form
      class="spaces-pwa-comment"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <TextInput
        aria-label={t().comment}
        multiline
        lines={2}
        icon={false}
        maxLength={COMMENT_MAX_LENGTH}
        placeholder={t().commentPlaceholder}
        value={text}
        onValueChange={change}
        disabled={!mounted()}
      />
      <Button type="submit" variant="secondary" loading={sending()} disabled={!mounted() || !text().trim()}>
        {t().send}
      </Button>
    </form>
  );
}
