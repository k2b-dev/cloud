/**
 * Core settings admin form.
 *
 * Renders a configurable set of core settings (scoped per group: app/freeipa/...)
 * and bulk-PUTs changed entries to /api/admin/core/settings (atomic, owned by
 * core's own router).
 *
 * NOT a reusable cross-app component: knows the endpoint, knows the snapshot
 * shape, only used by Core's platform settings page. Other apps that have their
 * own settings build their own bespoke admin forms (DIY HTTP route + UI).
 */

import { img } from "@k2b/stdlib/browser";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  CheckboxCard,
  createTemplateEditorPanesLayout,
  DataTable,
  type DataTableColumn,
  dialogCore,
  IconButton,
  ImageInput,
  MultiSelectInput,
  NoticeCard,
  NumberInput,
  PanelDialog,
  Panes,
  panelDialogWideOptions,
  prompts,
  readSettingsError,
  Select,
  SettingsPage,
  SettingsPanelFooter,
  SettingsSection,
  StatCell,
  StatGrid,
  StatusBadge,
  Switch,
  sameSettingValue,
  TagsInput,
  TemplateEditor,
  TemplatePreview,
  TemplateSampleData,
  type TemplateVariable,
  type TemplateVariableKind,
  TextInput,
  Tooltip,
  toast,
} from "@k2b/ui";
import type { AiEnrichmentOverview } from "@valentinkolb/cloud/ai";
import { coreClient } from "@valentinkolb/cloud/clients/core";
import { AI_PLATFORM_PROMPT_TEMPLATE, formatBytes, renderLiquidTemplate } from "@valentinkolb/cloud/shared";
import { createMemo, createSignal, type JSX, Show } from "solid-js";
import { aiModelChoiceGroups, aiModelGroupFiltersFor } from "./ai-model-choice-groups";
import { LegacySettingsSection } from "./LegacySettingsPanel.island";

type SettingValueSource = "custom" | "env" | "default";

export type SettingFieldDef = {
  key: string;
  label: string;
  description: string;
  kind:
    | "string"
    | "text"
    | "email"
    | "url"
    | "secret"
    | "image"
    | "boolean"
    | "number"
    | "enum"
    | "string_list"
    | "number_list"
    | "cron"
    | "timezone"
    | "template";
  value: unknown;
  default: unknown;
  resetValue: unknown;
  valueSource: SettingValueSource;
  resetValueSource: Exclude<SettingValueSource, "custom">;
  isCustom: boolean;
  group: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
  min?: number;
  max?: number;
  placeholder?: string;
  templateVars?: readonly string[];
};

type Props = {
  title: string;
  subtitle: string;
  icon: string;
  entries: SettingFieldDef[];
  showTestEmailAction?: boolean;
  showTestPdfAction?: boolean;
  showTestFreeIpaAction?: boolean;
  showLegacySettings?: boolean;
  aiEnrichmentOverview?: AiEnrichmentOverview | null;
  /** Profile ids with a stored provider key. The keys themselves stay server-side. */
  aiCredentialProfileIds?: string[];
  /** Which slice of the AI settings this page shows (the AI sidebar group splits them). */
  aiSection?: "general" | "providers" | "jobs";
  showAiJobsLink?: boolean;
};

type AiProviderId = "openai" | "openrouter" | "anthropic" | "mistral" | "gemini" | "ollama" | "vllm" | "openai-compatible";
type AiDataBoundary = "hosted" | "private";
type AiLegacyDataBoundary = AiDataBoundary | "local" | "internal";

type AiModelProfileDraft = {
  id: string;
  label: string;
  provider: AiProviderId;
  model: string;
  enabled: boolean;
  capabilities: string[];
  dataBoundary: AiDataBoundary;
  /** Legacy profile field; accepted for existing JSON but no longer written. */
  dataPolicy?: AiLegacyDataBoundary;
  /** Legacy/advanced profile field; accepted but not edited in the normal UI. */
  tags?: string[];
  /** Small logo (data URL) shown in the admin card and the composer model picker. */
  image?: string;
  /**
   * Write-only. Set when the admin types a new key; the backend moves it into
   * ai.model_credentials and never sends one back. Whether a profile already
   * has a key comes from `credentialProfileIds`, not from here.
   */
  apiKey?: string;
  baseURL?: string;
  contextWindow?: number;
  temperature?: number;
  maxOutputTokens?: number;
  maxLoadedTools?: number;
  maxToolRounds?: number;
  creditsPerInputToken?: number;
  creditsPerOutputToken?: number;
} & Record<string, unknown>;

const AI_PROFILE_SETTING_KEY = "ai.model_profiles_json";
const AI_DEFAULT_MODEL_SETTING_KEY = "ai.default_model_id";
const AI_ENABLED_SETTING_KEY = "ai.enabled";
const AI_GLOBAL_INSTRUCTIONS_SETTING_KEY = "ai.global_instructions";
const AI_COMPACTION_INSTRUCTIONS_SETTING_KEY = "ai.compaction_instructions";
const AI_CHAT_ENRICHMENT_INSTRUCTIONS_SETTING_KEY = "ai.chat_enrichment_instructions";
const AI_MEMORY_LEARNING_INSTRUCTIONS_SETTING_KEY = "ai.memory_learning_instructions";
const AI_MAX_TOOL_RESULT_CHARS_SETTING_KEY = "ai.max_tool_result_chars";
const AI_FIRECRAWL_API_KEY_SETTING_KEY = "ai.firecrawl_api_key";
const AI_BACKGROUND_MODEL_SETTING_KEY = "ai.background_model_id";
const AI_VISION_MODEL_SETTING_KEY = "ai.vision_model_id";
const AI_WORKFLOW_MODEL_SETTING_KEY = "ai.workflow_model_id";
const AI_ENRICH_CRON_SETTING_KEY = "ai.enrich_cron";
const AI_MEMORY_LEARNING_CRON_SETTING_KEY = "ai.memory_learning_cron";

const AI_SETTINGS_HANDLED_BY_PANEL = new Set<string>([
  AI_ENABLED_SETTING_KEY,
  AI_DEFAULT_MODEL_SETTING_KEY,
  AI_PROFILE_SETTING_KEY,
  AI_GLOBAL_INSTRUCTIONS_SETTING_KEY,
  AI_COMPACTION_INSTRUCTIONS_SETTING_KEY,
  AI_CHAT_ENRICHMENT_INSTRUCTIONS_SETTING_KEY,
  AI_MEMORY_LEARNING_INSTRUCTIONS_SETTING_KEY,
  AI_MAX_TOOL_RESULT_CHARS_SETTING_KEY,
  AI_FIRECRAWL_API_KEY_SETTING_KEY,
  AI_BACKGROUND_MODEL_SETTING_KEY,
  AI_VISION_MODEL_SETTING_KEY,
  AI_WORKFLOW_MODEL_SETTING_KEY,
  AI_ENRICH_CRON_SETTING_KEY,
  AI_MEMORY_LEARNING_CRON_SETTING_KEY,
]);

const AI_PROVIDER_OPTIONS: ReadonlyArray<{
  id: AiProviderId;
  label: string;
  description: string;
  defaultModel: string;
  defaultBaseURL?: string;
}> = [
  { id: "openrouter", label: "OpenRouter", description: "Hosted gateway for many public models.", defaultModel: "openai/gpt-4.1-mini" },
  { id: "openai", label: "OpenAI", description: "Hosted OpenAI models.", defaultModel: "gpt-4.1-mini" },
  { id: "anthropic", label: "Anthropic", description: "Hosted Claude models.", defaultModel: "claude-3-5-sonnet-latest" },
  { id: "mistral", label: "Mistral", description: "Hosted Mistral models.", defaultModel: "mistral-large-latest" },
  { id: "gemini", label: "Gemini", description: "Hosted Google Gemini models.", defaultModel: "gemini-1.5-pro" },
  {
    id: "ollama",
    label: "Ollama",
    description: "Ollama server you operate.",
    defaultModel: "llama3.1",
    defaultBaseURL: "http://localhost:11434",
  },
  { id: "vllm", label: "vLLM", description: "vLLM OpenAI-compatible server you operate.", defaultModel: "llama3.1" },
  {
    id: "openai-compatible",
    label: "Custom OpenAI-compatible",
    description: "Any OpenAI-compatible chat completions endpoint.",
    defaultModel: "llama3.1",
    defaultBaseURL: "http://localhost:11434/v1",
  },
];

const AI_MODEL_CAPABILITY_OPTIONS = [
  { id: "streaming", label: "Streaming", description: "Can stream output tokens to the UI." },
  { id: "tools", label: "Tools", description: "Can call registered backend tools." },
  { id: "vision", label: "Vision", description: "Can accept image input." },
] as const;
type AiModelCapability = (typeof AI_MODEL_CAPABILITY_OPTIONS)[number]["id"];

const AI_DATA_BOUNDARY_OPTIONS = [
  { id: "hosted", label: "Hosted provider", description: "Requests leave the workspace for a hosted model API." },
  { id: "private", label: "Private endpoint", description: "Requests stay on infrastructure you control." },
] as const;

