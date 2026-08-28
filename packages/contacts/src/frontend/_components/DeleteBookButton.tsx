import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts, toast, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { apiClient } from "@/api/client";
import { readErrorMessage } from "./api";
import { bookMessages } from "./book-messages";

type Props = {
  bookId: string;
  bookName: string;
  onDeleted: () => void;
  onPendingChange: (pending: boolean) => void;
  disabled?: boolean;
};

/** Deletes a manual contact book after explicit user confirmation. */
export default function DeleteBookButton(props: Props) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const [confirming, setConfirming] = createSignal(false);
  let disposed = false;
  const mutation = mutations.create<void, { bookId: string }>({
    mutation: async ({ bookId }, { abortSignal }) => {
      const response = await apiClient.books[":bookId"].$delete(
        {
          param: { bookId },
        },
        { init: { signal: abortSignal } },
      );

      if (!response.ok) throw new Error(await readErrorMessage(response, t().deleteBookFailed));
    },
    onSuccess: () => {
      toast.success(t().bookDeleted);
      props.onDeleted();
    },
    onError: (error) => {
      prompts.error(error.message);
    },
  });

  createEffect(() => {
    props.onPendingChange(confirming() || mutation.loading());
  });

  onCleanup(() => {
    disposed = true;
    mutation.abort();
    props.onPendingChange(false);
  });

  const remove = async () => {
    if (props.disabled || confirming() || mutation.loading()) return;
    const bookId = props.bookId;
    const bookName = props.bookName;
    setConfirming(true);
    try {
      const confirmed = await prompts.confirm(t().deleteBookConfirm({ name: bookName }), {
        title: t().deleteBook,
        icon: "ti ti-trash",
        variant: "danger",
        confirmText: t().delete,
        cancelText: t().cancel,
      });
      if (confirmed && !disposed) void mutation.mutate({ bookId });
    } catch (error) {
      if (!disposed) void prompts.error(error instanceof Error ? error.message : t().confirmDeleteFailed);
    } finally {
      if (!disposed) setConfirming(false);
    }
  };

  return (
    <Button
      type="button"
      variant="danger"
      size="sm"
      loading={confirming() || mutation.loading()}
      disabled={props.disabled}
      onClick={() => void remove()}
    >
      <i class="ti ti-trash" />
      {t().deleteBook}
    </Button>
  );
}
