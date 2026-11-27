import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { Button, Check, Dialog, Field, Input, Notice, Select, Text } from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import { errorMessage } from "../utils/api-helpers";
import { overviewMessages } from "./messages";

export type BaseTemplate = {
  id: string;
  name: string;
  description: string;
  highlights: [string, string, string];
  icon: string;
};

/** The template the dialog starts with: `blank` for an empty base. */
export const BLANK = "blank";

/**
 * Creates a base, empty or from a template, and opens it. The address names the open dialog (`?new=`), so the page
 * opens it on the first picture and reload keeps it; `onClose` takes it out of the address again.
 */
export default function CreateBaseDialog(props: { start: string | null; templates: BaseTemplate[]; onClose: () => void }) {
  const locale = useLocale();
  const t = () => overviewMessages.resolve([locale()]).t;
  const known = (id: string | null) => (id && props.templates.some((template) => template.id === id) ? id : BLANK);
  const [choice, setChoice] = createSignal(known(props.start));
  const template = createMemo(() => props.templates.find((each) => each.id === choice()));
  const [name, setName] = createSignal(template()?.name ?? "");
  const [description, setDescription] = createSignal("");
  const [sampleData, setSampleData] = createSignal(true);
  const [submitted, setSubmitted] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  // Each opening starts from the template the address names; a template's name stands in until one is typed.
  createEffect(
    on(
      () => props.start,
      (start) => {
        if (start === null) return;
        setChoice(known(start));
        setName(template()?.name ?? "");
        setDescription("");
        setSampleData(true);
        setSubmitted(false);
        setError(null);
      },
    ),
  );
  const pick = (next: string) => {
    const before = template()?.name ?? "";
    setChoice(known(next));
    if (name() === before) setName(template()?.name ?? "");
  };
  const dirty = () => name() !== (template()?.name ?? "") || description().length > 0 || !sampleData();

  const close = async () => {
    if (saving()) return;
    if (
      dirty() &&
      !(await Dialog.confirm({
        title: t().discardTitle,
        description: t().discardDescription,
        confirm: t().discard,
        cancel: t().keepEditing,
      }))
    )
      return;
    props.onClose();
  };

  const create = async () => {
    setSubmitted(true);
    if (!name().trim() || saving()) return;
    setSaving(true);
    setError(null);
    try {
      const chosen = template();
      const response = chosen
        ? await apiClient.templates[":templateId"].$post({
            param: { templateId: chosen.id },
            json: { name: name().trim(), withSampleData: sampleData() },
          })
        : await apiClient.bases.$post({ json: { name: name().trim(), description: description().trim() || null } });
      if (!response.ok) throw new Error(await errorMessage(response, chosen ? t().createFromTemplateFailed : t().createBaseFailed));
      const base = await response.json();
      navigateTo(`/app/grids/${base.id}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().createBaseFailed);
      setSaving(false);
    }
  };
  const submitOnEnter = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      void create();
    }
  };

  return (
    <Dialog
      title={template() ? t().createTemplate({ name: template()?.name ?? "" }) : t().newBase}
      open={props.start !== null}
      onOpenChange={(open) => {
        if (!open) void close();
      }}
      foot={
        <>
          <Button onClick={() => void close()} disabled={saving()}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="plus" busy={saving()} onClick={() => void create()}>
            {t().createBase}
          </Button>
        </>
      }
    >
      <Show when={error()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
      <Field
        label={t().template}
        name="template"
        hint={
          template()
            ? `${template()?.description} ${t().includes({ list: template()?.highlights.join(", ") ?? "" })}`
            : t().blankBaseDescription
        }
      >
        <Select
          value={choice()}
          onChange={pick}
          options={[{ value: BLANK, label: t().blankBase }, ...props.templates.map((each) => ({ value: each.id, label: each.name }))]}
        />
      </Field>
      <Field
        label={t().name}
        name="name"
        required
        hint={template() ? t().renameTemplateDescription : undefined}
        error={submitted() && !name().trim() ? t().requiredName : undefined}
      >
        <Input value={name()} onInput={setName} placeholder={t().baseNameExample} onKeyDown={submitOnEnter} />
      </Field>
      <Show
        when={template()}
        fallback={
          <Field label={t().description} name="description" optional={t().optional}>
            <Input multiline value={description()} onInput={setDescription} />
          </Field>
        }
      >
        <Check label={t().includeSampleData} checked={sampleData()} onChange={setSampleData} />
        <Text type="meta" muted>
          {t().includeSampleDataDescription}
        </Text>
      </Show>
    </Dialog>
  );
}
