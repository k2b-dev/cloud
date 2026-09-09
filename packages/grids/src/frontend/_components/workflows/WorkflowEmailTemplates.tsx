import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  confirmDiscardIfDirty,
  createTemplateEditorPanesLayout,
  dialogCore,
  IconButton,
  NoticeCard,
  PanelDialog,
  Panes,
  Placeholder,
  panelDialogWorkspaceOptions,
  prompts,
  ScrollArea,
  StatusBadge,
  TemplateEditor,
  TemplatePreview,
  TemplateSampleData,
  type TemplateVariable,
  TextInput,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { renderLiquidTemplate } from "@valentinkolb/cloud/shared";
import type { WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import {
  type PublicEmailTemplate,
  type PublicEmailTemplateDependencyMap,
  PublicEmailTemplateDependencyMapSchema,
  PublicEmailTemplateListSchema,
  PublicEmailTemplateSchema,
} from "../../../api/public-email-template-contracts";
import { errorMessage } from "../utils/api-helpers";
import {
  createDefaultEmailTemplateSampleData,
  createEmailTemplateSystemSampleData,
  EMAIL_TEMPLATE_SYSTEM_VARIABLES,
  emailTemplatePreviewContext,
  emailTemplateVariables,
  parseEmailTemplateSampleData,
} from "./email-template-preview-data";
import { workflowMessages } from "./messages";
import { workflowEmailTemplateDraft, workflowEmailTemplateDraftDirty } from "./workflow-email-template-draft";

const emailTemplateManagerApi = apiClient["email-templates"] as unknown as {
  "by-base": {
    ":baseId": {
      $get: (input: { param: { baseId: string } }, options?: { init?: RequestInit }) => Promise<Response>;
      dependencies: {
        $get: (input: { param: { baseId: string } }, options?: { init?: RequestInit }) => Promise<Response>;
      };
    };
  };
};

const DEFAULT_EMAIL_SUBJECT = "{{ workflow.name }}";
const escapePreviewText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const buildEmailPreviewHtml = (content: string, appName: string, footer: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:520px;" cellpadding="0" cellspacing="0">
        <tr><td style="background:#ffffff;padding:20px 24px;border-radius:12px 12px 0 0;border:1px solid #e4e4e7;border-bottom:none;">
          <span style="font-size:16px;font-weight:600;color:#18181b;">${escapePreviewText(appName)}</span>
        </td></tr>
        <tr><td style="background:#ffffff;padding:28px 24px;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7;">
          <div style="font-size:14px;line-height:1.6;color:#27272a;">${content}</div>
        </td></tr>
        <tr><td style="background:#fafafa;padding:16px 24px;border-radius:0 0 12px 12px;border:1px solid #e4e4e7;border-top:none;">
          <p style="margin:0;font-size:11px;color:#a1a1aa;text-align:center;">${escapePreviewText(footer)}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
`;

const renderEmailTemplatePreview = (
  template: string,
  sampleData: Record<string, WorkflowJsonValue>,
  systemSampleData: Record<string, string>,
  locale: string,
): string => {
  const t = workflowMessages.resolve([locale]).t;
  try {
    return buildEmailPreviewHtml(
      renderLiquidTemplate(template, emailTemplatePreviewContext(sampleData, systemSampleData)),
      systemSampleData["app.name"] ?? "Cloud",
      t.automaticEmailFooter,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : t.templatePreviewFailed;
    return buildEmailPreviewHtml(
      `<p style="color:#b91c1c;">${escapePreviewText(message)}</p>`,
      systemSampleData["app.name"] ?? "Cloud",
      t.automaticEmailFooter,
    );
  }
};

function EmailTemplateEditor(props: {
  baseId: string;
  template?: PublicEmailTemplate;
  onSaved: () => void;
  onClose: () => void;
  setDismissHandler: (handler: () => void | Promise<void>) => void;
}) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  const cleanDraft = workflowEmailTemplateDraft(
    props.template,
    DEFAULT_EMAIL_SUBJECT,
    t().defaultEmailHtml,
    createDefaultEmailTemplateSampleData(locale()),
  );
  const [name, setName] = createSignal(cleanDraft.name);
  const [description, setDescription] = createSignal(cleanDraft.description);
  const [subject, setSubject] = createSignal(cleanDraft.subject);
  const [html, setHtml] = createSignal(cleanDraft.html);
  const [enabled, setEnabled] = createSignal(cleanDraft.enabled);
  const [layout, setLayout] = createSignal(createTemplateEditorPanesLayout());
  const cleanSampleDataSource = JSON.stringify(cleanDraft.sampleData, null, 2);
  const [sampleDataSource, setSampleDataSource] = createSignal(cleanSampleDataSource);
  const [systemSampleData, setSystemSampleData] = createSignal<Record<string, string>>(createEmailTemplateSystemSampleData(locale()));
  const parsedSampleData = createMemo(() => parseEmailTemplateSampleData(sampleDataSource(), locale()));
  const sampleData = createMemo(() => {
    const parsed = parsedSampleData();
    return parsed.ok ? parsed.data : cleanDraft.sampleData;
  });
  const variables = createMemo<TemplateVariable[]>(() => emailTemplateVariables(sampleData()));
  const renderedPreview = createMemo(() => {
    const parsed = parsedSampleData();
    if (!parsed.ok) {
      return buildEmailPreviewHtml(
        `<p style="color:#b91c1c;">${escapePreviewText(parsed.error)}</p>`,
        systemSampleData()["app.name"] ?? "Cloud",
        t().automaticEmailFooter,
      );
    }
    return renderEmailTemplatePreview(html(), parsed.data, systemSampleData(), locale());
  });
  const setSystemSampleValue = (name: string, value: string) => setSystemSampleData((current) => ({ ...current, [name]: value }));
  const dirty = () =>
    sampleDataSource() !== cleanSampleDataSource ||
    workflowEmailTemplateDraftDirty(
      { name: name(), description: description(), subject: subject(), html: html(), sampleData: sampleData(), enabled: enabled() },
      cleanDraft,
    );
  const closeIfClean = async () => {
    if (saveMut.loading()) return;
    if (await confirmDiscardIfDirty(dirty)) props.onClose();
  };
  props.setDismissHandler(closeIfClean);

  const saveMut = mutations.create<PublicEmailTemplate, void>({
    mutation: async (_, { abortSignal }) => {
      const payload = {
        name: name().trim(),
        description: description().trim() || null,
        subject: subject().trim(),
        html: html().trim(),
        sampleData: sampleData(),
        enabled: enabled(),
      };
      if (!payload.name) throw new Error(t().nameRequired);
      if (!payload.subject) throw new Error(t().subjectRequired);
      if (!payload.html) throw new Error(t().htmlRequired);
      const res = props.template
        ? await apiClient["email-templates"][":templateId"].$patch(
            { param: { templateId: props.template.id }, json: payload },
            { init: { signal: abortSignal } },
          )
        : await apiClient["email-templates"]["by-base"][":baseId"].$post(
            { param: { baseId: props.baseId }, json: payload },
            { init: { signal: abortSignal } },
          );
      if (!res.ok) throw new Error(await errorMessage(res, t().saveEmailTemplateFailed));
      return PublicEmailTemplateSchema.parse(await res.json());
    },
    onSuccess: (saved) => {
      toast.success(t().savedNamed({ name: saved.name }));
      props.onSaved();
      props.onClose();
    },
    onError: (error) => prompts.error(error.message),
  });

  const canSave = () =>
    name().trim().length > 0 && subject().trim().length > 0 && html().trim().length > 0 && parsedSampleData().ok && !saveMut.loading();

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.template ? t().emailTemplateNamed({ name: props.template.name }) : t().newEmailTemplate}
        subtitle={t().emailTemplateSubtitle}
        icon="ti ti-mail"
        close={() => void closeIfClean()}
      />
      <PanelDialog.Body scrollPreserveKey={`grids-email-template-editor-${props.template?.id ?? "new"}`}>
        <div class="flex min-h-[42rem] flex-1 flex-col gap-2" inert={saveMut.loading()}>
          <div class="grid shrink-0 gap-2 md:grid-cols-2">
            <TextInput label={t().name} value={name} onValueChange={setName} required icon="ti ti-mail" placeholder={t().invoiceEmail} />
            <TextInput
              label={t().description}
              value={description}
              onValueChange={setDescription}
              icon="ti ti-align-left"
              placeholder={t().optional}
            />
            <TextInput
              label={t().subject}
              value={subject}
              onValueChange={setSubject}
              required
              icon="ti ti-text-caption"
              placeholder="{{ workflow.name }}"
              monospace
            />
            <div class="md:col-span-2">
              <CheckboxCard
                label={t().enabled}
                description={t().enabledEmailDescription}
                icon="ti ti-mail-check"
                value={enabled}
                onValueChange={setEnabled}
              />
            </div>
          </div>
          <p class="shrink-0 text-xs text-dimmed">{t().templateTypingHint}</p>
          <div class="min-h-[30rem] min-w-0 flex-1 overflow-hidden">
            <Panes
              layout={layout()}
              onLayoutChange={setLayout}
              class="h-full w-full"
              resizable={false}
              items={[
                {
                  id: "html",
                  title: "HTML",
                  icon: "ti ti-code",
                  render: () => (
                    <div class="h-full min-h-0 overflow-auto">
                      <TemplateEditor
                        value={html}
                        onValueChange={setHtml}
                        variables={variables()}
                        fill
                        placeholder="<p>Hello {{ business.legalName | default: app.name }}</p>"
                      />
                    </div>
                  ),
                },
                {
                  id: "preview",
                  title: t().preview,
                  icon: "ti ti-eye",
                  render: () => <TemplatePreview html={renderedPreview()} />,
                },
                {
                  id: "sample-data",
                  title: t().sampleData,
                  icon: "ti ti-database",
                  render: () => (
                    <ScrollArea class="flex h-full min-h-0 flex-col gap-2">
                      <TextInput
                        label={t().workflowData}
                        description={t().workflowDataDescription}
                        value={sampleDataSource}
                        onValueChange={setSampleDataSource}
                        error={() => {
                          const parsed = parsedSampleData();
                          return parsed.ok ? undefined : parsed.error;
                        }}
                        icon="ti ti-braces"
                        multiline
                        monospace
                        lines={14}
                        spellcheck={false}
                        autocapitalize="off"
                      />
                      <TemplateSampleData
                        variables={EMAIL_TEMPLATE_SYSTEM_VARIABLES}
                        values={systemSampleData()}
                        onValueChange={setSystemSampleValue}
                      />
                    </ScrollArea>
                  ),
                },
              ]}
            />
          </div>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div />
        <div class="flex items-center gap-2">
          <Button variant="secondary" size="sm" type="button" disabled={saveMut.loading()} onClick={() => void closeIfClean()}>
            {t().cancel}
          </Button>
          <Button variant="primary" size="sm" type="button" disabled={!canSave()} onClick={() => saveMut.mutate()}>
            <i class={saveMut.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-device-floppy"} /> {t().saveEmailTemplate}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export function EmailTemplateManager(props: { baseId: string; onChanged: () => void; onClose: () => void }) {
  const locale = useLocale();
  const t = () => workflowMessages.resolve([locale()]).t;
  const [templates, setTemplates] = createSignal<PublicEmailTemplate[]>([]);
  const [dependencies, setDependencies] = createSignal<PublicEmailTemplateDependencyMap>({});
  const loadMut = mutations.create<void, void>({
    mutation: async (_, { abortSignal }) => {
      const [templatesRes, dependenciesRes] = await Promise.all([
        emailTemplateManagerApi["by-base"][":baseId"].$get({ param: { baseId: props.baseId } }, { init: { signal: abortSignal } }),
        emailTemplateManagerApi["by-base"][":baseId"].dependencies.$get(
          { param: { baseId: props.baseId } },
          { init: { signal: abortSignal } },
        ),
      ]);
      if (!templatesRes.ok) throw new Error(await errorMessage(templatesRes, t().loadEmailTemplatesFailed));
      if (!dependenciesRes.ok) throw new Error(await errorMessage(dependenciesRes, t().loadEmailUsageFailed));
      setTemplates(PublicEmailTemplateListSchema.parse(await templatesRes.json()));
      setDependencies(PublicEmailTemplateDependencyMapSchema.parse(await dependenciesRes.json()));
    },
  });

  const deleteMut = mutations.create<{ deleted: boolean }, PublicEmailTemplate>({
    mutation: async (template, { abortSignal }) => {
      const usedBy = dependencies()[template.id] ?? [];
      if (usedBy.length > 0) {
        throw new Error(
          usedBy.length === 1 ? t().templateUsedByOne({ name: usedBy[0]!.workflowName }) : t().templateUsedByMany({ count: usedBy.length }),
        );
      }
      const confirmed = await prompts.confirm(t().deleteNamedConfirm({ name: template.name }), {
        title: t().deleteEmailTemplate,
        icon: "ti ti-trash",
        confirmText: t().deleteTemplate,
        variant: "danger",
      });
      if (!confirmed) return { deleted: false };
      const res = await apiClient["email-templates"][":templateId"].$delete(
        { param: { templateId: template.id } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await errorMessage(res, t().deleteEmailTemplateFailed));
      return { deleted: true };
    },
    onSuccess: (result) => {
      if (!result.deleted) return;
      toast.success(t().emailTemplateDeleted);
      props.onChanged();
      loadMut.mutate();
    },
    onError: (error) => prompts.error(error.message),
  });

  onMount(() => loadMut.mutate());

  const openEditor = async (template?: PublicEmailTemplate) => {
    await dialogCore.open<void>(
      (close, context) => (
        <EmailTemplateEditor
          baseId={props.baseId}
          template={template}
          setDismissHandler={context.setDismissHandler}
          onSaved={() => {
            props.onChanged();
            loadMut.mutate();
          }}
          onClose={close}
        />
      ),
      panelDialogWorkspaceOptions,
    );
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().emailTemplates}
        subtitle={t().emailTemplateSubtitle}
        icon="ti ti-mail"
        actions={
          <Button variant="primary" size="sm" type="button" onClick={() => void openEditor()}>
            <i class="ti ti-plus" /> {t().addEmailTemplate}
          </Button>
        }
        close={props.onClose}
      />
      <PanelDialog.Body scrollPreserveKey="grids-email-template-manager">
        <Show when={loadMut.error()}>
          {(error) => (
            <NoticeCard tone="danger" title={t().couldNotLoadEmailTemplates} class="mb-4">
              <Show when={error().message.replace(/\.$/, "") !== t().couldNotLoadEmailTemplates}>{error().message}</Show>
              <Button variant="secondary" size="sm" loading={loadMut.loading()} onClick={() => void loadMut.retry()}>
                {t().retry}
              </Button>
            </NoticeCard>
          )}
        </Show>
        <Show when={!loadMut.error() || templates().length > 0}>
          <section class="paper flex flex-col gap-1 overflow-hidden p-1">
            <For
              each={templates()}
              fallback={
                <Placeholder
                  state={loadMut.error() ? "error" : loadMut.loading() ? "loading" : "empty"}
                  align="left"
                  class="py-8"
                  title={
                    loadMut.error() ? t().couldNotLoadEmailTemplates : loadMut.loading() ? t().loadingEmailTemplates : t().noEmailTemplates
                  }
                  description={loadMut.error()?.message}
                />
              }
            >
              {(template) => (
                <article class="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-[var(--ui-radius-control)] px-3 py-2 transition-colors hover:bg-[var(--ui-hover)]">
                  <span class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-secondary">
                    <i class="ti ti-mail" />
                  </span>
                  <button type="button" class="min-w-0 text-left" onClick={() => void openEditor(template)}>
                    <span class="flex min-w-0 items-center gap-2">
                      <span class="truncate text-sm font-semibold text-primary">{template.name}</span>
                      <StatusBadge tone={template.enabled ? "ok" : "neutral"} label={template.enabled ? t().enabled : t().disabled} />
                    </span>
                    <span class="mt-0.5 block truncate text-xs text-dimmed">{template.subject}</span>
                    <Show when={template.description}>
                      {(description) => <span class="mt-1 block truncate text-xs text-dimmed">{description()}</span>}
                    </Show>
                    <Show when={(dependencies()[template.id] ?? []).length > 0}>
                      <span class="mt-1 block truncate text-xs text-secondary">
                        {t().usedBy({ names: (dependencies()[template.id] ?? []).map((dependency) => dependency.workflowName).join(", ") })}
                      </span>
                    </Show>
                  </button>
                  <div class="flex items-center gap-1">
                    <Tooltip.Anchor content={t().editEmailTemplate}>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        type="button"
                        label={t().editEmailTemplate}
                        onClick={() => void openEditor(template)}
                      >
                        <i class="ti ti-pencil" />
                      </IconButton>
                    </Tooltip.Anchor>
                    <Tooltip.Anchor content={t().deleteEmailTemplate}>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        type="button"
                        class="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                        label={t().deleteEmailTemplate}
                        disabled={deleteMut.loading() || (dependencies()[template.id] ?? []).length > 0}
                        onClick={() => deleteMut.mutate(template)}
                      >
                        <i class={deleteMut.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-trash"} />
                      </IconButton>
                    </Tooltip.Anchor>
                  </div>
                </article>
              )}
            </For>
          </section>
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div />
        <Button variant="secondary" size="sm" type="button" onClick={props.onClose}>
          {t().close}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