export default function CoreSettingsForm(props: Props) {
  const [drafts, setDrafts] = createSignal<Record<string, unknown>>({});
  const [resetKeys, setResetKeys] = createSignal<Record<string, true>>({});
  const [fieldErrors, setFieldErrors] = createSignal<Record<string, string>>({});

  const entryMap = createMemo(() => {
    const m: Record<string, SettingFieldDef> = {};
    for (const e of props.entries) m[e.key] = e;
    return m;
  });

  const initialMap = createMemo(() => {
    const m: Record<string, unknown> = {};
    for (const e of props.entries) m[e.key] = e.value;
    return m;
  });

  const valueOf = (key: string): unknown => {
    const d = drafts();
    return key in d ? d[key] : initialMap()[key];
  };

  const clearFieldError = (key: string) => {
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  const setDraft = (key: string, value: unknown) => {
    setDrafts((prev) => ({ ...prev, [key]: value }));
    setResetKeys((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _, ...rest } = prev;
      return rest;
    });
    clearFieldError(key);
  };

  const stageDefault = (entry: SettingFieldDef) => {
    setDrafts((prev) => ({ ...prev, [entry.key]: entry.resetValue }));
    setResetKeys((prev) => ({ ...prev, [entry.key]: true }));
    clearFieldError(entry.key);
  };

  const resetKeyList = createMemo(() => Object.keys(resetKeys()));
  const isResetPending = (key: string) => key in resetKeys();

  const isFieldChanged = (entry: SettingFieldDef) =>
    isResetPending(entry.key) || !sameSettingValue(valueOf(entry.key), initialMap()[entry.key]);

  const hasEffectiveDefaultAction = (entry: SettingFieldDef) =>
    entry.isCustom || !sameSettingValue(valueOf(entry.key), entry.resetValue) || !sameSettingValue(entry.value, entry.resetValue);

  const canStageDefault = (entry: SettingFieldDef) => !isResetPending(entry.key) && hasEffectiveDefaultAction(entry);

  const visibleChangedKeys = createMemo(() => {
    const init = initialMap();
    const keys = new Set<string>(resetKeyList());
    for (const k of Object.keys(drafts())) {
      if (!sameSettingValue(drafts()[k], init[k])) keys.add(k);
    }
    return [...keys].filter((key) => Boolean(entryMap()[key]));
  });

  const changedKeys = createMemo(() => {
    return visibleChangedKeys();
  });

  const hasChanges = () => changedKeys().length > 0;
  const isAiSettings = () => props.entries.some((entry) => entry.key === AI_PROFILE_SETTING_KEY);
  const genericEntries = () =>
    isAiSettings() ? props.entries.filter((entry) => !AI_SETTINGS_HANDLED_BY_PANEL.has(entry.key)) : props.entries;

  const renderFieldRows = (entries: SettingFieldDef[]) =>
    entries.map((entry) => (
      <FieldRow
        entry={entry}
        value={() => valueOf(entry.key)}
        error={() => fieldErrors()[entry.key]}
        changed={() => isFieldChanged(entry)}
        resetPending={() => isResetPending(entry.key)}
        canUseDefault={() => canStageDefault(entry)}
        onChange={(v) => setDraft(entry.key, v)}
        onUseDefault={() => stageDefault(entry)}
      />
    ));

  const discardAll = () => {
    setDrafts({});
    setResetKeys({});
    setFieldErrors({});
  };

  if (typeof window !== "undefined") {
    window.onbeforeunload = () => (hasChanges() ? "" : null);
  }

  const save = mutations.create<void, void>({
    mutation: async () => {
      const resets = resetKeyList().filter((key) => changedKeys().includes(key));
      const updates: Record<string, unknown> = {};
      for (const k of changedKeys()) {
        if (!resets.includes(k)) updates[k] = drafts()[k];
      }

      const response = await coreClient.admin.core.settings.$put({
        json: resets.length > 0 ? { updates, resets } : updates,
      });

      if (!response.ok) {
        const { message, fields } = await readSettingsError(response, `Save failed (HTTP ${response.status})`);
        setFieldErrors(fields);
        throw new Error(message);
      }
    },
    onSuccess: () => {
      window.onbeforeunload = null;
      window.location.reload();
    },
    onError: (e) => prompts.error(e.message),
  });

  const openTestEmailDialog = () => {
    void prompts.dialog<void>((close) => <TestEmailDialog close={close} />, {
      title: "Send test email",
      icon: "ti ti-mail-check",
    });
  };

  const testPdf = mutations.create<{ bytes: number; contentType: string }, void>({
    mutation: async () => {
      const response = await coreClient.admin.core.settings["test-pdf"].$post();
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          body && typeof body === "object" && "message" in body && typeof body.message === "string"
            ? body.message
            : `Failed to test PDF rendering (HTTP ${response.status})`;
        throw new Error(message);
      }
      return body as { bytes: number; contentType: string };
    },
    onSuccess: (result) => {
      void prompts.dialog<void>(
        (close) => (
          <div class="flex flex-col gap-4">
            <p class="text-sm text-secondary">
              Gotenberg returned a {formatBytes(result.bytes)} {result.contentType} response.
            </p>
            <div class="flex justify-end">
              <Button type="button" size="sm" onClick={() => close()}>
                Close
              </Button>
            </div>
          </div>
        ),
        { title: "PDF renderer is reachable", icon: "ti ti-check" },
      );
    },
    onError: (e) => prompts.error(e.message),
  });

  const testFreeIpa = mutations.create<void, void>({
    mutation: async () => {
      const response = await coreClient.admin.core.settings["test-freeipa"].$post();
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          body && typeof body === "object" && "message" in body && typeof body.message === "string"
            ? body.message
            : `Failed to test FreeIPA (HTTP ${response.status})`;
        throw new Error(message);
      }
    },
    onSuccess: () => toast.success("FreeIPA is reachable and the service account is valid."),
    onError: (e) => prompts.error(e.message),
  });

  const headerActions = () => (
    <>
      <Show when={props.showTestEmailAction}>
        <Tooltip.Anchor
          content={hasChanges() ? "Save pending changes before sending a test email" : "Send a test email with the saved SMTP settings"}
        >
          <Button type="button" variant="secondary" size="sm" class="justify-center" onClick={openTestEmailDialog} disabled={hasChanges()}>
            <i class="ti ti-send" /> Test email
          </Button>
        </Tooltip.Anchor>
      </Show>

      <Show when={props.showTestPdfAction}>
        <Tooltip.Anchor
          content={hasChanges() ? "Save pending changes before testing Gotenberg" : "Render a test PDF with the saved settings"}
        >
          <Button
            type="button"
            variant="secondary"
            size="sm"
            class="justify-center"
            onClick={() => testPdf.mutate()}
            loading={testPdf.loading()}
            loadingLabel="Testing renderer"
            disabled={hasChanges()}
          >
            <i class={testPdf.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-file-type-pdf"} /> Test renderer
          </Button>
        </Tooltip.Anchor>
      </Show>

      <Show when={props.showTestFreeIpaAction}>
        <Tooltip.Anchor
          content={hasChanges() ? "Save pending changes before testing FreeIPA" : "Test TLS, service account login, and ping"}
        >
          <Button
            type="button"
            variant="secondary"
            size="sm"
            class="justify-center"
            onClick={() => testFreeIpa.mutate()}
            loading={testFreeIpa.loading()}
            loadingLabel="Testing connection"
            disabled={hasChanges()}
          >
            <i class={testFreeIpa.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-plug-connected"} /> Test connection
          </Button>
        </Tooltip.Anchor>
      </Show>
    </>
  );

  const renderFieldSections = (entries: SettingFieldDef[]) =>
    groupSettingEntries(entries).map((section) => (
      <SettingsSection title={section.title} subtitle={section.subtitle} icon={section.icon}>
        {renderFieldRows(section.entries)}
      </SettingsSection>
    ));

  return (
    <SettingsPage
      title={props.title}
      subtitle={props.subtitle}
      icon={props.icon}
      actions={props.showTestEmailAction || props.showTestPdfAction || props.showTestFreeIpaAction ? headerActions() : undefined}
      footer={
        <SettingsPanelFooter
          changeCount={() => changedKeys().length}
          loading={() => save.loading()}
          onDiscard={discardAll}
          onSave={() => save.mutate()}
          saveVariant={props.icon === "ti ti-sparkles" ? "ai" : "primary"}
        />
      }
    >
      <Show when={props.showTestEmailAction || props.showTestPdfAction || props.showTestFreeIpaAction}>
        <NoticeCard
          tone="info"
          title="Tests use saved settings"
          detail="Save or discard pending changes before running a connection or delivery test."
        />
      </Show>

      <Show
        when={isAiSettings()}
        fallback={
          <>
            {renderFieldSections(genericEntries())}
            <Show when={props.showLegacySettings}>
              <LegacySettingsSection />
            </Show>
          </>
        }
      >
        <AiSettingsPanel
          entries={props.entries}
          valueOf={valueOf}
          errorFor={(key) => fieldErrors()[key]}
          onChange={setDraft}
          enrichmentOverview={props.aiEnrichmentOverview ?? null}
          credentialProfileIds={props.aiCredentialProfileIds ?? []}
          section={props.aiSection ?? "general"}
          showJobsLink={props.showAiJobsLink}
        />
        <Show when={(props.aiSection ?? "general") === "general"}>{renderFieldSections(genericEntries())}</Show>
      </Show>
    </SettingsPage>
  );
}

type SettingSectionGroup = {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  entries: SettingFieldDef[];
};

const SECTION_DEFS: Record<string, { title: string; subtitle: string; icon: string }> = {
  "app.identity": {
    title: "Identity",
    subtitle: "Name, public URL, home path, contact details, and footer ownership.",
    icon: "ti ti-id",
  },
  "app.branding": {
    title: "Branding",
    subtitle: "Images shown in browser chrome and the Cloud shell.",
    icon: "ti ti-photo",
  },
  "app.operations": {
    title: "Operations",
    subtitle: "Timezone and schedules used by automatic platform jobs.",
    icon: "ti ti-calendar-time",
  },
  "user.login": {
    title: "Login",
    subtitle: "Session and account creation behavior.",
    icon: "ti ti-login",
  },
  "user.expiry": {
    title: "Account expiry",
    subtitle: "Default lifetimes for IPA, local user, and local guest accounts.",
    icon: "ti ti-hourglass",
  },
  "user.reminders": {
    title: "Reminders and retention",
    subtitle: "Reminder timing plus cleanup retention for account lifecycle history.",
    icon: "ti ti-bell",
  },
  "freeipa.connection": {
    title: "Connection",
    subtitle: "FreeIPA host and TLS trust configuration.",
    icon: "ti ti-server",
  },
  "freeipa.service": {
    title: "Service account",
    subtitle: "Credentials used for internal FreeIPA operations.",
    icon: "ti ti-key",
  },
  "freeipa.groups": {
    title: "Group mapping",
    subtitle: "FreeIPA groups mapped to Cloud roles and sync scope.",
    icon: "ti ti-users-group",
  },
  "freeipa.sync": {
    title: "Sync policy",
    subtitle: "Account transition behavior and scheduled synchronization.",
    icon: "ti ti-refresh",
  },
  "mail.smtp": {
    title: "SMTP delivery",
    subtitle: "Sender identity and SMTP credentials for outgoing email.",
    icon: "ti ti-mail",
  },
  "mail.templates": {
    title: "Templates",
    subtitle: "HTML bodies for transactional emails.",
    icon: "ti ti-template",
  },
  "gotenberg.connection": {
    title: "Connection",
    subtitle: "Gotenberg endpoint and optional Basic Auth credentials.",
    icon: "ti ti-server",
  },
  "gotenberg.limits": {
    title: "Limits",
    subtitle: "Timeout and size limits for PDF rendering.",
    icon: "ti ti-gauge",
  },
  "security.rate-limits": {
    title: "Rate limits",
    subtitle: "Request throttling defaults for platform APIs.",
    icon: "ti ti-shield-lock",
  },
  default: {
    title: "Settings",
    subtitle: "Registered runtime settings for this area.",
    icon: "ti ti-settings",
  },
};

const sectionIdForEntry = (entry: SettingFieldDef): string => {
  if (entry.key === "app.logo" || entry.key === "app.favicon") return "app.branding";
  if (entry.key === "app.timezone" || entry.key === "app.cleanup_schedule") return "app.operations";
  if (entry.key.startsWith("app.")) return "app.identity";

  if (entry.key === "user.allow_self_registration" || entry.key === "user.abbr_length" || entry.key === "user.session.expiry_hours") {
    return "user.login";
  }
  if (entry.key.includes("_expires_days")) return "user.expiry";
  if (entry.key.startsWith("user.account.")) return "user.reminders";

  if (entry.key.startsWith("freeipa.groups.")) return "freeipa.groups";
  if (entry.key === "freeipa.service_user" || entry.key === "freeipa.service_password") return "freeipa.service";
  if (
    entry.key === "freeipa.user_match_mode" ||
    entry.key === "freeipa.account_transition_policy" ||
    entry.key === "freeipa.sync_cron" ||
    entry.key.startsWith("freeipa.sync_guard.")
  ) {
    return "freeipa.sync";
  }
  if (entry.key.startsWith("freeipa.")) return "freeipa.connection";

  if (entry.kind === "template") return "mail.templates";
  if (entry.key.startsWith("mail.")) return "mail.smtp";

  if (entry.key.startsWith("gotenberg.max_") || entry.key === "gotenberg.timeout_ms") return "gotenberg.limits";
  if (entry.key.startsWith("gotenberg.")) return "gotenberg.connection";

  if (entry.key.startsWith("security.")) return "security.rate-limits";
  return "default";
};

const groupSettingEntries = (entries: SettingFieldDef[]): SettingSectionGroup[] => {
  const sections = new Map<string, SettingSectionGroup>();
  for (const entry of entries) {
    const id = sectionIdForEntry(entry);
    const def = SECTION_DEFS[id] ?? SECTION_DEFS.default!;
    if (!sections.has(id)) sections.set(id, { id, ...def, entries: [] });
    sections.get(id)!.entries.push(entry);
  }
  return [...sections.values()];
};

const sourceLabel = (source: SettingValueSource) => {
  if (source === "custom") return "Custom override";
  if (source === "env") return "Environment fallback";
  return "Code default";
};

const formatSettingPreview = (entry: SettingFieldDef, value: unknown): string => {
  if (entry.kind === "secret") return entry.resetValueSource === "env" ? "Environment fallback (hidden)" : "Empty secret";
  if (entry.kind === "boolean") return value ? "Enabled" : "Disabled";
  if (entry.kind === "image") return typeof value === "string" && value ? "Image configured" : "No image";
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "Empty list";
  if (value === "" || value === null || value === undefined) return "Empty";

  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "Empty";
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
};

function TestEmailDialog(props: { close: () => void }) {
  const [recipient, setRecipient] = createSignal("");

  const send = mutations.create<void, void>({
    mutation: async () => {
      const email = recipient().trim();
      if (!email) throw new Error("Enter a recipient email address.");

      const response = await coreClient.admin.core.settings["test-email"].$post({ json: { recipient: email } });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const message =
          body && typeof body === "object" && "message" in body && typeof body.message === "string"
            ? body.message
            : `Failed to send test email (HTTP ${response.status})`;
        throw new Error(message);
      }
    },
    onSuccess: () => {
      props.close();
      void prompts.dialog<void>(
        (close) => (
          <div class="flex flex-col gap-4">
            <p class="text-sm text-secondary">The test email was handed to the configured SMTP server.</p>
            <div class="flex justify-end">
              <Button type="button" size="sm" onClick={() => close()}>
                Close
              </Button>
            </div>
          </div>
        ),
        { title: "Test email sent", icon: "ti ti-check" },
      );
    },
    onError: (e) => prompts.error(e.message),
  });

  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        send.mutate();
      }}
    >
      <TextInput
        label="Recipient email"
        description="The test message is sent only to this address."
        type="email"
        required
        value={recipient}
        onValueChange={setRecipient}
        placeholder="you@example.org"
      />

      <div class="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={props.close} disabled={send.loading()}>
          Cancel
        </Button>
        <Button type="submit" size="sm" loading={send.loading()} loadingLabel="Sending">
          <i class={send.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-send"} /> Send
        </Button>
      </div>
    </form>
  );
}

