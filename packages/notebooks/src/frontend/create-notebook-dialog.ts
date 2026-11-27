import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { prompts } from "@k2b/ui";
import { type Accessor, onCleanup } from "solid-js";
import { apiClient } from "../api/client";
import type { notebooksPageMessages } from "./messages";

type CreatedNotebook = { id: string };
/** The choice that stands for "no template": the standard welcome note. */
const BLANK = "blank";

const errorMessage = async (response: Pick<Response, "json">, fallback: string) => {
  try {
    const body = await response.json();
    if (body && typeof body === "object" && "message" in body && typeof body.message === "string") return body.message;
  } catch {
    // Keep the stable fallback.
  }
  return fallback;
};

/**
 * "New notebook" of the v1 notebook switcher: blank (name and description) or from a built-in template, which the
 * former overview offered. The v2 workspace uses `NewNotebookDialog` instead.
 */
export function createNotebookCreation(t: Accessor<ReturnType<typeof notebooksPageMessages.resolve>["t"]>) {
  const openNotebook = (notebook: CreatedNotebook) => navigateTo(`/app/notebooks/${notebook.id}`);
  const createNotebookMutation = mutations.create<CreatedNotebook, { templateId: string | null; name: string; description?: string }>({
    mutation: async (input) => {
      if (input.templateId) {
        const response = await apiClient.templates[":templateId"].$post({
          param: { templateId: input.templateId },
          json: { name: input.name },
        });
        if (!response.ok) throw new Error(await errorMessage(response, t().createFromTemplateFailed));
        return response.json();
      }
      const response = await apiClient.index.$post({ json: { name: input.name, description: input.description || undefined } });
      if (!response.ok) throw new Error(await errorMessage(response, t().createFailed));
      return response.json();
    },
    onSuccess: openNotebook,
    onError: (error) => prompts.error(error.message),
  });

  const createBlank = async () => {
    // The templates are part of the app; without them a blank notebook is still the way.
    const templates = await apiClient.templates
      .$get()
      .then((response) => (response.ok ? response.json() : []))
      .catch(() => []);
    const result = await prompts.form({
      title: t().newNotebook,
      icon: "ti ti-notebook",
      fields: {
        template: {
          type: "select",
          label: t().startWith,
          default: BLANK,
          options: [
            { id: BLANK, label: t().blankNotebook, description: t().blankNotebookDescription, icon: "ti ti-file-plus" },
            ...templates.map((template) => ({
              id: template.id,
              label: template.name,
              description: template.description,
              icon: template.icon,
            })),
          ],
        },
        name: { type: "text", label: t().name, required: true, placeholder: t().notebookName },
        description: {
          type: "text",
          label: t().description,
          multiline: true,
          placeholder: t().optionalDescription,
          description: t().descriptionBlankOnly,
        },
      },
      confirmText: t().create,
    });
    if (!result) return;
    const templateId = String(result.template ?? BLANK);
    await createNotebookMutation.mutate({
      templateId: templateId === BLANK ? null : templateId,
      name: String(result.name).trim(),
      description: String(result.description ?? "").trim(),
    });
  };

  onCleanup(() => createNotebookMutation.abort());
  return { createBlank, loading: createNotebookMutation.loading };
}
