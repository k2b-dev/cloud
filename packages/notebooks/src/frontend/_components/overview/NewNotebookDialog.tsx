import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { Button, Dialog, Field, Input, Notice, Select } from "@k2b/ui/v2";
import { createEffect, createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { notebooksPageMessages } from "../../messages";

/** A built-in template as the server lists it (`GET /api/notebooks/templates`). */
export type TemplateSummary = { id: string; name: string; description: string; icon: string };

/** Where a new notebook starts: blank (with the welcome note), or from a template, the given one or the first. */
export type NewNotebookSource = { kind: "blank" } | { kind: "template"; templateId?: string };

/** What the server keeps of a name and a description (CreateNotebookSchema, InstantiateTemplateSchema in api). */
const NAME_MAX = 100;
const DESCRIPTION_MAX = 500;

/** The server's own words for a refused request, else the fixed sentence. */
const reasonOf = async (response: Pick<Response, "json">, fallback: string) => {
  const body: unknown = await response.json().catch(() => null);
  return body && typeof body === "object" && "message" in body && typeof body.message === "string" && body.message
    ? body.message
    : fallback;
};

/**
 * The one way to make a notebook, on the start page and from the notebook switcher: blank with its name (and a
 * description), or from a template, which may keep the template's name. The new notebook opens after. A refusal or an
 * answer that is no notebook says so in the dialog, which stays open and usable.
 */
export default function NewNotebookDialog(props: {
  templates: readonly TemplateSummary[];
  source: NewNotebookSource | null;
  onClose: () => void;
}) {
  const locale = useLocale();
  const t = () => notebooksPageMessages.resolve([locale()]).t;
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [templateId, setTemplateId] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  // a refusal without a field stands under the fields; what is wrong with a field stands at that field
  const [failed, setFailed] = createSignal<string | null>(null);
  const [nameError, setNameError] = createSignal<string | undefined>();
  const [descriptionError, setDescriptionError] = createSignal<string | undefined>();
  // a new start opens empty, on the template it was opened for
  createEffect(() => {
    const source = props.source;
    if (!source) return;
    setName("");
    setDescription("");
    setFailed(null);
    setNameError(undefined);
    setDescriptionError(undefined);
    setTemplateId(source.kind === "template" ? (source.templateId ?? props.templates[0]?.id ?? "") : "");
  });
  const fromTemplate = () => props.source?.kind === "template";
  const template = () => props.templates.find((candidate) => candidate.id === templateId());
  const close = () => {
    if (!busy()) props.onClose();
  };
  const create = async () => {
    if (!props.source || busy()) return;
    const chosen = template();
    if (fromTemplate() && !chosen) return;
    if (!fromTemplate() && !name().trim()) {
      setNameError(t().nameRequired);
      return;
    }
    // the server keeps at most 100 characters of a name and 500 of a description (api/index.ts); say so here instead
    // of a refusal. k2b-ui gap: the v2 Input takes no maxLength.
    if (name().trim().length > NAME_MAX) {
      setNameError(t().nameTooLong({ max: NAME_MAX }));
      return;
    }
    if (!fromTemplate() && description().trim().length > DESCRIPTION_MAX) {
      setDescriptionError(t().descriptionTooLong({ max: DESCRIPTION_MAX }));
      return;
    }
    const fallback = chosen ? t().createFromTemplateFailed : t().createFailed;
    setBusy(true);
    setFailed(null);
    const outcome = await (chosen
      ? apiClient.templates[":templateId"].$post({ param: { templateId: chosen.id }, json: { name: name().trim() || undefined } })
      : apiClient.index.$post({ json: { name: name().trim(), description: description().trim() || undefined } })
    )
      .then(async (response): Promise<{ id: string } | { reason: string }> => {
        if (!response.ok) return { reason: await reasonOf(response, fallback) };
        const created: unknown = await response.json().catch(() => null);
        return created && typeof created === "object" && "id" in created && typeof created.id === "string"
          ? { id: created.id }
          : { reason: fallback };
      })
      .catch(() => ({ reason: fallback }));
    setBusy(false);
    if ("reason" in outcome) {
      setFailed(outcome.reason);
      return;
    }
    props.onClose();
    navigateTo(`/app/notebooks/${outcome.id}`);
  };
  return (
    <Dialog
      title={t().newNotebook}
      open={props.source !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      foot={
        <>
          <Button onClick={close} disabled={busy()}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="plus" busy={busy()} disabled={fromTemplate() && !template()} onClick={() => void create()}>
            {t().create}
          </Button>
        </>
      }
    >
      <Show when={fromTemplate()}>
        <Show
          when={props.templates.length > 0}
          fallback={
            <Notice tone="bad" icon="alert-circle">
              {t().templatesLoadFailed}
            </Notice>
          }
        >
          <Field name="template" label={t().template} hint={template()?.description}>
            <Select
              options={props.templates.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
              value={templateId()}
              onChange={(value) => {
                // the request in flight makes the template it was sent for
                if (busy()) return;
                setTemplateId(value);
                setFailed(null);
              }}
            />
          </Field>
        </Show>
      </Show>
      <Field name="name" label={t().name} required={!fromTemplate()} error={nameError()}>
        <Input
          value={name()}
          placeholder={template()?.name ?? t().notebookName}
          disabled={busy()}
          onInput={(value) => {
            setName(value);
            setNameError(undefined);
            setFailed(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) void create();
          }}
        />
      </Field>
      <Show when={!fromTemplate()}>
        <Field name="description" label={t().description} error={descriptionError()}>
          <Input
            multiline
            value={description()}
            placeholder={t().optionalDescription}
            disabled={busy()}
            onInput={(value) => {
              setDescription(value);
              setDescriptionError(undefined);
            }}
          />
        </Field>
      </Show>
      <Show when={failed()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
}