const providerOption = (provider: AiProviderId) => AI_PROVIDER_OPTIONS.find((option) => option.id === provider) ?? AI_PROVIDER_OPTIONS[0]!;
const dataBoundaryOption = (boundary: AiDataBoundary) =>
  AI_DATA_BOUNDARY_OPTIONS.find((option) => option.id === boundary) ?? AI_DATA_BOUNDARY_OPTIONS[0]!;
const defaultDataBoundary = (provider: AiProviderId): AiDataBoundary =>
  provider === "ollama" || provider === "vllm" || provider === "openai-compatible" ? "private" : "hosted";
const providerRequiresProfileKey = (provider: AiProviderId): boolean =>
  provider === "openai" || provider === "openrouter" || provider === "anthropic" || provider === "mistral" || provider === "gemini";
const providerSupportsProfileKey = (provider: AiProviderId): boolean =>
  providerRequiresProfileKey(provider) || provider === "openai-compatible" || provider === "vllm";
const asString = (value: unknown) => (typeof value === "string" ? value : "");
const normalizeStringList = (value: unknown, fallback: string[]) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : fallback;
const isDataBoundaryInput = (value: unknown): value is AiLegacyDataBoundary =>
  value === "hosted" || value === "private" || value === "local" || value === "internal";
const normalizeDataBoundary = (value: unknown, provider: AiProviderId): AiDataBoundary => {
  if (value === "hosted") return "hosted";
  if (value === "private" || value === "local" || value === "internal") return "private";
  return defaultDataBoundary(provider);
};
const isModelCapability = (value: string): value is AiModelCapability => AI_MODEL_CAPABILITY_OPTIONS.some((option) => option.id === value);
const normalizeCapabilities = (value: unknown): AiModelCapability[] => [
  ...new Set(normalizeStringList(value, ["streaming"]).filter(isModelCapability)),
];

const slugifyProfileId = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "model";

const uniqueProfileId = (base: string, profiles: AiModelProfileDraft[], currentId?: string) => {
  const root = slugifyProfileId(base);
  const used = new Set(profiles.map((profile) => profile.id).filter((id) => id !== currentId));
  if (!used.has(root)) return root;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${root}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${root}-${Date.now()}`;
};

const isProviderId = (value: unknown): value is AiProviderId =>
  typeof value === "string" && AI_PROVIDER_OPTIONS.some((option) => option.id === value);

const normalizeAiProfile = (value: unknown): AiModelProfileDraft | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.trim()) return null;
  if (!isProviderId(raw.provider)) return null;
  if (typeof raw.model !== "string" || !raw.model.trim()) return null;

  const provider = raw.provider;
  return {
    ...raw,
    id: raw.id.trim(),
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : raw.id.trim(),
    provider,
    model: raw.model.trim(),
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    capabilities: normalizeCapabilities(raw.capabilities),
    dataBoundary: isDataBoundaryInput(raw.dataBoundary)
      ? normalizeDataBoundary(raw.dataBoundary, provider)
      : normalizeDataBoundary(raw.dataPolicy, provider),
    apiKey: typeof raw.apiKey === "string" && raw.apiKey.trim() ? raw.apiKey.trim() : undefined,
    baseURL: typeof raw.baseURL === "string" && raw.baseURL.trim() ? raw.baseURL.trim() : undefined,
    contextWindow:
      typeof raw.contextWindow === "number" && Number.isInteger(raw.contextWindow) && raw.contextWindow > 0 ? raw.contextWindow : undefined,
    temperature: typeof raw.temperature === "number" ? raw.temperature : undefined,
    maxOutputTokens:
      typeof raw.maxOutputTokens === "number" && Number.isInteger(raw.maxOutputTokens) && raw.maxOutputTokens > 0
        ? raw.maxOutputTokens
        : undefined,
    maxLoadedTools: typeof raw.maxLoadedTools === "number" && Number.isInteger(raw.maxLoadedTools) ? raw.maxLoadedTools : undefined,
    maxToolRounds: typeof raw.maxToolRounds === "number" && Number.isInteger(raw.maxToolRounds) ? raw.maxToolRounds : undefined,
    creditsPerInputToken: typeof raw.creditsPerInputToken === "number" ? raw.creditsPerInputToken : undefined,
    creditsPerOutputToken: typeof raw.creditsPerOutputToken === "number" ? raw.creditsPerOutputToken : undefined,
  };
};

const parseAiProfiles = (rawJson: unknown): { profiles: AiModelProfileDraft[]; error?: string } => {
  const raw = asString(rawJson).trim();
  if (!raw) return { profiles: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { profiles: [], error: error instanceof Error ? error.message : "Model profiles must be valid JSON." };
  }

  if (!Array.isArray(parsed)) return { profiles: [], error: "Model profiles must be a JSON array." };

  const profiles = parsed.map(normalizeAiProfile);
  if (profiles.some((profile) => !profile)) {
    return { profiles: [], error: "Every model profile needs at least id, provider, and model." };
  }

  return { profiles: profiles as AiModelProfileDraft[] };
};

const serializeAiProfiles = (profiles: AiModelProfileDraft[]) =>
  JSON.stringify(
    profiles.map(({ dataPolicy: _legacyDataPolicy, tags: _legacyTags, apiKey, ...profile }) => ({
      ...profile,
      ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
    })),
    null,
    2,
  );

const formatAiDuration = (ms: number | null): string => {
  if (ms === null) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.round(ms / 60_000)}m`;
};

const formatAiDate = (value: string | null): string => (value ? new Date(value).toLocaleString() : "-");

const formatAiPercent = (value: number): string => `${value.toFixed(value >= 10 ? 0 : 1)}%`;

