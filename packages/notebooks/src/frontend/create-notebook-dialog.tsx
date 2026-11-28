import { LocaleProvider } from "@k2b/ui";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { apiClient } from "../api/client";
import NewNotebookDialog, { type NewNotebookSource, type TemplateSummary } from "./_components/overview/NewNotebookDialog";

const isTemplate = (value: unknown): value is TemplateSummary =>
  !!value &&
  typeof value === "object" &&
  "id" in value &&
  typeof value.id === "string" &&
  "name" in value &&
  typeof value.name === "string" &&
  "description" in value &&
  typeof value.description === "string" &&
  "icon" in value &&
  typeof value.icon === "string";

/**
 * The built-in templates. A failed request and an answer that is no list of templates both read as none; the dialog
 * then says that the templates could not be loaded.
 */
const loadTemplates = async (): Promise<TemplateSummary[]> => {
  const body: unknown = await apiClient.templates
    .$get()
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  return Array.isArray(body) ? body.filter(isTemplate) : [];
};

/**
 * Opens the new-notebook dialog of the start page from a page that is not v2 (the notebook switcher): in a v2 scope of
 * its own at the end of the page, for as long as it is open. Resolves when it closes; `signal` closes it when the page
 * that opened it goes (a soft navigation disposes the switcher).
 */
export const openNewNotebookDialog = async (source: NewNotebookSource, locale: string, signal?: AbortSignal): Promise<void> => {
  const templates = source.kind === "template" ? await loadTemplates() : [];
  if (signal?.aborted) return;
  const host = document.createElement("div");
  host.className = "k2-ui";
  host.style.display = "contents";
  document.body.append(host);
  const [open, setOpen] = createSignal<NewNotebookSource | null>(source);
  return new Promise((resolve) => {
    const close = () => {
      signal?.removeEventListener("abort", close);
      setOpen(null);
      stop();
      host.remove();
      resolve();
    };
    signal?.addEventListener("abort", close, { once: true });
    const stop = render(
      () => (
        <LocaleProvider locale={locale}>
          <NewNotebookDialog templates={templates} source={open()} onClose={close} />
        </LocaleProvider>
      ),
      host,
    );
  });
};
