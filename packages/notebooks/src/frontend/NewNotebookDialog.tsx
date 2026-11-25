import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Button, Choice, Dialog, Field, Input, Notice } from "@k2b/ui/v2";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { notebooksPageMessages } from "./messages";

export type NotebookTemplate = { id: string; name: string; description: string; icon: string };

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
 * A new notebook on v2: blank (name and description) or from one of the templates (an optional name, the template's
 * own name by default). Creating opens the new notebook; a failure stays in the dialog with the server's words.
 */
export default function NewNotebookDialog(props: { templates: readonly NotebookTemplate[]; close: () => void }) {
  const locale = useLocale();
  const t = createMemo(() => notebooksPageMessages.resolve([locale()]).t);
  const [template, setTemplate] = createSignal(BLANK);
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [missingName, setMissingName] = createSignal(false);
  const chosen = () => props.templates.find((entry) => entry.id === template());

  const create = mutations.create<{ id: string }, { templateId: string | null; name: string; description: string }>({
    mutation: async (input) => {
      if (input.templateId) {
        const response = await apiClient.templates[":templateId"].$post({
          param: { templateId: input.templateId },
          json: { name: input.name || undefined },
        });
        if (!response.ok) throw new Error(await errorMessage(response, t().createFromTemplateFailed));
        return response.json();
      }
      const response = await apiClient.index.$post({ json: { name: input.name, description: input.description || undefined } });
      if (!response.ok) throw new Error(await errorMessage(response, t().createFailed));
      return response.json();
    },
    onSuccess: (notebook) => navigateTo(`/app/notebooks/${notebook.id}`),
  });
  onCleanup(() => create.abort());

  const submit = () => {
    if (create.loading()) return;
    const typed = name().trim();
    if (!chosen() && !typed) return setMissingName(true);
    void create.mutate({ templateId: chosen()?.id ?? null, name: typed, description: description().trim() });
  };

  return (
    <Dialog
      title={t().newNotebook}
      open
      onOpenChange={(open) => {
        if (!open && !create.loading()) props.close();
      }}
      foot={
        <>
          <Button onClick={props.close} disabled={create.loading()}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="plus" busy={create.loading()} onClick={submit}>
            {t().create}
          </Button>
        </>
      }
    >
      <Show when={props.templates.length > 0}>
        <Field name="template" label={t().startWith} hint={chosen()?.description ?? t().blankNotebookDescription}>
          <Choice
            name="template"
            value={template()}
            options={[
              { value: BLANK, label: t().blankNotebook },
              ...props.templates.map((entry) => ({ value: entry.id, label: entry.name })),
            ]}
            onChange={setTemplate}
            disabled={create.loading()}
          />
        </Field>
      </Show>
      <Field
        name="name"
        label={t().name}
        required={!chosen()}
        optional={chosen() ? t().optional : undefined}
        error={missingName() ? t().nameRequired : undefined}
      >
        <Input
          value={name()}
          placeholder={chosen()?.name ?? t().notebookName}
          disabled={create.loading()}
          onInput={(value) => {
            setName(value);
            setMissingName(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) submit();
          }}
        />
      </Field>
      <Show when={!chosen()}>
        <Field name="description" label={t().description} optional={t().optional}>
          <Input multiline value={description()} disabled={create.loading()} onInput={setDescription} />
        </Field>
      </Show>
      <Show when={create.error()}>
        {(error) => (
          <Notice tone="bad" icon="alert-circle">
            {error().message}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
}