function AiEnrichmentOverviewPanel(props: { overview: AiEnrichmentOverview; showJobsLink?: boolean }) {
  const statusClass = (status: string) => (status === "ok" ? "badge-success" : status === "failed" ? "badge-danger" : "badge-neutral");
  return (
    <div class="flex flex-col gap-2">
      <StatGrid columns={4} size="sm" surface="muted">
        <StatCell
          label="Dirty chats"
          value={props.overview.dirtyConversations}
          sub={`Oldest ${formatAiDate(props.overview.oldestDirtyAt)}`}
        />
        <StatCell
          label="Failed chats"
          value={props.overview.failedConversations}
          sub={`${props.overview.totalConversations} active total`}
        />
        <StatCell
          label="Error rate 24h"
          value={formatAiPercent(props.overview.errorRate24h)}
          sub={`${props.overview.failedRuns24h} / ${props.overview.totalRuns24h} failed`}
          accent={props.overview.failedRuns24h > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
        />
        <StatCell
          label="Avg runtime"
          value={formatAiDuration(props.overview.avgDurationMs)}
          sub={`Last run ${formatAiDate(props.overview.lastRunAt)}`}
        />
      </StatGrid>

      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs text-dimmed">Runtime traces live on the generic jobs page; a manual run enriches up to 25 dirty chats.</p>
        <div class="flex items-center gap-2">
          <RunEnrichmentButton />
          <Show when={props.showJobsLink}>
            <ButtonLink href="/admin/observability/jobs?search=ai%3Achat" variant="ai" size="sm">
              <i class="ti ti-external-link" /> Open jobs
            </ButtonLink>
          </Show>
        </div>
      </div>

      <Show when={props.overview.recentRuns.length > 0}>
        <div class="flex flex-col gap-1 rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-subtle)] p-2">
          {props.overview.recentRuns.map((run) => (
            <div class="grid grid-cols-[auto_1fr_auto] items-center gap-2 px-2 py-1.5 text-xs">
              <span class={`badge ${statusClass(run.status)}`}>{run.status}</span>
              <span class="min-w-0">
                <span class="block truncate text-primary">{run.conversationTitle || run.conversationId}</span>
                <span class="block truncate text-[11px] text-dimmed">
                  {run.trigger} · {formatAiDate(run.createdAt)}
                </span>
              </span>
              <span class="whitespace-nowrap text-[11px] text-dimmed">{formatAiDuration(run.durationMs)}</span>
            </div>
          ))}
        </div>
      </Show>
    </div>
  );
}

function RunEnrichmentButton() {
  const [running, setRunning] = createSignal(false);
  const run = async () => {
    setRunning(true);
    try {
      const response = await fetch("/api/admin/core/settings/run-ai-enrichment", { method: "POST" });
      const body = (await response.json().catch(() => null)) as {
        ok?: boolean;
        message?: string;
        summary?: { scanned: number; enriched: number; failed: number };
      } | null;
      if (!response.ok || !body?.ok) throw new Error(body?.message ?? "AI enrichment run failed");
      const summary = body.summary;
      toast.success(
        summary
          ? `Enrichment done: ${summary.enriched} enriched, ${summary.failed} failed (${summary.scanned} scanned).`
          : "Enrichment done.",
      );
      // The overview numbers are server-rendered — reload to reflect the run.
      window.location.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "AI enrichment run failed");
    } finally {
      setRunning(false);
    }
  };
  return (
    <Button type="button" variant="secondary" size="sm" loading={running()} loadingLabel="Running" onClick={() => void run()}>
      <i class={running() ? "ti ti-loader-2 animate-spin" : "ti ti-player-play"} aria-hidden="true" />
      Run now
    </Button>
  );
}

