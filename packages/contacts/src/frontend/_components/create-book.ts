import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { prompts, toast, useLocale } from "@k2b/ui";
import { createSignal, onCleanup } from "solid-js";
import { apiClient } from "@/api/client";
import { readErrorMessage } from "./api";
import { bookMessages } from "./book-messages";

/**
 * Opens a modal to create a new contact book and redirects to the created book.
 */
export function createBookController() {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const [prompting, setPrompting] = createSignal(false);
  let disposed = false;
  const mutation = mutations.create<{ id: string }, { name: string; description?: string }>({
    mutation: async (payload, { abortSignal }) => {
      const response = await apiClient.books.$post({ json: payload }, { init: { signal: abortSignal } });

      if (!response.ok) throw new Error(await readErrorMessage(response, t().createBookFailed));

      return response.json();
    },
    onSuccess: (book) => {
      toast.success(t().bookCreated);
      navigateTo(`/app/contacts/${book.id}`);
    },
    onError: (error) => {
      prompts.error(error.message);
    },
  });

  onCleanup(() => {
    disposed = true;
    mutation.abort();
  });

  const createBook = async () => {
    if (prompting() || mutation.loading()) return;
    setPrompting(true);
    try {
      const result = await prompts.form({
        title: t().newContactBookTitle,
        icon: "ti ti-cube-plus",
        confirmText: t().create,
        fields: {
          name: {
            type: "text",
            label: t().bookNameLabel,
            placeholder: t().createBookNamePlaceholder,
            required: true,
          },
          description: {
            type: "text",
            label: t().descriptionLabel,
            placeholder: t().optionalPlaceholder,
            multiline: true,
          },
        },
      });
      if (!result || disposed) return;
      void mutation.mutate({ name: result.name.trim(), description: result.description?.trim() || undefined });
    } catch (error) {
      if (!disposed) void prompts.error(error instanceof Error ? error.message : t().openCreateFormFailed);
    } finally {
      if (!disposed) setPrompting(false);
    }
  };

  const busy = () => prompting() || mutation.loading();
  return { createBook, busy };
}
