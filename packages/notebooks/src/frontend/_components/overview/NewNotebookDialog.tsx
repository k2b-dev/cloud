import { navigateTo } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { Button, Dialog, Field, Input, Notice } from "@k2b/ui/v2";
import { createEffect, createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { notebooksPageMessages } from "../../messages";
import type { TemplateSummary } from "./NotebooksStart";

/** Where a new notebook starts: blank (with the welcome note), or from a template. */
export type NewNotebookSource = { kind: "blank" } | { kind: "template"; template: TemplateSummary };

/**
 * A new notebook on v2: its name (and, when blank, a description), then the notebook opens. From a template the name
 * may stay empty and the template's name is taken. A failure says so in the dialog, which stays open.
 */
export default function NewNotebookDialog(props: { source: NewNotebookSource | null; onClose: () => void }) {
  const locale = useLocale();
  const t = () => notebooksPageMessages.resolve([locale()]).t;
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal<string | null>(null);
  // a new start opens empty
  createEffect(() => {
    if (!props.source) return;
    setName("");
    setDescription("");
    setFailed(null);
  });
  const template = () => (props.source?.kind === "template" ? props.source.template : null);
  const close = () => {
    if (!busy()) props.onClose();
  };
  const create = async () => {
    const source = props.source;
    if (!source || busy()) return;
    if (source.kind === "blank" && !name().trim()) {
      setFailed(t().nameRequired);
      return;
    }
    setBusy(true);
    setFailed(null);
    const response = await (source.kind === "blank"
      ? apiClient.index.$post({ json: { name: name().trim(), description: description().trim() || undefined } })
      : apiClient.templates[":templateId"].$post({
          param: { templateId: source.template.id },
          json: { name: name().trim() || undefined },
        })
    ).catch(() => null);
    if (!response?.ok) {
      setBusy(false);
      setFailed(source.kind === "blank" ? t().createFailed : t().createFromTemplateFailed);
      return;
    }
    const created = await response.json();
    setBusy(false);
    props.onClose();
    navigateTo(`/app/notebooks/${created.id}`);
  };
  return (
    <Dialog
      title={template()?.name ?? t().newNotebook}
      open={props.source !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      foot={
        <>
          <Button onClick={close} disabled={busy()}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="plus" busy={busy()} onClick={() => void create()}>
            {t().create}
          </Button>
        </>
      }
    >
      <Field name="name" label={t().name} required={!template()}>
        <Input
          value={name()}
          placeholder={template()?.name ?? t().notebookName}
          disabled={busy()}
          onInput={(value) => {
            setName(value);
            setFailed(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) void create();
          }}
        />
      </Field>
      <Show when={!template()}>
        <Field name="description" label={t().description}>
          <Input multiline value={description()} placeholder={t().optionalDescription} disabled={busy()} onInput={setDescription} />
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