function AiSettingsPanel(props: {
  entries: SettingFieldDef[];
  valueOf: (key: string) => unknown;
  errorFor: (key: string) => string | undefined;
  onChange: (key: string, value: unknown) => void;
  enrichmentOverview: AiEnrichmentOverview | null;
  credentialProfileIds: string[];
  section: "general" | "providers" | "jobs";
  showJobsLink?: boolean;
}) {
  const entry = (key: string) => props.entries.find((item) => item.key === key);
  // Secret values are redacted server-side; valueSource tells whether a stored/env key exists.
  const firecrawlKeyConfigured = () => (entry(AI_FIRECRAWL_API_KEY_SETTING_KEY)?.valueSource ?? "default") !== "default";
  const profilesState = createMemo(() => parseAiProfiles(props.valueOf(AI_PROFILE_SETTING_KEY)));
  // A key typed in this session counts as configured before the save lands.
  const hasCredential = (profile: AiModelProfileDraft) =>
    Boolean(profile.apiKey?.trim()) || props.credentialProfileIds.includes(profile.id);
  const profiles = () => profilesState().profiles;
  const defaultModelId = () => asString(props.valueOf(AI_DEFAULT_MODEL_SETTING_KEY));
  const maxToolResultChars = () => {
    const value = Number(props.valueOf(AI_MAX_TOOL_RESULT_CHARS_SETTING_KEY));
    return Number.isFinite(value) && value > 0 ? value : 8000;
  };

  const setProfiles = (next: AiModelProfileDraft[]) => props.onChange(AI_PROFILE_SETTING_KEY, serializeAiProfiles(next));

  const setDefaultModel = (id: string) => props.onChange(AI_DEFAULT_MODEL_SETTING_KEY, id);
  const firstEnabledProfileId = (items: AiModelProfileDraft[]) => items.find((item) => item.enabled)?.id ?? "";

  const addProvider = async () => {
    const result = await openAiProfileDialog({ profiles: profiles() });
    if (!result) return;

    const nextProfiles = [...profiles(), result];
    setProfiles(nextProfiles);
    if (!nextProfiles.some((profile) => profile.id === defaultModelId())) setDefaultModel(firstEnabledProfileId(nextProfiles));
  };

  const editProfile = async (profile: AiModelProfileDraft) => {
    const result = await openAiProfileDialog({ profiles: profiles(), profile, hasCredential: hasCredential(profile) });
    if (!result) return;

    const nextProfiles = profiles().map((item) => (item.id === profile.id ? result : item));
    setProfiles(nextProfiles);
    if (profile.id === defaultModelId() && result.id !== profile.id) setDefaultModel(result.id);
    if (profile.id === defaultModelId() && !result.enabled) setDefaultModel(firstEnabledProfileId(nextProfiles));
  };

  const duplicateProfile = (profile: AiModelProfileDraft) => {
    const id = uniqueProfileId(`${profile.id}-copy`, profiles());
    // The copy keeps the enabled state — a duplicate that silently turns
    // itself off reads as a bug, not a safety feature.
    setProfiles([...profiles(), { ...profile, id, label: `${profile.label} Copy` }]);
  };

  const removeProfile = async (profile: AiModelProfileDraft) => {
    const confirmed = await prompts.confirm(`Remove AI model profile "${profile.label}"?`, {
      title: "Remove AI profile",
      icon: "ti ti-trash",
      variant: "danger",
      confirmText: "Remove",
    });
    if (!confirmed) return;

    const nextProfiles = profiles().filter((item) => item.id !== profile.id);
    setProfiles(nextProfiles);
    if (defaultModelId() === profile.id) setDefaultModel(firstEnabledProfileId(nextProfiles));
  };

  const importJson = async () => {
    const current = asString(props.valueOf(AI_PROFILE_SETTING_KEY));
    const result = await prompts.dialog<string>(
      (close) => {
        const [draft, setDraft] = createSignal(current);
        const [error, setError] = createSignal<string | undefined>();

        const submit = () => {
          const parsed = parseAiProfiles(draft());
          if (parsed.error) {
            setError(parsed.error);
            return;
          }
          close(serializeAiProfiles(parsed.profiles));
        };

        return (
          <form
            class="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <TextInput
              multiline
              lines={12}
              label="Model profiles JSON"
              description="Use this only for bulk import or hand-editing advanced profile fields."
              value={draft}
              onValueChange={setDraft}
              error={error}
              monospace
            />
            <div class="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => close(undefined)}>
                Cancel
              </Button>
              <Button type="submit" size="sm">
                <i class="ti ti-upload" /> Import
              </Button>
            </div>
          </form>
        );
      },
      { title: "Import model profiles", icon: "ti ti-file-import", size: "wide" },
    );

    if (typeof result !== "string") return;
    const parsed = parseAiProfiles(result);
    if (parsed.error) {
      prompts.error(parsed.error);
      return;
    }
    // Merge-by-id: exports never contain API keys — an import must not wipe
    // the keys of profiles that already exist under the same id.
    // No merging here any more: keys live server-side, and a profile that keeps
    // its id keeps its key because the import sends none.
    setProfiles(parsed.profiles);
  };

  /** Download all profiles as JSON — API keys are never exported. */
  const exportJson = () => {
    const sanitized = profiles().map(({ apiKey: _apiKey, ...profile }) => profile);
    const blob = new Blob([JSON.stringify(sanitized, null, 2)], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = "ai-model-profiles.json";
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  };

  return (
    <div class="flex flex-col gap-2">
      <Show when={props.section === "general"}>
        <SettingsSection title="Cloud AI" subtitle="Global switch, default model, and workspace-wide instructions." icon="ti ti-sparkles">
          <div class="flex flex-col gap-2">
            <Switch
              label={props.valueOf(AI_ENABLED_SETTING_KEY) ? "AI enabled" : "AI disabled"}
              value={() => Boolean(props.valueOf(AI_ENABLED_SETTING_KEY))}
              onValueChange={(value) => props.onChange(AI_ENABLED_SETTING_KEY, value)}
            />
            <p class="text-xs text-dimmed">Controls whether Cloud AI features are available to apps and users.</p>
          </div>

          <Select
            label="Default model"
            description="Used when an app asks for the platform default model."
            value={() => defaultModelId()}
            onValueChange={(value) => value !== null && setDefaultModel(value)}
            options={profiles()
              .filter((profile) => profile.enabled || profile.id === defaultModelId())
              .map((profile) => ({
                id: profile.id,
                label: profile.enabled ? profile.label : `${profile.label} (disabled)`,
                description: `${providerOption(profile.provider).label} · ${profile.model}`,
                icon: "ti ti-sparkles",
                groups: aiModelChoiceGroups(profile),
              }))}
            groups={aiModelGroupFiltersFor(profiles().filter((profile) => profile.enabled || profile.id === defaultModelId()))}
            groupsAriaLabel="Filter models"
            placeholder={profiles().length > 0 ? "Choose default model" : "Add a provider first"}
            icon="ti ti-sparkles"
            disabled={profiles().length === 0}
            error={() => props.errorFor(AI_DEFAULT_MODEL_SETTING_KEY)}
          />

          <div class="flex flex-col gap-1.5">
            <div>
              <p class="text-sm font-medium text-primary">Global instructions</p>
              <p class="text-xs text-dimmed">
                Liquid template appended after the platform prompt in every Cloud AI conversation. Type {"{{"} for variable completions.
              </p>
            </div>
            <TemplateEditor
              value={() => asString(props.valueOf(AI_GLOBAL_INSTRUCTIONS_SETTING_KEY))}
              onValueChange={(value) => props.onChange(AI_GLOBAL_INSTRUCTIONS_SETTING_KEY, value)}
              variables={AI_PROMPT_TEMPLATE_VARIABLES}
              lines={14}
              placeholder={AI_PLATFORM_PROMPT_TEMPLATE}
            />
            <FieldError error={() => props.errorFor(AI_GLOBAL_INSTRUCTIONS_SETTING_KEY)} />
          </div>

          <details class="group">
            <summary class="flex cursor-pointer select-none items-center gap-1.5 text-xs font-medium text-secondary hover:text-primary">
              <i class="ti ti-chevron-right transition-transform group-open:rotate-90" aria-hidden="true" />
              Show the built-in platform prompt
            </summary>
            <div class="mt-2 flex flex-col gap-1.5">
              <p class="text-xs text-dimmed">
                Every conversation starts with this Liquid template, rendered per turn with the current user, time, app, available tools,
                and memory state. Your global instructions are appended directly after it.
              </p>
              <pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-2.5 font-mono text-[11px] leading-relaxed text-zinc-700 [box-shadow:var(--ui-control-recess)] dark:bg-zinc-900 dark:text-zinc-300">
                {AI_PLATFORM_PROMPT_TEMPLATE}
              </pre>
            </div>
          </details>
        </SettingsSection>

        <SettingsSection title="Context" subtitle="Limits for model context assembled during conversations." icon="ti ti-package">
          <Select
            label="Vision tool model"
            description="Used by view_image when the chat model needs help inspecting a stored image. Direct vision models still receive newly attached images themselves."
            value={() => asString(props.valueOf(AI_VISION_MODEL_SETTING_KEY))}
            onValueChange={(value) => props.onChange(AI_VISION_MODEL_SETTING_KEY, value ?? "")}
            options={[
              { id: "", label: "Disable view_image fallback", icon: "ti ti-photo-off" },
              ...profiles()
                .filter((profile) => profile.enabled && profile.capabilities.includes("vision"))
                .map((profile) => ({
                  id: profile.id,
                  label: profile.label,
                  description: `${providerOption(profile.provider).label} · ${profile.model}`,
                  icon: "ti ti-photo-spark",
                  groups: aiModelChoiceGroups(profile),
                })),
            ]}
            groups={aiModelGroupFiltersFor(profiles().filter((profile) => profile.enabled && profile.capabilities.includes("vision")))}
            groupsAriaLabel="Filter vision models"
            icon="ti ti-photo-spark"
            error={() => props.errorFor(AI_VISION_MODEL_SETTING_KEY)}
          />
          <NumberInput
            label="Tool result ceiling"
            description="Maximum characters allowed for one tool result. The runtime automatically uses less for models with smaller context windows."
            value={maxToolResultChars}
            onValueChange={(value) => props.onChange(AI_MAX_TOOL_RESULT_CHARS_SETTING_KEY, value ?? 2000000)}
            min={500}
            max={4000000}
            showSteppers={false}
            error={() => props.errorFor(AI_MAX_TOOL_RESULT_CHARS_SETTING_KEY)}
          />
        </SettingsSection>
      </Show>

      <Show when={props.section === "jobs"}>
        <SettingsSection
          title="Background jobs"
          subtitle="One model, task guidance, and schedules for chat enrichment, personalization learning, and compaction."
          icon="ti ti-clock-bolt"
        >
          <Select
            label="Background model"
            description="Model used for background AI jobs. Falls back to the default model when unset."
            value={() => asString(props.valueOf(AI_BACKGROUND_MODEL_SETTING_KEY))}
            onValueChange={(value) => props.onChange(AI_BACKGROUND_MODEL_SETTING_KEY, value ?? "")}
            options={[
              { id: "", label: "Use default model", icon: "ti ti-sparkles" },
              ...profiles()
                .filter((profile) => profile.enabled)
                .map((profile) => ({
                  id: profile.id,
                  label: profile.label,
                  description: `${providerOption(profile.provider).label} · ${profile.model}`,
                  icon: "ti ti-sparkles",
                  groups: aiModelChoiceGroups(profile),
                })),
            ]}
            groups={aiModelGroupFiltersFor(profiles().filter((profile) => profile.enabled))}
            groupsAriaLabel="Filter background models"
            icon="ti ti-clock-bolt"
            error={() => props.errorFor(AI_BACKGROUND_MODEL_SETTING_KEY)}
          />

          <Select
            label="Workflow model"
            description="Model used for AI workflow actions. Falls back to the background model when unset."
            value={() => asString(props.valueOf(AI_WORKFLOW_MODEL_SETTING_KEY))}
            onValueChange={(value) => props.onChange(AI_WORKFLOW_MODEL_SETTING_KEY, value ?? "")}
            options={[
              { id: "", label: "Use background model", icon: "ti ti-sparkles" },
              ...profiles()
                .filter((profile) => profile.enabled)
                .map((profile) => ({
                  id: profile.id,
                  label: profile.label,
                  description: `${providerOption(profile.provider).label} · ${profile.model}`,
                  icon: "ti ti-sparkles",
                  groups: aiModelChoiceGroups(profile),
                })),
            ]}
            groups={aiModelGroupFiltersFor(profiles().filter((profile) => profile.enabled))}
            groupsAriaLabel="Filter workflow models"
            icon="ti ti-route"
            error={() => props.errorFor(AI_WORKFLOW_MODEL_SETTING_KEY)}
          />

          <TextInput
            label="Chat enrichment schedule"
            description="Cron for the job that summarizes changed chats and refreshes keywords and titles for search."
            value={() => asString(props.valueOf(AI_ENRICH_CRON_SETTING_KEY))}
            onValueChange={(value) => props.onChange(AI_ENRICH_CRON_SETTING_KEY, value)}
            placeholder="*/10 * * * *"
            monospace
            error={() => props.errorFor(AI_ENRICH_CRON_SETTING_KEY)}
          />

          <TextInput
            variant="ai"
            multiline
            lines={4}
            label="Chat enrichment instructions"
            description="Optional organization guidance added between Cloud's fixed task and fixed output contract."
            value={() => asString(props.valueOf(AI_CHAT_ENRICHMENT_INSTRUCTIONS_SETTING_KEY))}
            onValueChange={(value) => props.onChange(AI_CHAT_ENRICHMENT_INSTRUCTIONS_SETTING_KEY, value)}
            placeholder={entry(AI_CHAT_ENRICHMENT_INSTRUCTIONS_SETTING_KEY)?.placeholder}
            error={() => props.errorFor(AI_CHAT_ENRICHMENT_INSTRUCTIONS_SETTING_KEY)}
          />

          <TextInput
            label="Personalization learning schedule"
            description="Cron for checking eligible private chats for durable personal facts and preferences."
            value={() => asString(props.valueOf(AI_MEMORY_LEARNING_CRON_SETTING_KEY))}
            onValueChange={(value) => props.onChange(AI_MEMORY_LEARNING_CRON_SETTING_KEY, value)}
            placeholder="*/10 * * * *"
            monospace
            error={() => props.errorFor(AI_MEMORY_LEARNING_CRON_SETTING_KEY)}
          />

          <TextInput
            variant="ai"
            multiline
            lines={4}
            label="Personalization learning instructions"
            description="Optional organization guidance added without weakening Cloud's fixed privacy and output contract."
            value={() => asString(props.valueOf(AI_MEMORY_LEARNING_INSTRUCTIONS_SETTING_KEY))}
            onValueChange={(value) => props.onChange(AI_MEMORY_LEARNING_INSTRUCTIONS_SETTING_KEY, value)}
            placeholder={entry(AI_MEMORY_LEARNING_INSTRUCTIONS_SETTING_KEY)?.placeholder}
            error={() => props.errorFor(AI_MEMORY_LEARNING_INSTRUCTIONS_SETTING_KEY)}
          />

          <TextInput
            variant="ai"
            multiline
            lines={4}
            label="Compaction instructions"
            description="Optional organization guidance added without replacing Cloud's structured handoff and completeness contract."
            value={() => asString(props.valueOf(AI_COMPACTION_INSTRUCTIONS_SETTING_KEY))}
            onValueChange={(value) => props.onChange(AI_COMPACTION_INSTRUCTIONS_SETTING_KEY, value)}
            placeholder={entry(AI_COMPACTION_INSTRUCTIONS_SETTING_KEY)?.placeholder}
            error={() => props.errorFor(AI_COMPACTION_INSTRUCTIONS_SETTING_KEY)}
          />

          <Show when={props.enrichmentOverview}>
            {(overview) => <AiEnrichmentOverviewPanel overview={overview()} showJobsLink={props.showJobsLink} />}
          </Show>
        </SettingsSection>
      </Show>

      <Show when={props.section === "general"}>
        <SettingsSection title="Web tools" subtitle="Firecrawl-backed search and page extraction for AI tools." icon="ti ti-world-search">
          <TextInput
            variant="ai"
            label="Firecrawl API key"
            description={
              firecrawlKeyConfigured()
                ? "A key is configured (stored encrypted, never sent to the browser). Leave empty to keep it; type a new key to replace it."
                : "Enables the default web_search and web_extract tools. The key is stored encrypted and never sent to the browser after save."
            }
            value={() => asString(props.valueOf(AI_FIRECRAWL_API_KEY_SETTING_KEY))}
            onValueChange={(value) => props.onChange(AI_FIRECRAWL_API_KEY_SETTING_KEY, value)}
            placeholder={
              firecrawlKeyConfigured()
                ? "Leave empty to keep current key"
                : (entry(AI_FIRECRAWL_API_KEY_SETTING_KEY)?.placeholder ?? "fc-...")
            }
            password
            error={() => props.errorFor(AI_FIRECRAWL_API_KEY_SETTING_KEY)}
          />
        </SettingsSection>
      </Show>

      <Show when={props.section === "providers"}>
        <DataTable.Panel>
          <DataTable.Header title="Model profiles" subtitle="Models, credentials, capabilities, and endpoint policy.">
            <div class="flex flex-wrap items-center justify-end gap-2">
              <Tooltip.Anchor content="API keys are never exported">
                <Button type="button" variant="secondary" size="sm" onClick={exportJson}>
                  <i class="ti ti-file-export" /> Export JSON
                </Button>
              </Tooltip.Anchor>
              <Button type="button" variant="secondary" size="sm" onClick={() => void importJson()}>
                <i class="ti ti-file-import" /> Import JSON
              </Button>
              <Button type="button" variant="ai" size="sm" onClick={() => void addProvider()}>
                <i class="ti ti-plus" /> Add provider
              </Button>
            </div>
          </DataTable.Header>
          <Show
            when={!profilesState().error && profiles().length > 0}
            fallback={
              <NoticeCard
                class="m-3"
                tone={profilesState().error ? "danger" : "info"}
                title={profilesState().error ? "Model profiles need attention" : "No providers configured"}
                detail={profilesState().error ?? "Add a hosted or private model profile before Cloud AI can start conversations."}
              />
            }
          >
            <AiProfilesTable
              profiles={profiles()}
              hasCredential={hasCredential}
              defaultModelId={defaultModelId()}
              onSetDefault={setDefaultModel}
              onEdit={(profile) => void editProfile(profile)}
              onDuplicate={duplicateProfile}
              onRemove={(profile) => void removeProfile(profile)}
            />
          </Show>
          <Show when={props.errorFor(AI_PROFILE_SETTING_KEY)}>
            <div class="px-3 pb-3">
              <FieldError error={() => props.errorFor(AI_PROFILE_SETTING_KEY)} />
            </div>
          </Show>
        </DataTable.Panel>
      </Show>
    </div>
  );
}

const AI_PROMPT_TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  { name: "user.displayName" },
  { name: "user.uid" },
  { name: "user.mail", kind: "email" },
  { name: "appId" },
  { name: "now" },
  { name: "today" },
  { name: "time" },
];

