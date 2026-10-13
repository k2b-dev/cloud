import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { prompts } from "@k2b/ui";
import { type Accessor, onCleanup } from "solid-js";
import { apiClient } from "../api/client";
import type { notebooksPageMessages } from "./messages";

type CreatedNotebook = { id: string };
const errorMessage = async (response: Pick<Response, "json">, fallback: string) => {
  try {
    const body = await response.json();
    if (body && typeof body === "object" && "message" in body && typeof body.message === "string") return body.message;
  } catch {
    // Keep the stable fallback.
  }
  return fallback;
};

export function createNotebookCreation(t: Accessor<ReturnType<typeof notebooksPageMessages.resolve>["t"]>) {
  const openNotebook = (notebook: CreatedNotebook) => navigateTo(`/app/notebooks/${notebook.id}`);
  const createNotebookMutation = mutations.create<CreatedNotebook, { name: string; description?: string }>({
    mutation: async (input) => {
      const response = await apiClient.index.$post({ json: { name: input.name, description: input.description || undefined } });
      if (!response.ok) throw new Error(await errorMessage(response, t().createFailed));
      return response.json();
    },
    onSuccess: openNotebook,
    onError: (error) => prompts.error(error.message),
  });

  const createBlank = async () => {
    const result = await prompts.form({
      title: t().newNotebook,
      icon: "ti ti-notebook",
      fields: {
        name: { type: "text", label: t().name, required: true, placeholder: t().notebookName },
        description: { type: "text", label: t().description, multiline: true, placeholder: t().optionalDescription },
      },
      confirmText: t().create,
    });
    if (!result) return;
    await createNotebookMutation.mutate({
      name: String(result.name).trim(),
      description: String(result.description ?? "").trim(),
    });
  };

  onCleanup(() => createNotebookMutation.abort());
  return { createBlank, loading: createNotebookMutation.loading };
}
