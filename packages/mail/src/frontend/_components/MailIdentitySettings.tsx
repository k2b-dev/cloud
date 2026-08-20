import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  confirmDiscardIfDirty,
  FileDropzone,
  IconButton,
  NoticeCard,
  NumberInput,
  prompts,
  Select,
  SettingsCollection,
  StatusBadge,
  type StatusTone,
  TextInput,
  toast,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { ComposeTemplate, MailComposeFormat, MailPriority, SenderIdentity, SenderIdentityTransport } from "../../contracts";
import { readApiError } from "./api-response";
import MailRecipientInput from "./MailRecipientInput";
import { EditorHeading, type ProviderSettingsProps } from "./mail-provider-settings-shared";
import { formatMailRecipients, parseMailRecipients } from "./mail-recipient";

type IdentityEditor = { kind: "create" } | { kind: "edit"; identity: SenderIdentity } | { kind: "verify"; identity: SenderIdentity };

const identityStatusTone = (status: SenderIdentity["status"]): StatusTone => {
  if (status === "verified") return "ok";
  if (status === "unverified") return "warning";
  if (status === "rejected") return "error";
  return "neutral";
};

export function MailIdentitySettings(props: ProviderSettingsProps & { mailboxSignatures: ComposeTemplate[] }) {
  const [editor, setEditor] = createSignal<IdentityEditor | null>(null);
  const [identities, setIdentities] = createSignal(props.admin.identities);
  const [label, setLabel] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [address, setAddress] = createSignal("");
  const [replyTo, setReplyTo] = createSignal("");
  const [defaultCc, setDefaultCc] = createSignal<string[]>([]);
  const [defaultBcc, setDefaultBcc] = createSignal<string[]>([]);
  const [defaultFormat, setDefaultFormat] = createSignal<MailComposeFormat>("markdown");
  const [defaultPriority, setDefaultPriority] = createSignal<MailPriority>("normal");
  const [defaultDeliveryReceipt, setDefaultDeliveryReceipt] = createSignal(false);
  const [defaultReadReceipt, setDefaultReadReceipt] = createSignal(false);
  const [vcard, setVcard] = createSignal<string | null>(null);
  const [vcardError, setVcardError] = createSignal<string | null>(null);
  const [envelopeSender, setEnvelopeSender] = createSignal("");
  const [defaultSignatureTemplateId, setDefaultSignatureTemplateId] = createSignal("");
  const [sentFolderId, setSentFolderId] = createSignal("");
  const [draftsFolderId, setDraftsFolderId] = createSignal("");
  const [isDefault, setIsDefault] = createSignal(false);
  const [allowAutomation, setAllowAutomation] = createSignal(true);
  const [bindingId, setBindingId] = createSignal("");
  const [recipient, setRecipient] = createSignal("");
  const [savesSent, setSavesSent] = createSignal(false);
  const [customSmtpEnabled, setCustomSmtpEnabled] = createSignal(false);
  const [customSmtpHost, setCustomSmtpHost] = createSignal("");
  const [customSmtpPort, setCustomSmtpPort] = createSignal(587);
  const [customSmtpTlsMode, setCustomSmtpTlsMode] = createSignal<"implicit" | "starttls">("starttls");
  const [customSmtpUsername, setCustomSmtpUsername] = createSignal("");
  const [customSmtpPassword, setCustomSmtpPassword] = createSignal("");
  const [editorBaseline, setEditorBaseline] = createSignal("");

  createEffect(() => setIdentities(props.admin.identities));

  const selectableFolders = createMemo(() =>
    props.admin.folders.filter((folder) => folder.selectable && folder.discoveryState === "active"),
  );
  const activeBindings = createMemo(() => props.admin.bindings.filter((binding) => binding.state === "active"));
  const mailboxSignatures = createMemo(() =>
    props.mailboxSignatures.filter((template) => template.kind === "signature" && template.scope === "mailbox"),
  );
  const editingIdentity = createMemo(() => {
    const current = editor();
    return current?.kind === "edit" ? current.identity : null;
  });
  const editorValue = () =>
    JSON.stringify({
      kind: editor()?.kind ?? null,
      label: label(),
      displayName: displayName(),
      address: address(),
      replyTo: replyTo(),
      defaultCc: defaultCc(),
      defaultBcc: defaultBcc(),
      defaultFormat: defaultFormat(),
      defaultPriority: defaultPriority(),
      defaultDeliveryReceipt: defaultDeliveryReceipt(),
      defaultReadReceipt: defaultReadReceipt(),
      vcard: vcard(),
      envelopeSender: envelopeSender(),
      defaultSignatureTemplateId: defaultSignatureTemplateId(),
      sentFolderId: sentFolderId(),
      draftsFolderId: draftsFolderId(),
      isDefault: isDefault(),
      allowAutomation: allowAutomation(),
      bindingId: bindingId(),
      recipient: recipient(),
      savesSent: savesSent(),
      customSmtpEnabled: customSmtpEnabled(),
      customSmtpHost: customSmtpHost(),
      customSmtpPort: customSmtpPort(),
      customSmtpTlsMode: customSmtpTlsMode(),
      customSmtpUsername: customSmtpUsername(),
      customSmtpPassword: customSmtpPassword(),
    });
  const editorDirty = () => editor() !== null && editorValue() !== editorBaseline();
  const captureEditorBaseline = () => setEditorBaseline(editorValue());
  const closeEditor = async () => {
    if (!(await confirmDiscardIfDirty(editorDirty))) return;
    setEditor(null);
  };

  createEffect(() => props.onDirtyChange?.(editorDirty()));
  onCleanup(() => props.onDirtyChange?.(false));
  const replaceIdentity = (identity: SenderIdentity) =>
    setIdentities((current) =>
      current.some((item) => item.id === identity.id)
        ? current.map((item) => (item.id === identity.id ? identity : item))
        : [...current, identity],
    );

  const openCreate = () => {
    setLabel(props.admin.connections[0]?.name ?? props.admin.connections[0]?.email ?? "New identity");
    setDisplayName("");
    setAddress(props.admin.connections[0]?.email ?? props.currentUserEmail ?? "");
    setReplyTo("");
    setDefaultCc([]);
    setDefaultBcc([]);
    setDefaultFormat("markdown");
    setDefaultPriority("normal");
    setDefaultDeliveryReceipt(false);
    setDefaultReadReceipt(false);
    setVcard(null);
    setVcardError(null);
    setEnvelopeSender("");
    setDefaultSignatureTemplateId("");
    setSentFolderId(selectableFolders().find((folder) => folder.role === "sent")?.id ?? "");
    setDraftsFolderId(selectableFolders().find((folder) => folder.role === "drafts")?.id ?? "");
    setIsDefault(identities().length === 0);
    setAllowAutomation(true);
    setCustomSmtpEnabled(false);
    setCustomSmtpHost("");
    setCustomSmtpPort(587);
    setCustomSmtpTlsMode("starttls");
    setCustomSmtpUsername("");
    setCustomSmtpPassword("");
    setEditor({ kind: "create" });
    captureEditorBaseline();
  };

  const openEdit = (identity: SenderIdentity) => {
    setLabel(identity.label);
    setDisplayName(identity.displayName);
    setAddress(identity.fromAddress);
    setReplyTo(identity.replyTo ?? "");
    setDefaultCc(formatMailRecipients(identity.defaultCc));
    setDefaultBcc(formatMailRecipients(identity.defaultBcc));
    setDefaultFormat(identity.defaultFormat);
    setDefaultPriority(identity.defaultPriority);
    setDefaultDeliveryReceipt(identity.defaultDeliveryReceipt);
    setDefaultReadReceipt(identity.defaultReadReceipt);
    setVcard(identity.vcard);
    setVcardError(null);
    setEnvelopeSender(identity.envelopeSender ?? "");
    setDefaultSignatureTemplateId(identity.defaultSignatureTemplateId ?? "");
    setSentFolderId(identity.sentFolderId ?? "");
    setDraftsFolderId(identity.draftsFolderId ?? "");
    setIsDefault(identity.isDefault);
    setAllowAutomation(identity.authenticationPolicy.automation === "mailbox");
    setCustomSmtpEnabled(identity.transport.mode === "custom");
    setCustomSmtpHost(identity.transport.host ?? "");
    setCustomSmtpPort(identity.transport.port ?? 587);
    setCustomSmtpTlsMode(identity.transport.tlsMode ?? "starttls");
    setCustomSmtpUsername(identity.transport.username ?? "");
    setCustomSmtpPassword("");
    setEditor({ kind: "edit", identity });
    captureEditorBaseline();
  };

  const openVerify = (identity: SenderIdentity) => {
    setBindingId(activeBindings()[0]?.id ?? "");
    setRecipient(props.currentUserEmail ?? identity.fromAddress);
    setSavesSent(false);
    setEditor({ kind: "verify", identity });
    captureEditorBaseline();
  };

  const createIdentity = mutation.create<SenderIdentity, void>({
    mutation: async (_input, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["sender-identities"].$post(
        {
          param: { mailboxId: props.mailbox.id },
          json: {
            label: label().trim(),
            displayName: displayName().trim(),
            fromAddress: address().trim(),
            replyTo: replyTo().trim() || null,
            defaultCc: parseMailRecipients(defaultCc()),
            defaultBcc: parseMailRecipients(defaultBcc()),
            defaultFormat: defaultFormat(),
            defaultPriority: defaultPriority(),
            defaultDeliveryReceipt: defaultDeliveryReceipt(),
            defaultReadReceipt: defaultReadReceipt(),
            vcard: vcard(),
            envelopeSender: envelopeSender().trim() || null,
            defaultSignatureTemplateId: defaultSignatureTemplateId() || null,
            authenticationPolicy: { automation: allowAutomation() ? "mailbox" : "disabled" },
            sentFolderId: sentFolderId() || null,
            draftsFolderId: draftsFolderId() || null,
            isDefault: isDefault(),
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "Failed to add identity"));
      return response.json();
    },
    onSuccess: (identity) => {
      replaceIdentity(identity);
      toast.success("Identity added");
      setEditor(null);
      setEditorBaseline("");
      props.onWorkspaceChange();
      void props.onReload();
    },
    onError: (error) => prompts.error(error.message),
  });

  const updateIdentity = mutation.create<SenderIdentity, void>({
    mutation: async (_input, { abortSignal }) => {
      const current = editor();
      if (!current || current.kind !== "edit") throw new Error("No identity selected");
      const response = await apiClient.mailboxes[":mailboxId"]["sender-identities"][":senderIdentityId"].$patch(
        {
          param: { mailboxId: props.mailbox.id, senderIdentityId: current.identity.id },
          json: {
            label: label().trim(),
            displayName: displayName().trim(),
            fromAddress: address().trim(),
            replyTo: replyTo().trim() || null,
            defaultCc: parseMailRecipients(defaultCc()),
            defaultBcc: parseMailRecipients(defaultBcc()),
            defaultFormat: defaultFormat(),
            defaultPriority: defaultPriority(),
            defaultDeliveryReceipt: defaultDeliveryReceipt(),
            defaultReadReceipt: defaultReadReceipt(),
            vcard: vcard(),
            envelopeSender: envelopeSender().trim() || null,
            defaultSignatureTemplateId: defaultSignatureTemplateId() || null,
            authenticationPolicy: { automation: allowAutomation() ? "mailbox" : "disabled" },
            sentFolderId: sentFolderId() || null,
            draftsFolderId: draftsFolderId() || null,
            isDefault: isDefault(),
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "Failed to update identity"));
      return response.json();
    },
    onSuccess: (identity) => {
      replaceIdentity(identity);
      toast.success("Identity updated");
      setEditor(null);
      setEditorBaseline("");
      props.onWorkspaceChange();
      void props.onReload();
    },
    onError: (error) => prompts.error(error.message),
  });

  const replaceTransport = (transport: SenderIdentityTransport) => {
    const current = editor();
    if (!current || current.kind !== "edit") return;
    const identity = { ...current.identity, transport };
    replaceIdentity(identity);
    setEditor({ kind: "edit", identity });
    setCustomSmtpPassword("");
    captureEditorBaseline();
  };

  const saveCustomSmtp = mutation.create<SenderIdentityTransport, void>({
    mutation: async (_input, { abortSignal }) => {
      const current = editor();
      if (!current || current.kind !== "edit") throw new Error("Save the identity before configuring a custom SMTP server");
      if (!customSmtpHost().trim() || !customSmtpUsername().trim()) {
        throw new Error("SMTP host and username are required");
      }
      if (current.identity.transport.mode !== "custom" && !customSmtpPassword()) {
        throw new Error("Enter the SMTP password");
      }
      const response = await apiClient.mailboxes[":mailboxId"]["sender-identities"][":senderIdentityId"].transport.$put(
        {
          param: { mailboxId: props.mailbox.id, senderIdentityId: current.identity.id },
          json: {
            expectedRevision: current.identity.transport.revision,
            host: customSmtpHost().trim(),
            port: customSmtpPort(),
            tlsMode: customSmtpTlsMode(),
            username: customSmtpUsername().trim(),
            ...(customSmtpPassword() ? { secret: { kind: "password" as const, password: customSmtpPassword() } } : {}),
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "SMTP server could not be saved"));
      return response.json();
    },
    onSuccess: (transport) => {
      replaceTransport(transport);
      toast.success("SMTP server verified and saved");
      props.onWorkspaceChange();
    },
    onError: (error) => prompts.error(error.message),
  });

  const removeCustomSmtp = mutation.create<SenderIdentityTransport | null, void>({
    mutation: async (_input, { abortSignal }) => {
      const current = editor();
      if (!current || current.kind !== "edit") throw new Error("No identity selected");
      const confirmed = await prompts.confirm("New messages using this identity will be sent through the mailbox connection.", {
        title: "Use the mailbox SMTP server?",
        confirmText: "Use mailbox SMTP",
      });
      if (!confirmed || abortSignal.aborted) return null;
      const response = await apiClient.mailboxes[":mailboxId"]["sender-identities"][":senderIdentityId"].transport.$delete(
        {
          param: { mailboxId: props.mailbox.id, senderIdentityId: current.identity.id },
          json: { expectedRevision: current.identity.transport.revision },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "Custom SMTP server could not be removed"));
      return response.json();
    },
    onSuccess: (transport) => {
      if (!transport) return;
      replaceTransport(transport);
      setCustomSmtpEnabled(false);
      setCustomSmtpHost("");
      setCustomSmtpUsername("");
      toast.success("Mailbox SMTP server selected");
      props.onWorkspaceChange();
    },
    onError: (error) => prompts.error(error.message),
  });

  const disableIdentity = mutation.create<{ disabled: boolean; identity: SenderIdentity }, SenderIdentity>({
    mutation: async (identity, { abortSignal }) => {
      const confirmed = await prompts.confirm(
        "Existing sent mail remains unchanged. This address can no longer be selected for new messages or automatic replies.",
        { title: `Disable ${identity.label}?`, confirmText: "Disable identity", variant: "danger" },
      );
      if (!confirmed || abortSignal.aborted) return { disabled: false, identity };
      const response = await apiClient.mailboxes[":mailboxId"]["sender-identities"][":senderIdentityId"].$delete(
        { param: { mailboxId: props.mailbox.id, senderIdentityId: identity.id } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "Failed to disable identity"));
      return { disabled: true, identity };
    },
    onSuccess: async ({ disabled, identity }) => {
      if (!disabled) return;
      setIdentities((current) => current.filter((item) => item.id !== identity.id));
      setEditor(null);
      setEditorBaseline("");
      toast.success("Identity disabled");
      props.onWorkspaceChange();
      await props.onReload();
    },
    onError: (error) => prompts.error(error.message),
  });

  const verifyIdentity = mutation.create<SenderIdentity, void>({
    mutation: async (_input, { abortSignal }) => {
      const current = editor();
      if (!current || current.kind !== "verify") throw new Error("No identity selected");
      const response = await apiClient.mailboxes[":mailboxId"]["sender-identities"][":senderIdentityId"].verify.$post(
        {
          param: { mailboxId: props.mailbox.id, senderIdentityId: current.identity.id },
          json: { bindingId: bindingId(), verificationRecipient: recipient().trim(), savesSentAutomatically: savesSent() },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "Sender verification failed"));
      return response.json();
    },
    onSuccess: (identity) => {
      replaceIdentity(identity);
      toast.success("Identity verified");
      setEditor(null);
      setEditorBaseline("");
      props.onWorkspaceChange();
      void props.onReload();
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => {
    createIdentity.abort();
    updateIdentity.abort();
    saveCustomSmtp.abort();
    removeCustomSmtp.abort();
    disableIdentity.abort();
    verifyIdentity.abort();
  });

  return (
    <Show
      when={editor()}
      fallback={
        <SettingsCollection
          title="Sending identities"
          description="Names, addresses, defaults, and signatures available while writing."
          empty="No sending identities yet."
        >
          <SettingsCollection.Action>
            <Button variant="secondary" size="sm" type="button" disabled={props.reloading} onClick={openCreate}>
              <i class="ti ti-plus" aria-hidden="true" /> Add identity
            </Button>
          </SettingsCollection.Action>
          <For each={identities()}>
            {(identity) => (
              <SettingsCollection.Item
                title={identity.label}
                description={identity.fromAddress}
                icon={<i class="ti ti-at" aria-hidden="true" />}
              >
                <SettingsCollection.Item.Status>
                  <Show when={identity.isDefault}>
                    <StatusBadge tone="neutral" label="Default" icon={null} />
                  </Show>
                  <StatusBadge
                    class="capitalize"
                    tone={identityStatusTone(identity.status)}
                    label={identity.status === "verified" ? "Ready" : identity.status.replaceAll("_", " ")}
                  />
                  <Show when={identity.authenticationPolicy.automation === "mailbox"}>
                    <StatusBadge tone="neutral" label="Automatic replies" icon={null} />
                  </Show>
                </SettingsCollection.Item.Status>
                <SettingsCollection.Item.Actions>
                  <Show when={identity.status === "unverified" || identity.status === "rejected"}>
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      disabled={activeBindings().length === 0 || props.reloading}
                      onClick={() => openVerify(identity)}
                    >
                      Verify
                    </Button>
                  </Show>
                  <IconButton type="button" label={`Edit ${identity.label}`} onClick={() => openEdit(identity)}>
                    <i class="ti ti-edit" aria-hidden="true" />
                  </IconButton>
                </SettingsCollection.Item.Actions>
              </SettingsCollection.Item>
            )}
          </For>
        </SettingsCollection>
      }
    >
      {(currentEditor) => (
        <div class="flex flex-col gap-2">
          <Show
            when={currentEditor().kind !== "verify"}
            fallback={
              <>
                <EditorHeading
                  title="Verify identity"
                  description={`Confirm that the provider accepts messages sent with ${(currentEditor() as Extract<IdentityEditor, { kind: "verify" }>).identity.label}.`}
                  onBack={closeEditor}
                />
                <NoticeCard tone="info" icon={false} bodyClass="flex items-start gap-2">
                  <i class="ti ti-info-circle mt-0.5 shrink-0" aria-hidden="true" />
                  <p>
                    Mail sends a real test message through this provider. The identity is ready to use only after the provider accepts its
                    From address and delivery settings.
                  </p>
                </NoticeCard>
                <Select
                  label="Connected account"
                  value={bindingId}
                  onValueChange={setBindingId}
                  options={activeBindings().map((binding) => ({ id: binding.id, label: binding.authenticatedPrincipal ?? binding.id }))}
                  required
                />
                <TextInput label="Verification recipient" type="email" value={recipient} onValueChange={setRecipient} required />
                <CheckboxCard
                  label="Provider saves sent mail automatically"
                  description="Turn this on if your provider already adds sent messages to Sent. Otherwise Mail saves a copy."
                  value={savesSent}
                  onValueChange={setSavesSent}
                />
                <div class="sticky bottom-0 flex justify-end gap-2 bg-[var(--ui-surface)] py-2">
                  <Button variant="ghost" size="sm" type="button" disabled={verifyIdentity.loading()} onClick={() => void closeEditor()}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    disabled={!bindingId() || !recipient().trim() || verifyIdentity.loading()}
                    onClick={() => verifyIdentity.mutate()}
                  >
                    <i class={verifyIdentity.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-shield-check"} aria-hidden="true" />
                    Send verification
                  </Button>
                </div>
              </>
            }
          >
            <EditorHeading
              title={currentEditor().kind === "edit" ? "Edit identity" : "Add identity"}
              description="Configure one selectable sending context for collaborators."
              onBack={closeEditor}
            />
            <Show when={editingIdentity()}>
              {(identity) => (
                <Show
                  when={identity().status === "verified"}
                  fallback={
                    <NoticeCard tone="warning" icon={false} bodyClass="flex items-center justify-between gap-3" role="status">
                      <span class="flex min-w-0 items-start gap-2">
                        <i class="ti ti-alert-circle mt-0.5 shrink-0" aria-hidden="true" />
                        <span>
                          This identity is not ready to send. Verify that the provider accepts its From address and delivery settings.
                        </span>
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        class="shrink-0"
                        disabled={activeBindings().length === 0 || props.reloading}
                        onClick={() => openVerify(identity())}
                      >
                        Verify identity
                      </Button>
                    </NoticeCard>
                  }
                >
                  <NoticeCard tone="success" icon={false} bodyClass="flex items-start gap-2" role="status">
                    <i class="ti ti-circle-check mt-0.5 shrink-0" aria-hidden="true" />
                    <p>Ready to send. The provider accepted a test message with this identity.</p>
                  </NoticeCard>
                </Show>
              )}
            </Show>
            <TextInput
              label="Identity label"
              description="The private name collaborators see in identity pickers."
              value={label}
              onValueChange={setLabel}
              required
            />
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <TextInput label="Display name" description="The name recipients see." value={displayName} onValueChange={setDisplayName} />
              <TextInput
                label="From address"
                description="The address recipients see."
                type="email"
                value={address}
                onValueChange={setAddress}
                required
              />
            </div>
            <TextInput
              label="Reply-to address"
              description="Optional address for recipient replies."
              type="email"
              value={replyTo}
              onValueChange={setReplyTo}
            />
            <div>
              <p class="text-sm font-medium text-primary">Default Cc</p>
              <p class="mb-1 text-xs text-dimmed">
                Added to new interactive drafts that use this identity. Writers can remove recipients before sending.
              </p>
              <MailRecipientInput
                value={defaultCc}
                onChange={setDefaultCc}
                placeholder="Add default Cc recipient"
                disabled={createIdentity.loading() || updateIdentity.loading()}
              />
            </div>
            <div>
              <p class="text-sm font-medium text-primary">Default Bcc</p>
              <p class="mb-1 text-xs text-dimmed">
                Added privately to new interactive drafts. Other recipients do not see these addresses.
              </p>
              <MailRecipientInput
                value={defaultBcc}
                onChange={setDefaultBcc}
                placeholder="Add default Bcc recipient"
                disabled={createIdentity.loading() || updateIdentity.loading()}
              />
            </div>
            <details class="group rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)]">
              <summary class="focus-ui flex cursor-pointer list-none items-center justify-between gap-3 rounded-[var(--ui-radius-control)] px-3 py-2.5 text-sm font-medium text-primary">
                <span class="flex items-center gap-2">
                  <i class="ti ti-pencil" aria-hidden="true" />
                  Writing defaults
                </span>
                <i class="ti ti-chevron-down transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <div class="flex flex-col gap-2 px-3 pb-3">
                <Select
                  label="Default signature"
                  description="Inserted into new messages unless a writer has a personal override."
                  value={defaultSignatureTemplateId}
                  onValueChange={setDefaultSignatureTemplateId}
                  options={mailboxSignatures().map((template) => ({ id: template.id, label: template.name }))}
                  clearable
                />
                <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Select
                    label="Message format"
                    description="Writers can change this for each draft."
                    value={defaultFormat}
                    onValueChange={(value) => setDefaultFormat(value === "plain" ? "plain" : "markdown")}
                    options={[
                      { id: "markdown", label: "Markdown", icon: "ti ti-markdown" },
                      { id: "plain", label: "Plain text", icon: "ti ti-align-left" },
                    ]}
                  />
                  <Select
                    label="Priority"
                    description="Normal is appropriate for most messages."
                    value={defaultPriority}
                    onValueChange={(value) => setDefaultPriority(value === "high" ? "high" : value === "low" ? "low" : "normal")}
                    options={[
                      { id: "normal", label: "Normal" },
                      { id: "high", label: "High", icon: "ti ti-arrow-up" },
                      { id: "low", label: "Low", icon: "ti ti-arrow-down" },
                    ]}
                  />
                </div>
              </div>
            </details>
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <CheckboxCard
                label="Default identity"
                description="Preselected when Mail cannot determine a more specific identity."
                icon="ti ti-star"
                value={isDefault}
                onValueChange={setIsDefault}
              />
              <CheckboxCard
                label="Allow automatic replies"
                description="Rules may use this identity. No message is sent until a rule is explicitly enabled."
                icon="ti ti-message-reply"
                value={allowAutomation}
                onValueChange={setAllowAutomation}
              />
            </div>
            <details class="group rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)]">
              <summary class="focus-ui flex cursor-pointer list-none items-center justify-between gap-3 rounded-[var(--ui-radius-control)] px-3 py-2.5 text-sm font-medium text-primary">
                <span class="flex items-center gap-2">
                  <i class="ti ti-adjustments" aria-hidden="true" />
                  Advanced delivery
                </span>
                <i class="ti ti-chevron-down transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <div class="flex flex-col gap-2 px-3 pb-3">
                <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <CheckboxCard
                    label="Request delivery receipts"
                    description="Ask the sending server for delivery or failure reports. Servers may ignore the request."
                    icon="ti ti-mail-check"
                    variant="input"
                    value={defaultDeliveryReceipt}
                    onValueChange={setDefaultDeliveryReceipt}
                  />
                  <CheckboxCard
                    label="Request read receipts"
                    description="Ask recipients for a read receipt. This is never proof that a message was read."
                    icon="ti ti-eye-check"
                    variant="input"
                    value={defaultReadReceipt}
                    onValueChange={setDefaultReadReceipt}
                  />
                </div>
                <TextInput
                  label="Return-path address"
                  description="Optional technical address for delivery failures. Leave empty unless your mail provider requires a separate bounce address."
                  type="email"
                  value={envelopeSender}
                  onValueChange={setEnvelopeSender}
                />
                <Select
                  label="Sent folder"
                  description="Required when the provider does not save submitted mail automatically."
                  value={sentFolderId}
                  onValueChange={setSentFolderId}
                  options={selectableFolders().map((folder) => ({ id: folder.id, label: folder.name, icon: "ti ti-folder" }))}
                  clearable
                />
                <Select
                  label="Drafts folder"
                  description="Provider folder used for projected drafts."
                  value={draftsFolderId}
                  onValueChange={setDraftsFolderId}
                  options={selectableFolders().map((folder) => ({ id: folder.id, label: folder.name, icon: "ti ti-folder" }))}
                  clearable
                />
                <Show
                  when={vcard()}
                  fallback={
                    <FileDropzone
                      label="Contact card"
                      description="Optionally attach one .vcf contact card to messages sent with this identity."
                      accept=".vcf,text/vcard,text/x-vcard"
                      multiple={false}
                      icon="ti ti-address-book"
                      title="Choose a vCard"
                      subtitle="VCF, up to 256 KB"
                      class="min-h-20 py-3"
                      error={vcardError}
                      onDrop={async ([file]) => {
                        setVcardError(null);
                        if (!file) return;
                        if (file.size > 256 * 1024) {
                          setVcardError("Choose a vCard smaller than 256 KB");
                          return;
                        }
                        try {
                          const value = await file.text();
                          const normalized = value.replaceAll("\r\n", "\n").trim();
                          if (!normalized.startsWith("BEGIN:VCARD\n") || !normalized.endsWith("\nEND:VCARD")) {
                            setVcardError("Choose a complete vCard file");
                            return;
                          }
                          setVcard(value);
                        } catch {
                          setVcardError("The vCard could not be read");
                        }
                      }}
                    />
                  }
                >
                  <div class="flex items-center gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface)] px-3 py-2">
                    <i class="ti ti-address-book shrink-0 text-secondary" aria-hidden="true" />
                    <span class="min-w-0 flex-1">
                      <span class="block text-sm font-medium text-primary">Contact card attached</span>
                      <span class="block text-xs text-dimmed">A vCard is added to every message from this identity.</span>
                    </span>
                    <IconButton type="button" label="Remove contact card" onClick={() => setVcard(null)}>
                      <i class="ti ti-x" aria-hidden="true" />
                    </IconButton>
                  </div>
                </Show>
                <Show when={editingIdentity()}>
                  {(identity) => (
                    <div class="flex flex-col gap-2 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface)] p-3">
                      <CheckboxCard
                        label="Use a separate SMTP server"
                        description="Only sending uses this server. Mailbox sync and sent-message storage continue through the connected account."
                        icon="ti ti-server"
                        variant="input"
                        value={customSmtpEnabled}
                        onValueChange={setCustomSmtpEnabled}
                      />
                      <Show when={customSmtpEnabled()}>
                        <div class="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem]">
                          <TextInput label="SMTP host" value={customSmtpHost} onValueChange={setCustomSmtpHost} required />
                          <NumberInput
                            label="Port"
                            value={customSmtpPort}
                            onValueChange={setCustomSmtpPort}
                            min={1}
                            max={65_535}
                            required
                          />
                        </div>
                        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <Select
                            label="Connection security"
                            value={customSmtpTlsMode}
                            onValueChange={(value) => setCustomSmtpTlsMode(value === "implicit" ? "implicit" : "starttls")}
                            options={[
                              { id: "starttls", label: "STARTTLS" },
                              { id: "implicit", label: "TLS" },
                            ]}
                          />
                          <TextInput label="Username" value={customSmtpUsername} onValueChange={setCustomSmtpUsername} required />
                        </div>
                        <TextInput
                          label="Password"
                          description={
                            identity().transport.mode === "custom"
                              ? "Leave empty to keep the stored password."
                              : "Encrypted and never shown again."
                          }
                          password
                          value={customSmtpPassword}
                          onValueChange={setCustomSmtpPassword}
                          required={identity().transport.mode !== "custom"}
                        />
                        <div class="flex justify-end">
                          <Button
                            variant="secondary"
                            size="sm"
                            type="button"
                            disabled={
                              saveCustomSmtp.loading() ||
                              !customSmtpHost().trim() ||
                              !customSmtpUsername().trim() ||
                              (identity().transport.mode !== "custom" && !customSmtpPassword())
                            }
                            onClick={() => saveCustomSmtp.mutate()}
                          >
                            <i class={saveCustomSmtp.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-shield-check"} aria-hidden="true" />
                            Verify and save SMTP
                          </Button>
                        </div>
                      </Show>
                      <Show when={!customSmtpEnabled() && identity().transport.mode === "custom"}>
                        <div class="flex justify-end">
                          <Button
                            variant="secondary"
                            size="sm"
                            type="button"
                            disabled={removeCustomSmtp.loading()}
                            onClick={() => removeCustomSmtp.mutate()}
                          >
                            <i class={removeCustomSmtp.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-server-off"} aria-hidden="true" />
                            Use mailbox SMTP
                          </Button>
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>
              </div>
            </details>
            <div class="sticky bottom-0 flex items-center justify-between gap-2 bg-[var(--ui-surface)] py-2">
              <Show when={editingIdentity()} fallback={<span />}>
                {(identity) => (
                  <Button
                    variant="danger"
                    size="sm"
                    type="button"
                    disabled={disableIdentity.loading() || updateIdentity.loading()}
                    onClick={() => disableIdentity.mutate(identity())}
                  >
                    <i class={disableIdentity.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-trash"} aria-hidden="true" />
                    Disable identity
                  </Button>
                )}
              </Show>
              <span class="flex items-center justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={createIdentity.loading() || updateIdentity.loading()}
                  onClick={() => void closeEditor()}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  type="button"
                  disabled={
                    !label().trim() || !address().trim() || Boolean(vcardError()) || createIdentity.loading() || updateIdentity.loading()
                  }
                  onClick={() => (currentEditor().kind === "edit" ? updateIdentity.mutate() : createIdentity.mutate())}
                >
                  <i
                    class={
                      createIdentity.loading() || updateIdentity.loading()
                        ? "ti ti-loader-2 animate-spin"
                        : currentEditor().kind === "edit"
                          ? "ti ti-device-floppy"
                          : "ti ti-plus"
                    }
                    aria-hidden="true"
                  />
                  {currentEditor().kind === "edit" ? "Save identity" : "Add identity"}
                </Button>
              </span>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