const AI_PROFILE_COLUMNS: readonly DataTableColumn<AiModelProfileDraft>[] = [
  { id: "provider", header: "Provider", cellClass: "min-w-64" },
  { id: "status", header: "Status", cellClass: "min-w-40" },
  { id: "endpoint", header: "Endpoint", cellClass: "min-w-56" },
  { id: "policy", header: "Policy", cellClass: "min-w-64" },
  { id: "actions", header: "Actions", align: "right", cellClass: "w-px" },
];

function AiProfilesTable(props: {
  profiles: readonly AiModelProfileDraft[];
  hasCredential: (profile: AiModelProfileDraft) => boolean;
  defaultModelId: string;
  onSetDefault: (profileId: string) => void;
  onEdit: (profile: AiModelProfileDraft) => void;
  onDuplicate: (profile: AiModelProfileDraft) => void;
  onRemove: (profile: AiModelProfileDraft) => void;
}) {
  return (
    <DataTable
      ariaLabel="AI providers"
      rows={props.profiles}
      columns={AI_PROFILE_COLUMNS}
      getRowId={(profile) => profile.id}
      density="compact"
      verticalAlign="top"
      highlightColumns={false}
      tableClass="w-full"
      renderCell={({ row: profile, col }) => {
        if (col.id === "provider") {
          const provider = providerOption(profile.provider);
          return (
            <div class="flex min-w-0 items-center gap-2.5">
              <Show
                when={profile.image}
                fallback={
                  <span class="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface-muted text-dimmed">
                    <i class="ti ti-sparkles" aria-hidden="true" />
                  </span>
                }
              >
                {(source) => <img src={source()} alt="" class="h-8 w-8 shrink-0 rounded-md object-cover" aria-hidden="true" />}
              </Show>
              <div class="min-w-0">
                <p class="truncate text-xs font-semibold text-primary">{profile.label}</p>
                <p class="mt-0.5 truncate text-[10px] text-dimmed" title={`${provider.label} · ${profile.model}`}>
                  {provider.label} · <code>{profile.model}</code>
                </p>
              </div>
            </div>
          );
        }
        if (col.id === "status") {
          return (
            <div class="flex flex-wrap gap-1">
              <Show when={profile.id === props.defaultModelId}>
                <StatusBadge tone="running" label="Default" icon={null} />
              </Show>
              <StatusBadge tone={profile.enabled ? "ok" : "neutral"} label={profile.enabled ? "Enabled" : "Disabled"} icon={null} />
              <Show when={props.hasCredential(profile)}>
                <StatusBadge tone="running" label="Key configured" icon={null} />
              </Show>
            </div>
          );
        }
        if (col.id === "endpoint") {
          return (
            <dl class="grid min-w-0 gap-1 text-[10px]">
              <div class="min-w-0">
                <dt class="text-dimmed">Profile ID</dt>
                <dd class="m-0 truncate text-primary" title={profile.id}>
                  <code>{profile.id}</code>
                </dd>
              </div>
              <Show when={profile.baseURL} fallback={<span class="text-dimmed">Provider default</span>}>
                {(baseURL) => (
                  <div class="min-w-0">
                    <dt class="text-dimmed">Base URL</dt>
                    <dd class="m-0 truncate text-primary" title={baseURL()}>
                      {baseURL()}
                    </dd>
                  </div>
                )}
              </Show>
            </dl>
          );
        }
        if (col.id === "policy") {
          const boundary = dataBoundaryOption(profile.dataBoundary);
          return (
            <div class="flex flex-wrap gap-1">
              <StatusBadge tone="neutral" label={boundary.label} icon={null} />
              {profile.capabilities.map((capability) => (
                <StatusBadge tone="neutral" label={`supports ${capability}`} icon={null} />
              ))}
            </div>
          );
        }
        if (col.id === "actions") {
          const isDefault = profile.id === props.defaultModelId;
          return (
            <div class="flex items-center justify-end gap-1">
              <Tooltip.Anchor content={isDefault ? "Default provider" : "Set as default"}>
                <IconButton
                  label={isDefault ? "Default provider" : "Set as default"}
                  size="sm"
                  disabled={isDefault || !profile.enabled}
                  onClick={() => props.onSetDefault(profile.id)}
                >
                  <i class="ti ti-star" aria-hidden="true" />
                </IconButton>
              </Tooltip.Anchor>
              <Tooltip.Anchor content="Edit profile">
                <IconButton label="Edit profile" size="sm" onClick={() => props.onEdit(profile)}>
                  <i class="ti ti-pencil" aria-hidden="true" />
                </IconButton>
              </Tooltip.Anchor>
              <Tooltip.Anchor content="Duplicate profile">
                <IconButton label="Duplicate profile" size="sm" onClick={() => props.onDuplicate(profile)}>
                  <i class="ti ti-copy" aria-hidden="true" />
                </IconButton>
              </Tooltip.Anchor>
              <Tooltip.Anchor content="Remove profile">
                <IconButton label="Remove profile" size="sm" class="text-danger" onClick={() => props.onRemove(profile)}>
                  <i class="ti ti-trash" aria-hidden="true" />
                </IconButton>
              </Tooltip.Anchor>
            </div>
          );
        }
        return "";
      }}
    />
  );
}

