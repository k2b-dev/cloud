import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  Button,
  confirmDiscardIfDirty,
  dialogCore,
  IconButton,
  MarkdownEditor,
  PanelDialog,
  panelDialogFixedOptions,
  panelDialogOptions,
  prompts,
  Select,
  SettingsCollection,
  SettingsGroup,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type {
  ComposeSignatureDefault,
  ComposeTemplate,
  ComposeTemplateKind,
  ComposeTemplateScope,
  MailboxComposeStyle,
  SenderIdentity,
} from "../../contracts";
import { readApiError } from "./api-response";
import { mailSettingsMessages } from "./mail-settings-messages";

const TEMPLATE_VARIABLES = [
  "actor.display_name",
  "actor.email",
  "mailbox.name",
  "mailbox.description",
  "sender.display_name",
  "sender.email",
  "sender.reply_to",
  "message.subject",
  "message.to",
  "message.cc",
] as const;
const templateEditorDialogOptions = { ...panelDialogOptions, cancelBehavior: "ignore" as const };
const emailDesignDialogOptions = { ...panelDialogFixedOptions, cancelBehavior: "ignore" as const };

function ComposeTemplateEditor(props: {
  mailboxId: string;
  template: ComposeTemplate | null;
  canCreateMailboxTemplate: boolean;
  close: () => void;
  onSaved: (template: ComposeTemplate) => void;
  onArchive: (template: ComposeTemplate) => Promise<boolean>;
  reloadTemplate: (templateId: string) => Promise<ComposeTemplate | null>;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const [kind, setKind] = createSignal<ComposeTemplateKind>(props.template?.kind ?? "snippet");
  const [scope, setScope] = createSignal<ComposeTemplateScope>(
    props.template?.scope ?? (props.canCreateMailboxTemplate ? "mailbox" : "private"),
  );
  const [name, setName] = createSignal(props.template?.name ?? "");
  const [shortcut, setShortcut] = createSignal(props.template?.shortcut ?? "");
  const [body, setBody] = createSignal(props.template?.body ?? "");
  const [revision, setRevision] = createSignal(props.template?.revision ?? null);
  const baseline = JSON.stringify({
    kind: props.template?.kind ?? "snippet",
    scope: props.template?.scope ?? (props.canCreateMailboxTemplate ? "mailbox" : "private"),
    name: props.template?.name ?? "",
    shortcut: props.template?.shortcut ?? "",
    body: props.template?.body ?? "",
  });
  const dirty = () => JSON.stringify({ kind: kind(), scope: scope(), name: name(), shortcut: shortcut(), body: body() }) !== baseline;
  const closeSafely = async () => {
    if (await confirmDiscardIfDirty(dirty)) props.close();
  };

  const save = mutations.create<ComposeTemplate, void>({
    mutation: async (_input, { abortSignal }) => {
      const response = props.template
        ? await apiClient.mailboxes[":mailboxId"]["compose-templates"][":templateId"].$patch(
            {
              param: { mailboxId: props.mailboxId, templateId: props.template.id },
              json: {
                expectedRevision: revision() ?? props.template.revision,
                name: name().trim(),
                shortcut: shortcut().trim().toLowerCase(),
                body: body(),
              },
            },
            { init: { signal: abortSignal } },
          )
        : await apiClient.mailboxes[":mailboxId"]["compose-templates"].$post(
            {
              param: { mailboxId: props.mailboxId },
              json: {
                kind: kind(),
                scope: scope(),
                name: name().trim(),
                shortcut: shortcut().trim().toLowerCase(),
                body: body(),
              },
            },
            { init: { signal: abortSignal } },
          );
      if (!response.ok) {
        if (response.status === 409 && props.template) {
          const current = await props.reloadTemplate(props.template.id);
          if (current) setRevision(current.revision);
          throw new Error(messages().templateConflict);
        }
        throw new Error(await readApiError(response, messages().failedSaveComposeTemplate));
      }
      return response.json();
    },
    onSuccess: (template) => {
      props.onSaved(template);
      toast.success(props.template ? messages().templateUpdated : messages().templateCreated);
      props.close();
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => save.abort());

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={
          props.template
            ? messages().editTemplateKind({ kind: props.template.kind === "signature" ? messages().signature : messages().snippet })
            : messages().newComposeTemplate
        }
        subtitle={messages().templateSubtitle}
        icon={kind() === "signature" ? "ti ti-signature" : "ti ti-bolt"}
        close={() => void closeSafely()}
      />
      <PanelDialog.Body>
        <PanelDialog.Section title={messages().template} subtitle={messages().templateInsertDescription} icon="ti ti-template">
          <Show when={!props.template}>
            <div class="grid gap-3 sm:grid-cols-2">
              <Select
                label={messages().type}
                description={messages().templateTypeDescription}
                value={kind}
                onValueChange={(value) => setKind(value === "signature" ? "signature" : "snippet")}
                options={[
                  { id: "snippet", label: messages().snippet, icon: "ti ti-bolt" },
                  { id: "signature", label: messages().signature, icon: "ti ti-signature" },
                ]}
              />
              <Select
                label={messages().visibility}
                description={messages().visibilityDescription}
                value={scope}
                onValueChange={(value) => setScope(value === "mailbox" ? "mailbox" : "private")}
                options={[
                  { id: "private", label: messages().private, icon: "ti ti-lock" },
                  ...(props.canCreateMailboxTemplate ? [{ id: "mailbox", label: messages().mailbox, icon: "ti ti-users" }] : []),
                ]}
              />
            </div>
          </Show>
          <div class="grid gap-3 sm:grid-cols-2">
            <TextInput
              label={messages().name}
              description={messages().templateNameDescription}
              value={name}
              onValueChange={setName}
              required
            />
            <TextInput
              label={messages().shortcut}
              description={messages().shortcutDescription({ shortcut: shortcut() || messages().shortcutExample })}
              value={shortcut}
              onValueChange={setShortcut}
              prefix="/"
              required
            />
          </div>
          <div>
            <p class="mb-1 text-sm font-medium text-primary">{messages().content}</p>
            <p class="mb-2 text-xs text-dimmed">{messages().templateContentDescription}</p>
            <MarkdownEditor value={body} onValueChange={setBody} lines={14} aria-label={messages().templateContent} spellcheck />
          </div>
          <div class="flex flex-wrap gap-1.5" role="group" aria-label={messages().availableComposeVariables}>
            <For each={TEMPLATE_VARIABLES}>
              {(variable) => (
                <button
                  type="button"
                  class="chip text-xs"
                  onClick={() => setBody((value) => `${value}${value && !value.endsWith("\n") ? " " : ""}{{ ${variable} }}`)}
                >
                  {variable}
                </button>
              )}
            </For>
          </div>
        </PanelDialog.Section>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Show when={props.template} fallback={<span />}>
          {(template) => (
            <Button
              variant="danger"
              size="sm"
              type="button"
              disabled={save.loading()}
              onClick={() => void props.onArchive(template()).then((archived) => archived && props.close())}
            >
              <i class="ti ti-archive" aria-hidden="true" />
              {messages().archiveAction}
            </Button>
          )}
        </Show>
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="sm" type="button" onClick={() => void closeSafely()}>
            {messages().cancel}
          </Button>
          <Button
            size="sm"
            type="button"
            disabled={save.loading() || !name().trim() || !shortcut().trim() || !body().trim()}
            onClick={() => save.mutate()}
          >
            <i class={`ti ${save.loading() ? "ti-loader-2 animate-spin" : "ti-device-floppy"}`} aria-hidden="true" />
            {messages().saveTemplate}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

function EmailDesignEditor(props: {
  mailboxId: string;
  style: MailboxComposeStyle;
  close: () => void;
  onSaved: (style: MailboxComposeStyle) => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const [customCss, setCustomCss] = createSignal(props.style.customCss);
  const [revision, setRevision] = createSignal(props.style.revision);
  const dirty = () => customCss() !== props.style.customCss;
  const closeSafely = async () => {
    if (await confirmDiscardIfDirty(dirty)) props.close();
  };
  const save = mutations.create<MailboxComposeStyle, void>({
    mutation: async (_input, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["compose-style"].$put(
        {
          param: { mailboxId: props.mailboxId },
          json: { expectedRevision: revision(), customCss: customCss() },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) {
        if (response.status === 409) {
          const currentResponse = await apiClient.mailboxes[":mailboxId"]["compose-style"].$get(
            { param: { mailboxId: props.mailboxId } },
            { init: { signal: abortSignal } },
          );
          if (currentResponse.ok) setRevision((await currentResponse.json()).revision);
          throw new Error(messages().emailDesignConflict);
        }
        throw new Error(await readApiError(response, messages().failedSaveEmailDesign));
      }
      return response.json();
    },
    onSuccess: (style) => {
      props.onSaved(style);
      toast.success(messages().emailDesignSaved);
      props.close();
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => save.abort());

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={messages().emailDesign}
        subtitle={messages().emailDesignSubtitle}
        icon="ti ti-palette"
        close={() => void closeSafely()}
      />
      <PanelDialog.Body>
        <PanelDialog.Section title={messages().cssAndPreview} subtitle={messages().cssAndPreviewDescription} icon="ti ti-code">
          <div class="grid min-w-0 grid-cols-1 gap-3 lg:grid-cols-2">
            <TextInput
              label={messages().mailboxCss}
              description={messages().unsavedPreviewDescription}
              value={customCss}
              onValueChange={setCustomCss}
              multiline
              lines={16}
              monospace
              placeholder=".mail-content { color: #18181b; }"
            />
            <div class="flex min-w-0 flex-col">
              <p class="mb-1 text-sm font-medium text-primary">{messages().preview}</p>
              <p class="mb-1 text-xs text-dimmed">{messages().unsavedPreviewDescription}</p>
              <iframe
                title={messages().mailboxEmailDesignPreview}
                sandbox=""
                class="paper min-h-[22rem] w-full flex-1 bg-white"
                srcdoc={`<!doctype html><html><head><meta charset="utf-8"><style>
                  body { margin: 0; padding: 24px; color: #18181b; background: #fff; font: 15px/1.55 system-ui, sans-serif; }
                  .mail-content { max-width: 640px; margin: 0 auto; }
                  h1 { margin: 0 0 16px; font-size: 22px; }
                  p { margin: 0 0 14px; }
                  a { color: #0f766e; }
                  blockquote { margin: 16px 0; padding-left: 14px; border-left: 3px solid #d4d4d8; color: #52525b; }
                  ${customCss().replaceAll("<", "\\3C ")}
                </style></head><body><main class="mail-content">
                  <h1>${messages().previewHeading}</h1>
                  <p>${messages().previewGreeting}</p>
                  <p>${messages().previewBody}</p>
                  <blockquote>${messages().previewQuote}</blockquote>
                  <p>${messages().previewClosing}<br>${messages().previewTeam}</p>
                </main></body></html>`}
              />
            </div>
          </div>
        </PanelDialog.Section>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span />
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="sm" type="button" disabled={save.loading()} onClick={() => void closeSafely()}>
            {messages().cancel}
          </Button>
          <Button size="sm" type="button" disabled={save.loading() || !dirty()} onClick={() => save.mutate()}>
            <i class={`ti ${save.loading() ? "ti-loader-2 animate-spin" : "ti-device-floppy"}`} aria-hidden="true" />
            {messages().saveEmailDesign}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export default function MailComposeSettings(props: {
  mailboxId: string;
  permission: "write" | "admin";
  initialTemplates: ComposeTemplate[];
  initialDefaults: ComposeSignatureDefault[];
  initialStyle: MailboxComposeStyle;
  identities: SenderIdentity[];
  onTemplatesChange?: (templates: ComposeTemplate[]) => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const [style, setStyle] = createSignal(props.initialStyle);
  const templateQuery = query.create({
    source: () => props.mailboxId,
    initial: { source: props.mailboxId, data: props.initialTemplates },
    load: async (mailboxId, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["compose-templates"].$get(
        { param: { mailboxId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedReloadComposeTemplates));
      return response.json();
    },
  });
  const defaultQuery = query.create({
    source: () => props.mailboxId,
    initial: { source: props.mailboxId, data: props.initialDefaults },
    load: async (mailboxId, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["compose-signature-defaults"].$get(
        { param: { mailboxId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedReloadSignatureDefaults));
      return response.json();
    },
  });
  const templates = () => templateQuery.data() ?? [];
  const defaults = () => defaultQuery.data() ?? [];
  const signatures = createMemo(() => templates().filter((template) => template.kind === "signature"));

  const reloadTemplates = async (): Promise<ComposeTemplate[]> => {
    await templateQuery.invalidate();
    const next = templates();
    props.onTemplatesChange?.(next);
    return next;
  };

  const replaceTemplate = () => void reloadTemplates().catch((error) => prompts.error(error.message));

  const openTemplate = (template: ComposeTemplate | null = null) =>
    dialogCore.open<void>(
      (close) => (
        <ComposeTemplateEditor
          mailboxId={props.mailboxId}
          template={template}
          canCreateMailboxTemplate={props.permission === "admin"}
          close={() => close()}
          onSaved={replaceTemplate}
          onArchive={archiveTemplate}
          reloadTemplate={async (templateId) => (await reloadTemplates()).find((template) => template.id === templateId) ?? null}
        />
      ),
      templateEditorDialogOptions,
    );

  const archiveTemplateMutation = mutations.create<boolean, ComposeTemplate>({
    mutation: async (template, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["compose-templates"][":templateId"].$delete(
        {
          param: { mailboxId: props.mailboxId, templateId: template.id },
          json: { expectedRevision: template.revision },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) {
        if (response.status === 409) {
          await Promise.all([templateQuery.invalidate(), defaultQuery.invalidate()]);
          throw new Error(messages().archivedTemplateConflict);
        }
        throw new Error(await readApiError(response, messages().failedArchiveComposeTemplate));
      }
      try {
        await Promise.all([templateQuery.invalidate(), defaultQuery.invalidate()]);
        props.onTemplatesChange?.(templates());
      } catch (error) {
        void prompts.error(error instanceof Error ? error.message : messages().composeTemplatesRefreshFailed, {
          title: messages().templateArchivedRefreshFailed,
        });
      }
      return true;
    },
    onSuccess: () => toast.success(messages().templateArchived),
    onError: (error) => prompts.error(error.message),
  });

  const archiveTemplate = async (template: ComposeTemplate) => {
    const confirmed = await prompts.confirm(messages().archiveTemplateDescription, {
      title: messages().archiveNamedTemplate({ name: template.name }),
      confirmText: messages().archiveAction,
      variant: "danger",
    });
    if (!confirmed) return false;
    await archiveTemplateMutation.mutate(template);
    return archiveTemplateMutation.data() === true && archiveTemplateMutation.error() === null;
  };

  const setDefaultMutation = mutations.create<void, { identity: SenderIdentity; scope: "private" | "mailbox"; templateId: string }>({
    mutation: async ({ identity, scope, templateId }, { abortSignal }) => {
      const current = defaults().find(
        (item) => item.senderIdentityId === identity.id && (scope === "private" ? item.userId !== null : item.userId === null),
      );
      const response = await apiClient.mailboxes[":mailboxId"]["sender-identities"][":senderIdentityId"]["compose-signature-default"].$put(
        {
          param: { mailboxId: props.mailboxId, senderIdentityId: identity.id },
          json: { scope, templateId: templateId || null, expectedRevision: current?.revision ?? null },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) {
        if (response.status === 409) {
          await defaultQuery.invalidate();
          throw new Error(messages().signatureDefaultConflict);
        }
        throw new Error(await readApiError(response, messages().failedUpdateSignatureDefault));
      }
      try {
        await defaultQuery.invalidate();
      } catch (error) {
        void prompts.error(error instanceof Error ? error.message : messages().signatureDefaultsRefreshFailed, {
          title: messages().defaultUpdatedRefreshFailed,
        });
      }
    },
    onSuccess: () => toast.success(messages().signatureDefaultUpdated),
    onError: (error) => prompts.error(error.message),
  });

  const setDefault = async (identity: SenderIdentity, scope: "private" | "mailbox", templateId: string) => {
    await setDefaultMutation.mutate({ identity, scope, templateId });
  };

  onCleanup(() => {
    archiveTemplateMutation.abort();
    setDefaultMutation.abort();
  });

  const openEmailDesign = () =>
    dialogCore.open<void>(
      (close) => <EmailDesignEditor mailboxId={props.mailboxId} style={style()} close={() => close()} onSaved={setStyle} />,
      emailDesignDialogOptions,
    );

  return (
    <div class="flex flex-col gap-6">
      <SettingsCollection
        title={messages().signaturesAndSnippets}
        description={messages().signaturesAndSnippetsDescription}
        empty={messages().noSignaturesOrSnippets}
      >
        <SettingsCollection.Action>
          <Button variant="secondary" size="sm" type="button" class="shrink-0" onClick={() => void openTemplate()}>
            <i class="ti ti-plus" aria-hidden="true" /> {messages().addTemplate}
          </Button>
        </SettingsCollection.Action>
        <For each={templates()}>
          {(template) => (
            <SettingsCollection.Item
              title={template.name}
              description={`/${template.shortcut}`}
              icon={<i class={`ti ${template.kind === "signature" ? "ti-signature" : "ti-bolt"}`} aria-hidden="true" />}
            >
              <SettingsCollection.Item.Status>
                <span class="chip text-xs">{template.kind === "signature" ? messages().signature : messages().snippet}</span>
                <span class="chip text-xs">{template.scope === "mailbox" ? messages().mailbox : messages().private}</span>
              </SettingsCollection.Item.Status>
              <Show when={template.scope === "private" || props.permission === "admin"}>
                <SettingsCollection.Item.Actions>
                  <IconButton
                    type="button"
                    label={messages().editNamed({ name: template.name })}
                    onClick={() => void openTemplate(template)}
                  >
                    <i class="ti ti-pencil" aria-hidden="true" />
                  </IconButton>
                </SettingsCollection.Item.Actions>
              </Show>
            </SettingsCollection.Item>
          )}
        </For>
      </SettingsCollection>

      <Show when={signatures().length > 0 && props.identities.length > 0}>
        <SettingsGroup title={messages().mySignatureOverrides} description={messages().mySignatureOverridesDescription}>
          <div class="flex flex-col gap-3">
            <For each={props.identities.filter((identity) => identity.status === "verified")}>
              {(identity) => {
                const privateDefault = () =>
                  defaults().find((item) => item.senderIdentityId === identity.id && item.userId !== null)?.templateId ?? "";
                return (
                  <Select
                    label={messages().mySignature({ name: identity.label })}
                    description={messages().overrideIdentitySignature({ address: identity.fromAddress })}
                    value={privateDefault}
                    onValueChange={(value) => void setDefault(identity, "private", value ?? "")}
                    disabled={setDefaultMutation.loading()}
                    options={signatures().map((template) => ({
                      id: template.id,
                      label: template.name,
                      description: template.scope === "mailbox" ? messages().mailboxSignature : messages().privateSignature,
                    }))}
                    clearable
                  />
                );
              }}
            </For>
          </div>
        </SettingsGroup>
      </Show>

      <Show when={props.permission === "admin"}>
        <SettingsGroup title={messages().emailDesign} description={messages().emailDesignDescription}>
          <SettingsGroup.Action>
            <Button variant="secondary" size="sm" type="button" class="shrink-0" onClick={() => void openEmailDesign()}>
              <i class="ti ti-palette" aria-hidden="true" />
              {messages().editDesign}
            </Button>
          </SettingsGroup.Action>
        </SettingsGroup>
      </Show>
    </div>
  );
}
