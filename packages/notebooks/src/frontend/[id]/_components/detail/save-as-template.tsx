import { Button, InlineGuidance, prompts, TextInput, toast, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import { normalizePageTemplateName, PAGE_TEMPLATE_NAME_MAX_LENGTH, type PageTemplateSummary } from "@/lib/page-templates";
import { notebookWorkspaceMessages } from "../../messages";
import { readErrorMessage } from "../settings/utils";

type Messages = ReturnType<(typeof notebookWorkspaceMessages)["resolve"]>["t"];

/** The notebook's own template with this name, ignoring case, as the server compares names. */
const ownTemplateNamed = async (notebookId: string, name: string, locale: string): Promise<PageTemplateSummary | null> => {
  const res = await apiClient[":id"]["page-templates"].$get({ param: { id: notebookId } });
  if (!res.ok) return null;
  const needle = sameName(name, locale);
  return (await res.json()).find((template) => !template.builtIn && template.name.toLocaleLowerCase(locale) === needle) ?? null;
};

/** A name as the server compares it: normalized, ignoring case. */
const sameName = (name: string, locale: string) => (normalizePageTemplateName(name) ?? name.trim()).toLocaleLowerCase(locale);

const layer = (shown: boolean) => (shown ? "[grid-area:1/1]" : "invisible [grid-area:1/1]");
const visible = (shown: boolean) => (shown ? undefined : "true");

/**
 * The name dialog. It stays open until the template is saved, so a failed save keeps the name; a name the notebook
 * already uses asks once whether to replace that template's text.
 */
function SaveAsTemplateForm(props: {
  notebookId: string;
  noteId: string;
  initialName: string;
  t: Messages;
  locale: string;
  close: (saved: PageTemplateSummary | undefined) => void;
}) {
  const [name, setName] = createSignal(props.initialName.slice(0, PAGE_TEMPLATE_NAME_MAX_LENGTH));
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  /** The own template whose text a second click replaces, once the name turned out to be taken. */
  const [replacing, setReplacing] = createSignal<PageTemplateSummary | null>(null);
  const t = () => props.t;

  const submit = async () => {
    const trimmed = name().trim();
    if (!trimmed || pending()) return;
    setPending(true);
    setError(null);
    try {
      const target = replacing();
      if (target && sameName(target.name, props.locale) === sameName(trimmed, props.locale)) {
        const res = await apiClient[":id"]["page-templates"][":templateId"].$patch({
          param: { id: props.notebookId, templateId: target.id },
          json: { noteId: props.noteId },
        });
        if (!res.ok) throw new Error(await readErrorMessage(res, t().failedSaveTemplate));
        const saved = await res.json();
        toast.success(t().templateReplaced({ name: saved.name }));
        props.close(saved);
        return;
      }
      const res = await apiClient[":id"]["page-templates"].$post({
        param: { id: props.notebookId },
        json: { name: trimmed, noteId: props.noteId },
      });
      if (res.status === 409) {
        const existing = await ownTemplateNamed(props.notebookId, trimmed, props.locale);
        if (existing) {
          setReplacing(existing);
          return;
        }
      }
      if (!res.ok) throw new Error(await readErrorMessage(res, t().failedSaveTemplate));
      const saved = (await res.json()) as PageTemplateSummary;
      toast.success(t().templateSaved({ name: saved.name }));
      props.close(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t().failedSaveTemplate);
    } finally {
      setPending(false);
    }
  };

  const asksReplace = () => {
    const target = replacing();
    return Boolean(target && sameName(target.name, props.locale) === sameName(name(), props.locale));
  };

  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TextInput
        label={t().templateName}
        value={name}
        onValueChange={setName}
        maxLength={PAGE_TEMPLATE_NAME_MAX_LENGTH}
        icon="ti ti-template"
        required
        disabled={pending()}
      />
      {/* The hint, the replace question and an error share one cell sized for all three, so none moves the buttons. */}
      <div class="grid">
        <InlineGuidance
          icon="ti ti-info-circle"
          class={layer(!asksReplace() && !error())}
          aria-hidden={visible(!asksReplace() && !error())}
        >
          {t().templateNameHint}
        </InlineGuidance>
        <InlineGuidance tone="warning" icon="ti ti-alert-triangle" class={layer(asksReplace())} aria-hidden={visible(asksReplace())}>
          {t().replaceTemplateConfirm({ name: replacing()?.name ?? name().trim() })}
        </InlineGuidance>
        <InlineGuidance tone="danger" icon="ti ti-alert-circle" class={layer(Boolean(error()))} aria-hidden={visible(Boolean(error()))}>
          {error() ?? t().failedSaveTemplate}
        </InlineGuidance>
        <span class="sr-only" role="status" aria-live="polite">
          {asksReplace() ? t().replaceTemplateConfirm({ name: replacing()!.name }) : (error() ?? "")}
        </span>
      </div>
      <div class="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => props.close(undefined)}>
          {t().cancel}
        </Button>
        <Button
          type="submit"
          variant={asksReplace() ? "danger" : "primary"}
          disabled={!name().trim()}
          loading={pending()}
          loadingLabel={t().saveAsTemplateTitle}
        >
          {asksReplace() ? t().replaceTemplate : error() ? t().retry : t().saveAsTemplateTitle}
        </Button>
      </div>
    </form>
  );
}

/** "Save as template…" for the tree and the note panel: the note's current text becomes a template of its notebook. */
export function useSaveAsTemplate(notebookId: string) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  return {
    save: (note: { id: string; title: string }) =>
      prompts.dialog<PageTemplateSummary | undefined>(
        (close) => (
          <SaveAsTemplateForm
            notebookId={notebookId}
            noteId={note.id}
            initialName={note.title}
            t={t()}
            locale={locale()}
            close={(saved) => close(saved)}
          />
        ),
        { title: t().saveAsTemplateTitle, icon: "ti ti-template" },
      ),
  };
}