async function openAiProfileDialog(input: {
  profiles: AiModelProfileDraft[];
  profile?: AiModelProfileDraft;
  /** Whether a key is already stored for this profile — the value is never available here. */
  hasCredential?: boolean;
}): Promise<AiModelProfileDraft | undefined> {
  const initialProvider = input.profile?.provider ?? "openrouter";
  const initialProviderOption = providerOption(initialProvider);

  return dialogCore.open<AiModelProfileDraft>((close) => {
    const [provider, setProvider] = createSignal<AiProviderId>(initialProvider);
    const [label, setLabel] = createSignal(input.profile?.label ?? initialProviderOption.label);
    const [id, setId] = createSignal(input.profile?.id ?? uniqueProfileId(initialProviderOption.label, input.profiles));
    const [model, setModel] = createSignal(input.profile?.model ?? initialProviderOption.defaultModel);
    const [baseURL, setBaseURL] = createSignal(input.profile?.baseURL ?? initialProviderOption.defaultBaseURL ?? "");
    const [apiKey, setApiKey] = createSignal("");
    const [enabled, setEnabled] = createSignal(input.profile?.enabled ?? true);
    const [capabilities, setCapabilities] = createSignal<string[]>(input.profile?.capabilities ?? ["streaming"]);
    const [dataBoundary, setDataBoundary] = createSignal<AiDataBoundary>(
      input.profile?.dataBoundary ?? defaultDataBoundary(initialProvider),
    );
    const [contextWindow, setContextWindow] = createSignal<number | null>(input.profile?.contextWindow ?? null);
    const [maxLoadedTools, setMaxLoadedTools] = createSignal<number | null>(
      typeof input.profile?.maxLoadedTools === "number" && input.profile.maxLoadedTools > 0 ? input.profile.maxLoadedTools : null,
    );
    const [maxToolRounds, setMaxToolRounds] = createSignal<number | null>(
      typeof input.profile?.maxToolRounds === "number" && input.profile.maxToolRounds > 0 ? input.profile.maxToolRounds : null,
    );
    const [image, setImage] = createSignal<string | null>(input.profile?.image ?? null);
    const [formError, setFormError] = createSignal<string | undefined>();

    const currentProvider = () => providerOption(provider());
    const isCustomCompatible = () => provider() === "openai-compatible";
    const hasExistingCredential = () => Boolean(input.hasCredential) && input.profile?.provider === provider();
    const showApiKey = () => providerSupportsProfileKey(provider()) || hasExistingCredential();

    const chooseProvider = (next: string) => {
      if (!isProviderId(next)) return;
      const option = providerOption(next);
      setProvider(next);
      setDataBoundary(defaultDataBoundary(next));
      setModel(option.defaultModel);
      setBaseURL(option.defaultBaseURL ?? "");
      if (!input.profile) {
        setLabel(option.label);
        setId(uniqueProfileId(option.label, input.profiles));
      }
    };

    const submit = () => {
      const nextId = id().trim();
      const nextLabel = label().trim();
      const nextModel = model().trim();
      const nextBaseURL = baseURL().trim();

      if (!/^[a-z0-9][a-z0-9._-]*$/.test(nextId)) {
        setFormError(
          "Profile ID must start with a lowercase letter or number and may contain lowercase letters, numbers, dots, underscores, and dashes.",
        );
        return;
      }
      if (input.profiles.some((profile) => profile.id === nextId && profile.id !== input.profile?.id)) {
        setFormError(`Profile ID "${nextId}" already exists.`);
        return;
      }
      if (!nextLabel) {
        setFormError("Enter a provider name.");
        return;
      }
      if (!nextModel) {
        setFormError("Enter a model name.");
        return;
      }
      if (isCustomCompatible() && !nextBaseURL) {
        setFormError("Custom OpenAI-compatible providers need a base URL.");
        return;
      }
      if (providerRequiresProfileKey(provider()) && !apiKey().trim() && !hasExistingCredential()) {
        setFormError(`Enter an API key for ${currentProvider().label}.`);
        return;
      }

      const nextProfile: AiModelProfileDraft = {
        ...(input.profile ?? {}),
        id: nextId,
        label: nextLabel,
        provider: provider(),
        model: nextModel,
        enabled: enabled(),
        capabilities: capabilities(),
        dataBoundary: dataBoundary(),
      };

      // Only a freshly typed key travels. An untouched field leaves the stored
      // one alone, because the backend overwrites only what it is sent.
      const nextApiKey = apiKey().trim();
      if (nextApiKey) nextProfile.apiKey = nextApiKey;
      else delete nextProfile.apiKey;

      if (nextBaseURL) nextProfile.baseURL = nextBaseURL;
      else delete nextProfile.baseURL;

      const nextImage = image();
      if (nextImage) nextProfile.image = nextImage;
      else delete nextProfile.image;

      const context = contextWindow();
      if (typeof context === "number" && context > 0) nextProfile.contextWindow = context;
      else delete nextProfile.contextWindow;

      const loadedLimit = maxLoadedTools();
      if (typeof loadedLimit === "number") nextProfile.maxLoadedTools = Math.trunc(loadedLimit);
      else delete nextProfile.maxLoadedTools;

      const toolRoundLimit = maxToolRounds();
      if (typeof toolRoundLimit === "number") nextProfile.maxToolRounds = Math.trunc(toolRoundLimit);
      else delete nextProfile.maxToolRounds;

      close(nextProfile);
    };

    return (
      <form
        class="contents"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <PanelDialog>
          <PanelDialog.Header
            title={input.profile ? "Edit provider" : "Add provider"}
            subtitle="Configure one model profile and its provider-bound credentials."
            icon="ti ti-sparkles"
            close={() => close(undefined)}
          />
          <PanelDialog.Body>
            <PanelDialog.Section
              title="Provider"
              subtitle="Provider type, user-visible label, stable id, and endpoint configuration."
              icon="ti ti-sparkles"
            >
              <CheckboxCard
                label="Profile enabled"
                description="Disabled profiles stay configured but cannot be selected by apps or users."
                icon="ti ti-power"
                value={enabled}
                onValueChange={setEnabled}
              />

              <Select
                label="Provider"
                description="Provider type used to create the Nessi model adapter."
                value={() => provider()}
                onValueChange={(value) => value !== null && chooseProvider(value)}
                options={AI_PROVIDER_OPTIONS.map((option) => ({
                  id: option.id,
                  label: option.label,
                  description: option.description,
                  icon: "ti ti-sparkles",
                }))}
                icon="ti ti-sparkles"
              />

              <div class="grid gap-3 sm:grid-cols-2">
                <TextInput
                  label="Name"
                  description="User-visible model label shown in model pickers and chat UI."
                  value={label}
                  onValueChange={setLabel}
                  placeholder={currentProvider().label}
                />
                <TextInput
                  label="Profile ID"
                  description="Stable internal id."
                  value={id}
                  onValueChange={setId}
                  placeholder="openrouter-fast"
                  monospace
                />
              </div>

              <TextInput
                label="Model"
                description="Provider model identifier sent to the AI adapter."
                value={model}
                onValueChange={setModel}
                placeholder={currentProvider().defaultModel}
                monospace
              />

              <TextInput
                label="Base URL"
                description="Optional endpoint override for private or OpenAI-compatible providers."
                value={baseURL}
                onValueChange={setBaseURL}
                placeholder={currentProvider().defaultBaseURL ?? "Optional provider override"}
                type="url"
              />

              <ImageInput
                label="Logo"
                description="Optional small logo shown in the provider card and the model picker."
                variant="small"
                value={image}
                onValueChange={setImage}
                transform={(file) => img.presets.avatar(file, 64, 0.8, "webp")}
              />
            </PanelDialog.Section>

            <Show when={showApiKey()}>
              <PanelDialog.Section
                title="Credentials"
                subtitle="The key is stored only on this provider profile, not as a global provider setting."
                icon="ti ti-key"
              >
                <TextInput
                  label={`${currentProvider().label} API key`}
                  description={
                    hasExistingCredential()
                      ? "A key is stored for this profile. Leave empty to keep it."
                      : "Stored server-side for this profile and used only when this profile is selected."
                  }
                  password
                  value={apiKey}
                  onValueChange={setApiKey}
                  placeholder={hasExistingCredential() ? "Leave empty to keep current key" : "Provider API key"}
                />
              </PanelDialog.Section>
            </Show>

            <PanelDialog.Section
              title="Policy"
              subtitle="Processing boundary and runtime capabilities used by app policies."
              icon="ti ti-shield"
            >
              <NumberInput
                label="Context window"
                description="Optional max token context window. Leave empty to use the provider default."
                value={contextWindow}
                onValueChange={setContextWindow}
                min={1}
                clearable
                showSteppers={false}
                placeholder="Provider default"
              />

              <NumberInput
                label="Loaded tool limit"
                description="Maximum deferred tools retained per conversation. Empty or 0 means unlimited."
                value={maxLoadedTools}
                onValueChange={setMaxLoadedTools}
                min={0}
                clearable
                showSteppers={false}
                placeholder="Unlimited"
              />

              <NumberInput
                label="Tool round limit"
                description="Maximum tool-using model rounds per chat before one final answer without tools. Empty or 0 means unlimited."
                value={maxToolRounds}
                onValueChange={setMaxToolRounds}
                min={0}
                clearable
                showSteppers={false}
                placeholder="Unlimited"
              />

              <Select
                label="Data boundary"
                description="Whether requests leave the workspace or stay on controlled infrastructure."
                value={() => dataBoundary()}
                onValueChange={(value) => value !== null && setDataBoundary(value as AiDataBoundary)}
                options={[...AI_DATA_BOUNDARY_OPTIONS]}
                icon="ti ti-shield"
              />

              <MultiSelectInput
                label="Capabilities"
                description="Capabilities describe runtime features apps can require."
                value={capabilities}
                onValueChange={setCapabilities}
                options={AI_MODEL_CAPABILITY_OPTIONS.map((option) => ({ ...option, icon: "ti ti-bolt" }))}
                placeholder="Choose capabilities"
                icon="ti ti-bolt"
                clearable
              />
            </PanelDialog.Section>
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <div class="min-w-0">
              <FieldError error={formError} />
            </div>
            <div class="flex items-center gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => close(undefined)}>
                Cancel
              </Button>
              <Button type="submit" variant="ai" size="sm">
                <i class="ti ti-check" /> Apply changes
              </Button>
            </div>
          </PanelDialog.Footer>
        </PanelDialog>
      </form>
    );
  }, panelDialogWideOptions);
}

function FieldRow(props: {
  entry: SettingFieldDef;
  value: () => unknown;
  error: () => string | undefined;
  changed: () => boolean;
  resetPending: () => boolean;
  canUseDefault: () => boolean;
  onChange: (value: unknown) => void;
  onUseDefault: () => void;
}) {
  const e = () => props.entry;

  return (
    <div class="flex flex-col gap-2 rounded-lg px-3 py-2" classList={{ "bg-amber-50/50 dark:bg-amber-950/20": props.changed() }}>
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-sm font-medium text-primary">{e().label}</h3>
            <code class="text-[10px] text-dimmed">{e().key}</code>
            <Show when={props.changed()}>
              <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" title="Unsaved change" />
            </Show>
            <span
              class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                e().valueSource === "custom"
                  ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                  : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
              }`}
            >
              {sourceLabel(e().valueSource)}
            </span>
            <Show when={props.resetPending()}>
              <span class="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                Default staged
              </span>
            </Show>
          </div>
          <p class="mt-1 text-xs text-dimmed">{e().description}</p>
          <p class="mt-1 text-[11px] text-dimmed">
            Use default will apply on Save: <span class="font-medium text-secondary">{formatSettingPreview(e(), e().resetValue)}</span>
            <span class="text-dimmed"> ({sourceLabel(e().resetValueSource).toLowerCase()})</span>
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <Tooltip.Anchor content="Stage the default value. Save applies it; Discard cancels it.">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={props.onUseDefault}
              disabled={!props.canUseDefault()}
              aria-label={`Use default for ${e().label}`}
            >
              <i class="ti ti-arrow-back-up" /> Use default
            </Button>
          </Tooltip.Anchor>
        </div>
      </div>

      <FieldInput entry={e()} value={props.value} error={props.error} onChange={props.onChange} />
    </div>
  );
}

type FieldInputProps = {
  entry: SettingFieldDef;
  value: () => unknown;
  error: () => string | undefined;
  onChange: (value: unknown) => void;
};

type FieldRenderer = (props: FieldInputProps) => JSX.Element;

const FIELD_RENDERERS: Partial<Record<SettingFieldDef["kind"], FieldRenderer>> = {
  image: (props) => <ImageSettingInput value={props.value} error={props.error} onChange={props.onChange} />,
  boolean: (props) => <BooleanSettingInput value={props.value} error={props.error} onChange={props.onChange} />,
  number: (props) => <NumberSettingInput {...props} />,
  enum: (props) => <EnumSettingInput {...props} />,
  string_list: (props) => <StringListSettingInput {...props} />,
  number_list: (props) => <NumberListSettingInput {...props} />,
  text: (props) => <TextAreaSettingInput {...props} />,
  template: (props) => <TemplateSettingInput {...props} />,
};

function FieldInput(props: FieldInputProps) {
  const render = FIELD_RENDERERS[props.entry.kind] ?? DefaultTextSettingInput;
  return render(props);
}

function FieldError(props: { error: () => string | undefined }) {
  return (
    <Show when={props.error()}>
      <p class="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
        <i class="ti ti-alert-circle text-xs" /> {props.error()}
      </p>
    </Show>
  );
}

function ImageSettingInput(props: { value: () => unknown; error: () => string | undefined; onChange: (value: unknown) => void }) {
  return (
    <div class="flex flex-col gap-1">
      <ImageInput
        variant="small"
        value={() => (typeof props.value() === "string" && props.value() ? (props.value() as string) : null)}
        onValueChange={(v) => props.onChange(v ?? "")}
      />
      <FieldError error={props.error} />
    </div>
  );
}

function BooleanSettingInput(props: { value: () => unknown; error: () => string | undefined; onChange: (value: unknown) => void }) {
  return (
    <div class="flex flex-col gap-1">
      <Switch
        label={props.value() ? "Enabled" : "Disabled"}
        value={() => Boolean(props.value())}
        onValueChange={(v) => props.onChange(v)}
      />
      <FieldError error={props.error} />
    </div>
  );
}

function NumberSettingInput(props: FieldInputProps) {
  return (
    <NumberInput
      value={() => (typeof props.value() === "number" ? (props.value() as number) : 0)}
      onValueChange={(v) => props.onChange(v)}
      min={props.entry.min}
      max={props.entry.max}
      error={props.error}
    />
  );
}

function EnumSettingInput(props: FieldInputProps) {
  const options = (props.entry.options ?? []).map((o) => ({ id: o.value, value: o.value, label: o.label }));
  return (
    <Select
      value={() => (typeof props.value() === "string" ? (props.value() as string) : (props.entry.options?.[0]?.value ?? ""))}
      onValueChange={(v) => props.onChange(v)}
      options={options}
      icon="ti ti-selector"
      error={props.error}
    />
  );
}

function StringListSettingInput(props: FieldInputProps) {
  return (
    <TagsInput
      value={() => (Array.isArray(props.value()) ? (props.value() as string[]) : [])}
      onValueChange={(v) => props.onChange(v)}
      placeholder={props.entry.placeholder ?? props.entry.label}
      error={props.error}
    />
  );
}

function NumberListSettingInput(props: FieldInputProps) {
  return (
    <TagsInput
      value={() => (Array.isArray(props.value()) ? (props.value() as number[]).map(String) : [])}
      onValueChange={(v) => props.onChange(v.map((s) => Number(s)).filter((n) => Number.isInteger(n) && n > 0))}
      placeholder={props.entry.placeholder ?? props.entry.label}
      error={props.error}
    />
  );
}

function TextAreaSettingInput(props: FieldInputProps) {
  return (
    <TextInput
      multiline
      value={() => (typeof props.value() === "string" ? (props.value() as string) : "")}
      onValueChange={(v) => props.onChange(v)}
      placeholder={props.entry.placeholder ?? props.entry.label}
      error={props.error}
    />
  );
}

const TEMPLATE_SAMPLE_VALUES: Record<string, string> = {
  ACCOUNT_KIND: "full account",
  APP_NAME: "Cloud",
  CONTACT_EMAIL: "support@example.org",
  DISPLAY_NAME: "Eva Becker",
  EMAIL: "eva@example.org",
  EXPIRY: "31 Dec 2026",
  EXTEND_URL: "https://cloud.example.org/me",
  FIRST_NAME: "Eva",
  LOGIN_URL: "https://cloud.example.org/auth/login",
  MAGIC_LINK: "https://cloud.example.org/auth/magic-link/example",
  PASSWORD: "correct horse battery staple",
  REASON: "The request could not be approved.",
  RESET_LINK: "https://cloud.example.org/auth/password-reset/example",
  TOKEN: "123456",
  USERNAME: "ebecker",
};

const sampleValueFor = (name: string) => TEMPLATE_SAMPLE_VALUES[name] ?? name.toLowerCase().replaceAll("_", " ");

const escapePreviewText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const buildEmailPreviewHtml = (content: string) => `
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
          <table cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:middle;">
              <span style="font-size:16px;font-weight:600;color:#18181b;">Cloud</span>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="background:#ffffff;padding:28px 24px;border-left:1px solid #e4e4e7;border-right:1px solid #e4e4e7;">
          <div style="font-size:14px;line-height:1.6;color:#27272a;">
            ${content}
          </div>
        </td></tr>
        <tr><td style="background:#fafafa;padding:16px 24px;border-radius:0 0 12px 12px;border:1px solid #e4e4e7;border-top:none;">
          <p style="margin:0 0 8px;font-size:11px;color:#71717a;text-align:center;">
            <a href="https://cloud.example.org/impressum" style="color:#71717a;text-decoration:underline;">Imprint</a>
            &nbsp;&middot;&nbsp;
            <a href="https://cloud.example.org/legal/terms" style="color:#71717a;text-decoration:underline;">Terms</a>
            &nbsp;&middot;&nbsp;
            <a href="https://cloud.example.org/legal/privacy" style="color:#71717a;text-decoration:underline;">Privacy</a>
          </p>
          <p style="margin:0;font-size:11px;color:#a1a1aa;text-align:center;">
            This message was sent automatically. Please do not reply to this email.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>
`;

const createTemplateSampleData = (variables: readonly string[]): Record<string, string> =>
  Object.fromEntries(variables.map((name) => [name, sampleValueFor(name)]));

const renderTemplatePreviewBody = (template: string, variables: readonly string[], sampleData = createTemplateSampleData(variables)) => {
  try {
    return renderLiquidTemplate(template, Object.fromEntries(variables.map((name) => [name, sampleData[name] ?? sampleValueFor(name)])));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Template preview failed";
    return `<p style="color:#b91c1c;">${escapePreviewText(message)}</p>`;
  }
};

const renderTemplatePreview = (template: string, variables: readonly string[], sampleData?: Record<string, string>) =>
  buildEmailPreviewHtml(renderTemplatePreviewBody(template, variables, sampleData));

const inferTemplateVariableKind = (name: string): TemplateVariableKind => {
  if (name.endsWith("_URL") || name.endsWith("_LINK") || name === "LOGIN_URL" || name === "MAGIC_LINK" || name === "RESET_LINK") {
    return "url";
  }
  if (name.endsWith("_EMAIL") || name === "EMAIL") return "email";
  if (name.endsWith("_COUNT") || name.endsWith("_DAYS")) return "number";
  return "string";
};

function TemplateSettingInput(props: FieldInputProps) {
  const currentValue = () => (typeof props.value() === "string" ? (props.value() as string) : "");
  const variables = () => props.entry.templateVars ?? [];
  const templateVariables = (): TemplateVariable[] => variables().map((name) => ({ name, kind: inferTemplateVariableKind(name) }));
  const preview = () => renderTemplatePreview(currentValue(), variables());

  const openEditor = async () => {
    const initialValue = currentValue();
    const result = await prompts.dialog<string>(
      (close) => {
        const [draft, setDraft] = createSignal(initialValue);
        const [layout, setLayout] = createSignal(createTemplateEditorPanesLayout());
        const [sampleData, setSampleData] = createSignal<Record<string, string>>(createTemplateSampleData(variables()));
        const renderedPreview = createMemo(() => renderTemplatePreview(draft(), variables(), sampleData()));
        const setSampleValue = (name: string, value: string) => {
          setSampleData((current) => ({ ...current, [name]: value }));
        };

        return (
          <div class="flex min-h-0 flex-col gap-4">
            <div>
              <p class="text-xs text-dimmed">{props.entry.key}</p>
              <p class="mt-1 text-sm text-secondary">{props.entry.description}</p>
            </div>

            <p class="text-xs text-dimmed">
              Type {"{{"} for values, {"{%"} for Liquid logic, or {"<"} for HTML snippets. Use sample data to change preview values.
            </p>

            <div class="h-[min(62vh,46rem)] min-h-[34rem] min-w-0 overflow-hidden rounded-lg bg-zinc-100 p-2 dark:bg-zinc-900">
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
                          value={draft}
                          onValueChange={setDraft}
                          variables={templateVariables()}
                          placeholder={props.entry.placeholder ?? props.entry.label}
                          fill
                        />
                      </div>
                    ),
                  },
                  {
                    id: "preview",
                    title: "Preview",
                    icon: "ti ti-eye",
                    render: () => <TemplatePreview html={renderedPreview()} />,
                  },
                  {
                    id: "sample-data",
                    title: "Sample data",
                    icon: "ti ti-database",
                    render: () => (
                      <TemplateSampleData variables={templateVariables()} values={sampleData()} onValueChange={setSampleValue} />
                    ),
                  },
                ]}
              />
            </div>

            <div class="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => close(undefined)}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={() => close(draft())}>
                <i class="ti ti-check" /> Save
              </Button>
            </div>
          </div>
        );
      },
      { title: props.entry.label, icon: "ti ti-template", size: "wide" },
    );

    if (typeof result === "string" && result !== initialValue) props.onChange(result);
  };

  return (
    <div class="flex flex-col gap-2">
      <div class="grid gap-2 rounded-xl border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/50 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div class="min-w-0">
          <p class="text-xs font-medium text-primary">HTML body template</p>
          <p class="mt-1 truncate text-xs text-dimmed">{props.entry.description}</p>
        </div>
        <Button type="button" variant="secondary" size="sm" class="justify-center" onClick={() => void openEditor()}>
          <i class="ti ti-pencil" /> Edit template
        </Button>
      </div>

      <details class="group rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <summary class="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs font-medium text-secondary">
          <i class="ti ti-eye text-dimmed" />
          Preview
          <i class="ti ti-chevron-down ml-auto text-dimmed transition-transform group-open:rotate-180" />
        </summary>
        <iframe class="h-56 w-full bg-white" sandbox="" srcdoc={preview()} title={`${props.entry.label} preview`} />
      </details>

      <FieldError error={props.error} />
    </div>
  );
}

function DefaultTextSettingInput(props: FieldInputProps) {
  // Secrets are server-side redacted (see settings/app.ts redactSecretValue).
  // The input always starts empty; admin types a new value to change, leaves
  // empty to keep the current stored secret.
  const isSecret = props.entry.kind === "secret";
  return (
    <TextInput
      value={() => (typeof props.value() === "string" ? (props.value() as string) : String(props.value() ?? ""))}
      onValueChange={(v) => props.onChange(v)}
      placeholder={isSecret ? "Leave empty to keep current value" : (props.entry.placeholder ?? props.entry.label)}
      type={props.entry.kind === "email" ? "email" : props.entry.kind === "url" ? "url" : "text"}
      password={isSecret}
      error={props.error}
    />
  );
}
