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

import type { AiEnrichmentOverview } from "@k2b/cloud/ai";
import { coreClient } from "@k2b/cloud/clients/core";
import type { GeoIpAdminStatus } from "@k2b/cloud/contracts";
import { AI_LOCAL_CLIENT_DEFAULT_INSTRUCTIONS, AI_PLATFORM_PROMPT_TEMPLATE } from "@k2b/cloud/shared";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  dialogCore,
  NoticeCard,
  NumberInput,
  PanelDialog,
  panelDialogWideOptions,
  prompts,
  readSettingsError,
  SettingsPage,
  SettingsPanelFooter,
  SettingsSection,
  StatCell,
  StatGrid,
  Switch,
  sameSettingValue,
  TemplateEditor,
  type TemplateVariable,
  TextInput,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import ApprovalStatus from "../../../app-approval/ApprovalStatus";
import type { ApprovalAvailability } from "../../../app-approval/availability";
import { appApprovalMessages } from "../../../app-approval/messages";
import { adminMessages } from "../../messages";
import { settingsDocumentationHref } from "../documentation";
import { accountSettingsSection } from "./account-settings";
import { aiSettingsMessages } from "./ai-settings-messages";
import DocumentationLink from "./DocumentationLink";
import { settingsMessages } from "./messages";
import SignInLocations from "./SignInLocations";
import { localizeSettingField } from "./setting-copy";
import type { SettingFieldDef, SettingValueSource } from "./setting-field";
import { FieldError, FieldInput, settingControlId } from "./setting-inputs";
import { UnreadableSettingBadge, UnreadableSettingsNotice, unreadableReplacements } from "./UnreadableSettings";

export type { SettingFieldDef } from "./setting-field";

type Props = {
  documentationBase?: string;
  documentationTopic?: string;
  title: string;
  subtitle: string;
  icon: string;
  entries: SettingFieldDef[];
  accountSection?: "sign-in" | "registration";
  approvalState?: ApprovalAvailability;
  /** Present on the sign-in tab; `status` is null when the server could not read it. */
  signInLocations?: { status: GeoIpAdminStatus | null; actorId: string };
  showTestStorageAction?: boolean;
  showTestFreeIpaAction?: boolean;
  aiEnrichmentOverview?: AiEnrichmentOverview | null;
  backgroundTaskPrompts?: Record<string, string[]>;
  /** Profile ids with a stored provider key. The keys themselves stay server-side. */
  /** Which slice of the AI settings this page shows (the AI sidebar group splits them). */
  aiSection?: AiSection;
  showAiJobsLink?: boolean;
  /** Rendered inside a titled workspace level, which already shows the title. */
  embedded?: boolean;
};

const AI_ENABLED_SETTING_KEY = "ai.enabled";
const AI_GLOBAL_INSTRUCTIONS_SETTING_KEY = "ai.global_instructions";
const AI_LOCAL_CLIENT_INSTRUCTIONS_SETTING_KEY = "ai.local_client_instructions";
const AI_COMPACTION_INSTRUCTIONS_SETTING_KEY = "ai.compaction_instructions";
const AI_CHAT_ENRICHMENT_INSTRUCTIONS_SETTING_KEY = "ai.chat_enrichment_instructions";
const AI_MEMORY_LEARNING_INSTRUCTIONS_SETTING_KEY = "ai.memory_learning_instructions";
const AI_MAX_TOOL_RESULT_CHARS_SETTING_KEY = "ai.max_tool_result_chars";
const AI_FIRECRAWL_API_KEY_SETTING_KEY = "ai.firecrawl_api_key";
const AI_ENRICH_CRON_SETTING_KEY = "ai.enrich_cron";
const AI_MEMORY_LEARNING_CRON_SETTING_KEY = "ai.memory_learning_cron";
const AI_MEMORY_LEARNING_MONTHLY_TOKEN_BUDGET_SETTING_KEY = "ai.memory_learning_monthly_token_budget";

type AiSection = "general" | "jobs" | "tools";

/** Where the AI panel renders each setting a save can reject, so the error summary can point there. */
const AI_SETTING_SECTIONS: Readonly<Record<string, AiSection>> = {};

class SettingsConflictError extends Error {}

const AI_SETTINGS_HANDLED_BY_PANEL = new Set<string>([
  AI_ENABLED_SETTING_KEY,
  AI_GLOBAL_INSTRUCTIONS_SETTING_KEY,
  AI_LOCAL_CLIENT_INSTRUCTIONS_SETTING_KEY,
  AI_COMPACTION_INSTRUCTIONS_SETTING_KEY,
  AI_CHAT_ENRICHMENT_INSTRUCTIONS_SETTING_KEY,
  AI_MEMORY_LEARNING_INSTRUCTIONS_SETTING_KEY,
  "ai.turn_timeout_minutes",
  AI_MAX_TOOL_RESULT_CHARS_SETTING_KEY,
  AI_FIRECRAWL_API_KEY_SETTING_KEY,
  AI_ENRICH_CRON_SETTING_KEY,
  AI_MEMORY_LEARNING_CRON_SETTING_KEY,
  AI_MEMORY_LEARNING_MONTHLY_TOKEN_BUDGET_SETTING_KEY,
]);

export default function CoreSettingsForm(props: Props) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const localizedEntries = createMemo(() => props.entries.map((entry) => localizeSettingField(entry, locale())));
  const [drafts, setDrafts] = createSignal<Record<string, unknown>>({});
  const [resetKeys, setResetKeys] = createSignal<Record<string, true>>({});
  const [fieldErrors, setFieldErrors] = createSignal<Record<string, string>>({});
  // Title of the rejected save; the listed problems are the live field errors.
  const [saveProblem, setSaveProblem] = createSignal<string | null>(null);
  // Someone saved a setting this page changed: their value, who and when, until the person decides.
  const [conflict, setConflict] = createSignal<{ key: string; current: unknown; changedBy: string | null; changedAt: string } | null>(null);
  // The stored version each key was last read at; a conflict moves it to the other person's save.
  const [seenAt, setSeenAt] = createSignal<Record<string, string | null>>({});
  let saveProblemNotice: HTMLElement | undefined;

  const entryMap = createMemo(() => {
    const m: Record<string, SettingFieldDef> = {};
    for (const e of localizedEntries()) m[e.key] = e;
    return m;
  });

  const initialMap = createMemo(() => {
    const m: Record<string, unknown> = {};
    for (const e of localizedEntries()) m[e.key] = e.value;
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
  const isAiSettings = () => props.aiSection !== undefined || localizedEntries().some((entry) => entry.key === "ai.enabled");
  const genericEntries = () =>
    localizedEntries().filter(
      (entry) =>
        !entry.key.startsWith("user.category.") &&
        (!props.accountSection || accountSettingsSection(entry.key) === props.accountSection) &&
        (!entry.key.startsWith("user.app_approval.") || entry.key.endsWith(".enabled") || valueOf("user.app_approval.enabled") === true) &&
        (entry.key !== "user.allow_self_registration" || valueOf("user.category.guest.enabled") !== false) &&
        (!isAiSettings() || !AI_SETTINGS_HANDLED_BY_PANEL.has(entry.key)),
    );

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
    setSaveProblem(null);
  };

  const aiSection = () => props.aiSection ?? "general";
  const problemLabel = (key: string): string | undefined => entryMap()[key]?.label;
  const sectionTitle = (section: AiSection) => {
    const admin = adminMessages.resolve([locale()]).t;
    return { general: admin.aiGeneral, jobs: admin.aiBackgroundJobs, tools: admin.aiToolsApi }[section];
  };
  const focusSetting = (key: string): boolean => {
    const control = document.getElementById(settingControlId(key));
    if (!control) return false;
    control.scrollIntoView({ block: "center" });
    control.focus();
    return true;
  };
  // Land on the first problem the admin can fix here, otherwise on the summary.
  const focusFirstProblem = () => {
    const keys = Object.keys(fieldErrors());
    if (keys.some(focusSetting)) return;
    const invalid = document.querySelector<HTMLElement>('[aria-invalid="true"]');
    const target = invalid ?? saveProblemNotice;
    target?.scrollIntoView({ block: "center" });
    target?.focus();
  };

  if (typeof window !== "undefined") {
    window.onbeforeunload = () => (hasChanges() ? "" : null);
  }

  const save = mutations.create<void, void>({
    mutation: async () => {
      setSaveProblem(null);
      const resets = resetKeyList().filter((key) => changedKeys().includes(key));
      const updates: Record<string, unknown> = {};
      for (const k of changedKeys()) {
        if (resets.includes(k)) continue;
        updates[k] = drafts()[k];
      }

      const replaceUnreadable = unreadableReplacements(updates, entryMap());
      const response = await coreClient.admin.core.settings.$put({
        json: {
          updates,
          resets,
          replaceUnreadable,
          expectedUpdatedAt: Object.fromEntries(
            changedKeys()
              .filter((key) => key in seenAt() || entryMap()[key]?.updatedAt !== undefined)
              .map((key) => [key, key in seenAt() ? (seenAt()[key] ?? null) : (entryMap()[key]!.updatedAt ?? null)]),
          ),
        },
      });

      if (response.status === 409) {
        const body: unknown = await response
          .clone()
          .json()
          .catch(() => null);
        const read = (key: string): unknown =>
          body && typeof body === "object" && key in body ? (body as Record<string, unknown>)[key] : undefined;
        const key = read("key");
        const by = read("changedBy");
        const changedAt = read("changedAt");
        if (read("code") === "conflict" && typeof key === "string") {
          const name = by && typeof by === "object" && "name" in by && typeof by.name === "string" ? by.name : null;
          setConflict({ key, current: read("current"), changedBy: name, changedAt: typeof changedAt === "string" ? changedAt : "" });
          throw new SettingsConflictError();
        }
      }
      if (!response.ok) {
        const { message, fields } = await readSettingsError(response, t().saveFailed({ status: response.status }));
        setFieldErrors(fields);
        // Field-level problems stay on the page next to the preserved drafts instead of a modal.
        if (Object.keys(fields).length > 0) {
          setSaveProblem(message);
          queueMicrotask(focusFirstProblem);
        }
        throw new Error(message);
      }
    },
    onSuccess: () => {
      window.onbeforeunload = null;
      window.location.reload();
    },
    onError: (e) => {
      if (e instanceof SettingsConflictError) return;
      if (!saveProblem()) prompts.error(e.message);
    },
  });

  const keepMine = () => {
    const current = conflict();
    if (!current) return;
    setSeenAt((prev) => ({ ...prev, [current.key]: current.changedAt || null }));
    setConflict(null);
    save.mutate();
  };
  const takeTheirs = () => {
    const current = conflict();
    if (!current) return;
    setSeenAt((prev) => ({ ...prev, [current.key]: current.changedAt || null }));
    if (current.current !== undefined) setDraft(current.key, current.current);
    setConflict(null);
  };

  const [storageTestResult, setStorageTestResult] = createSignal<{ ok: boolean; message: string } | null>(null);
  const testStorage = mutations.create<void, void>({
    mutation: async () => {
      setStorageTestResult(null);
      const response = await coreClient.admin.core.settings["test-storage"].$post();
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        const message =
          body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : t().storageTestFailed;
        throw new Error(message);
      }
    },
    onSuccess: () => setStorageTestResult({ ok: true, message: t().storageReachable }),
    onError: (error) => setStorageTestResult({ ok: false, message: error.message }),
  });

  const testFreeIpa = mutations.create<void, void>({
    mutation: async () => {
      const response = await coreClient.admin.core.settings["test-freeipa"].$post();
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          body && typeof body === "object" && "message" in body && typeof body.message === "string"
            ? body.message
            : t().freeIpaTestFailed({ status: response.status });
        throw new Error(message);
      }
    },
    onSuccess: () => toast.success(t().freeIpaReachable),
    onError: (e) => prompts.error(e.message),
  });

  const headerActions = () => (
    <>
      <Show when={props.showTestStorageAction}>
        <Tooltip.Anchor content={hasChanges() ? t().testStoragePending : t().testStorageSaved}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => testStorage.mutate()}
            loading={testStorage.loading()}
            loadingLabel={t().testingConnection}
            disabled={hasChanges()}
          >
            <i class="ti ti-plug-connected" /> {t().testConnection}
          </Button>
        </Tooltip.Anchor>
      </Show>
      <Show when={props.showTestFreeIpaAction}>
        <Tooltip.Anchor content={hasChanges() ? t().testFreeIpaPending : t().testFreeIpaSaved}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            class="justify-center"
            onClick={() => testFreeIpa.mutate()}
            loading={testFreeIpa.loading()}
            loadingLabel={t().testingConnection}
            disabled={hasChanges()}
          >
            <i class="ti ti-plug-connected" /> {t().testConnection}
          </Button>
        </Tooltip.Anchor>
      </Show>
    </>
  );

  // The page header links the page's article; a section links only an article of its own.
  // An anchor into the page's article is the same article, so it gets no second link.
  const article = (topic: string) => settingsDocumentationHref(props.documentationBase, topic)?.split("#")[0];
  const sectionHasOwnDocumentation = (sectionId: string) => {
    const own = article(sectionId);
    return Boolean(own) && own !== article(props.documentationTopic ?? "");
  };

  const renderFieldSections = (entries: SettingFieldDef[]) =>
    groupSettingEntries(entries, t()).map((section) => (
      <SettingsSection
        title={section.title}
        subtitle={section.subtitle}
        icon={section.icon}
        actions={
          sectionHasOwnDocumentation(section.id) ? (
            <DocumentationLink base={props.documentationBase} topic={section.id} section={section.title} />
          ) : undefined
        }
      >
        <Show when={section.id === "user.appApproval" && props.approvalState}>
          <p class="text-xs text-dimmed">{appApprovalMessages.resolve([locale()]).t.savedConfiguration}</p>
          <ApprovalStatus state={props.approvalState!} admin />
        </Show>
        {renderFieldRows(section.entries)}
      </SettingsSection>
    ));

  return (
    <SettingsPage
      title={props.title}
      header={!props.embedded}
      subtitle={props.subtitle}
      icon={props.icon}
      actions={
        <>
          <DocumentationLink base={props.documentationBase} topic={props.documentationTopic ?? ""} />
          {props.showTestFreeIpaAction || props.showTestStorageAction ? headerActions() : undefined}
        </>
      }
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
      <Show when={conflict()}>
        {(current) => (
          <NoticeCard
            tone="warning"
            icon="ti ti-git-merge"
            role="alert"
            title={
              current().changedBy
                ? t().settingConflictBy({
                    name: current().changedBy!,
                    setting: problemLabel(current().key) ?? current().key,
                    time: current().changedAt
                      ? new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit" }).format(new Date(current().changedAt))
                      : "",
                  })
                : t().settingConflict({ setting: problemLabel(current().key) ?? current().key })
            }
            detail={t().settingConflictDetail}
          >
            <div class="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={keepMine} disabled={save.loading()}>
                {t().settingConflictKeepMine}
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={takeTheirs} disabled={save.loading()}>
                {t().settingConflictTakeTheirs}
              </Button>
            </div>
          </NoticeCard>
        )}
      </Show>

      <Show when={saveProblem() && Object.keys(fieldErrors()).length > 0}>
        <NoticeCard ref={saveProblemNotice} tabIndex={-1} tone="danger" title={saveProblem()}>
          <ul class="flex flex-col gap-2">
            <For each={Object.entries(fieldErrors())}>
              {([key, message]) => {
                const section = isAiSettings() ? AI_SETTING_SECTIONS[key] : undefined;
                return (
                  <li class="flex flex-col gap-0.5" data-setting={key}>
                    <Show when={problemLabel(key)}>{(label) => <span class="font-medium text-primary">{label()}</span>}</Show>
                    <span>{message}</span>
                    <Show when={section}>
                      {(owner) => (
                        <Show
                          when={owner() !== aiSection()}
                          fallback={
                            <Button type="button" variant="text" size="sm" class="self-start" onClick={() => focusSetting(key)}>
                              {t().goToField}
                            </Button>
                          }
                        >
                          <ButtonLink variant="text" size="sm" class="self-start" href={`/admin/ai?sec=${owner()}`}>
                            {t().openSettingsPage({ page: sectionTitle(owner()) })}
                          </ButtonLink>
                        </Show>
                      )}
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </NoticeCard>
      </Show>

      <UnreadableSettingsNotice
        entries={localizedEntries()}
        canUseDefault={(key) => {
          const entry = entryMap()[key];
          return entry ? canStageDefault(entry) : false;
        }}
        onUseDefault={(key) => {
          const entry = entryMap()[key];
          if (entry) stageDefault(entry);
        }}
      />

      <Show when={props.showTestStorageAction && storageTestResult()}>
        <div role="status" aria-live="polite">
          <NoticeCard tone={storageTestResult()?.ok ? "info" : "danger"} title={storageTestResult()?.message} />
        </div>
      </Show>
      <Show when={props.showTestFreeIpaAction || props.showTestStorageAction}>
        <NoticeCard tone="info" title={t().testsUseSaved} detail={t().testsUseSavedDescription} />
      </Show>

      <Show
        when={isAiSettings()}
        fallback={
          <>
            <Show when={props.accountSection !== "registration" && entryMap()["user.category.guest.enabled"]}>
              <NoticeCard tone="info" title={t().accountCategories} detail={t().accountCategoriesDescription} />
              {(["guest", "login", "freeipa"] as const).map((category) => (
                <SettingsSection
                  title={
                    category === "guest"
                      ? "Guest"
                      : category === "freeipa"
                        ? "FreeIPA"
                        : String(valueOf("user.category.login.label") || "Login")
                  }
                >
                  {renderFieldRows(localizedEntries().filter((entry) => entry.key === `user.category.${category}.enabled`))}
                  <Show when={valueOf(`user.category.${category}.enabled`) === true}>
                    {renderFieldRows(
                      localizedEntries().filter(
                        (entry) => entry.key.startsWith(`user.category.${category}.`) && !entry.key.endsWith(".enabled"),
                      ),
                    )}
                  </Show>
                </SettingsSection>
              ))}
            </Show>
            {renderFieldSections(genericEntries())}
            <Show when={props.signInLocations}>
              {(locations) => <SignInLocations initial={locations().status} actorId={locations().actorId} />}
            </Show>
          </>
        }
      >
        <AiSettingsPanel
          entries={localizedEntries()}
          valueOf={valueOf}
          errorFor={(key) => fieldErrors()[key]}
          onChange={setDraft}
          enrichmentOverview={props.aiEnrichmentOverview ?? null}
          backgroundTaskPrompts={props.backgroundTaskPrompts}
          section={props.aiSection ?? "general"}
          showJobsLink={props.showAiJobsLink}
        />
        <Show when={aiSection() !== "jobs"}>
          {renderFieldSections(genericEntries().filter((entry) => (aiSection() === "tools") === entry.key.startsWith("ai.openai_api_")))}
        </Show>
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

const sectionDefs = (
  t: ReturnType<typeof settingsMessages.resolve>["t"],
): Record<string, { title: string; subtitle: string; icon: string }> => ({
  "storage.connection": { title: t.connection, subtitle: t.storageConnectionDescription, icon: "ti ti-database" },
  "storage.limits": { title: t.limits, subtitle: t.storageLimitsDescription, icon: "ti ti-gauge" },
  "app.identity": {
    title: t.identity,
    subtitle: t.identityDescription,
    icon: "ti ti-id",
  },
  "app.branding": {
    title: t.branding,
    subtitle: t.brandingDescription,
    icon: "ti ti-photo",
  },
  "app.operations": {
    title: t.operations,
    subtitle: t.operationsDescription,
    icon: "ti ti-calendar-time",
  },
  "user.login": {
    title: t.login,
    subtitle: t.loginDescription,
    icon: "ti ti-login",
  },
  "user.registration": { title: t.registration, subtitle: t.registrationDescription, icon: "ti ti-user-plus" },
  "user.actionNotice": { title: t.actionNotice, subtitle: t.actionNoticeDescription, icon: "ti ti-note" },
  "user.appApproval": {
    title: t.appApproval,
    subtitle: t.appApprovalDescription,
    icon: "ti ti-device-mobile",
  },
  "user.expiry": {
    title: t.accountExpiry,
    subtitle: t.accountExpiryDescription,
    icon: "ti ti-hourglass",
  },
  "user.reminders": {
    title: t.remindersRetention,
    subtitle: t.remindersRetentionDescription,
    icon: "ti ti-bell",
  },
  "freeipa.connection": {
    title: t.connection,
    subtitle: t.freeIpaConnectionDescription,
    icon: "ti ti-server",
  },
  "freeipa.service": {
    title: t.serviceAccount,
    subtitle: t.serviceAccountDescription,
    icon: "ti ti-key",
  },
  "freeipa.groups": {
    title: t.groupMapping,
    subtitle: t.groupMappingDescription,
    icon: "ti ti-users-group",
  },
  "freeipa.sync": {
    title: t.syncPolicy,
    subtitle: t.syncPolicyDescription,
    icon: "ti ti-refresh",
  },
  "mail.templates": {
    title: t.templates,
    subtitle: t.templatesDescription,
    icon: "ti ti-template",
  },
  "gotenberg.connection": {
    title: t.connection,
    subtitle: t.gotenbergConnectionDescription,
    icon: "ti ti-server",
  },
  "gotenberg.limits": {
    title: t.limits,
    subtitle: t.limitsDescription,
    icon: "ti ti-gauge",
  },
  "security.rate-limits": {
    title: t.rateLimits,
    subtitle: t.rateLimitsDescription,
    icon: "ti ti-shield-lock",
  },
  default: {
    title: t.settings,
    subtitle: t.runtimeSettingsDescription,
    icon: "ti ti-settings",
  },
});

const sectionIdForEntry = (entry: SettingFieldDef): string => {
  if (entry.key === "storage.max_object_bytes") return "storage.limits";
  if (entry.key.startsWith("storage.")) return "storage.connection";
  if (entry.key === "app.logo" || entry.key === "app.favicon") return "app.branding";
  if (entry.key === "app.timezone" || entry.key === "app.cleanup_schedule") return "app.operations";
  if (entry.key.startsWith("app.")) return "app.identity";

  if (entry.key.startsWith("user.app_approval.")) return "user.appApproval";
  if (entry.key === "user.action_notice") return "user.actionNotice";
  if (
    entry.key === "user.allow_self_registration" ||
    entry.key === "user.local_email_optional" ||
    entry.key === "user.account_requests.enabled" ||
    entry.key === "user.abbr_length"
  )
    return "user.registration";
  if (entry.key === "user.session.expiry_hours") {
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

  if (entry.key.startsWith("gotenberg.max_") || entry.key === "gotenberg.timeout_ms") return "gotenberg.limits";
  if (entry.key.startsWith("gotenberg.")) return "gotenberg.connection";

  if (entry.key.startsWith("security.")) return "security.rate-limits";
  return "default";
};

const groupSettingEntries = (entries: SettingFieldDef[], t: ReturnType<typeof settingsMessages.resolve>["t"]): SettingSectionGroup[] => {
  const definitions = sectionDefs(t);
  const sections = new Map<string, SettingSectionGroup>();
  for (const entry of entries) {
    const id = sectionIdForEntry(entry);
    const def = definitions[id] ?? definitions.default!;
    if (!sections.has(id)) sections.set(id, { id, ...def, entries: [] });
    sections.get(id)!.entries.push(entry);
  }
  return [...sections.values()];
};

const sourceLabel = (source: SettingValueSource, t: ReturnType<typeof settingsMessages.resolve>["t"]) => {
  if (source === "custom") return t.customOverride;
  if (source === "env") return t.environmentFallback;
  return t.codeDefault;
};

const formatSettingPreview = (entry: SettingFieldDef, value: unknown, t: ReturnType<typeof settingsMessages.resolve>["t"]): string => {
  if (entry.kind === "secret") return entry.resetValueSource === "env" ? t.environmentFallbackHidden : t.emptySecret;
  if (entry.kind === "boolean") return value ? t.enabled : t.disabled;
  if (entry.kind === "image") return typeof value === "string" && value ? t.imageConfigured : t.noImage;
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : t.emptyList;
  if (value === "" || value === null || value === undefined) return t.empty;

  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return t.empty;
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
};

const asString = (value: unknown) => (typeof value === "string" ? value : "");

const formatAiDuration = (ms: number | null): string => {
  if (ms === null) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.round(ms / 60_000)}m`;
};

const formatAiDate = (value: string | null, locale: string): string => (value ? new Date(value).toLocaleString(locale) : "-");

const formatAiPercent = (value: number): string => `${value.toFixed(value >= 10 ? 0 : 1)}%`;

function AiEnrichmentOverviewPanel(props: { overview: AiEnrichmentOverview; showJobsLink?: boolean }) {
  const locale = useLocale();
  const t = () => aiSettingsMessages.resolve([locale()]).t;
  const statusClass = (status: string) => (status === "ok" ? "badge-success" : status === "failed" ? "badge-danger" : "badge-neutral");
  return (
    <div class="flex flex-col gap-2">
      <StatGrid columns={4} size="sm" surface="muted">
        <StatCell
          label={t().dirtyChats}
          value={props.overview.dirtyConversations}
          sub={t().oldest({ date: formatAiDate(props.overview.oldestDirtyAt, locale()) })}
        />
        <StatCell
          label={t().failedChats}
          value={props.overview.failedConversations}
          sub={t().activeTotal({ count: props.overview.totalConversations })}
        />
        <StatCell
          label={t().errorRate24h}
          value={formatAiPercent(props.overview.errorRate24h)}
          sub={t().failedRatio({ failed: props.overview.failedRuns24h, total: props.overview.totalRuns24h })}
          accent={props.overview.failedRuns24h > 0 ? { tone: "red", icon: "ti ti-alert-circle" } : undefined}
        />
        <StatCell
          label={t().averageRuntime}
          value={formatAiDuration(props.overview.avgDurationMs)}
          sub={t().lastRun({ date: formatAiDate(props.overview.lastRunAt, locale()) })}
        />
      </StatGrid>

      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs text-dimmed">{t().enrichmentTraceHint}</p>
        <div class="flex items-center gap-2">
          <RunEnrichmentButton />
          <Show when={props.showJobsLink}>
            <ButtonLink href="/admin/observability/jobs?search=ai%3Achat" variant="ai" size="sm">
              <i class="ti ti-external-link" /> {t().openJobs}
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
                  {run.trigger} · {formatAiDate(run.createdAt, locale())}
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
  const locale = useLocale();
  const t = () => aiSettingsMessages.resolve([locale()]).t;
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
      if (!response.ok || !body?.ok) throw new Error(body?.message ?? t().enrichmentFailed);
      const summary = body.summary;
      toast.success(summary ? t().enrichmentSummary(summary) : t().enrichmentDone);
      // The overview numbers are server-rendered — reload to reflect the run.
      window.location.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t().enrichmentFailed);
    } finally {
      setRunning(false);
    }
  };
  return (
    <Button type="button" variant="secondary" size="sm" loading={running()} loadingLabel={t().running} onClick={() => void run()}>
      <i class="ti ti-player-play" aria-hidden="true" />
      {t().runNow}
    </Button>
  );
}

function AiSettingsPanel(props: {
  entries: SettingFieldDef[];
  valueOf: (key: string) => unknown;
  errorFor: (key: string) => string | undefined;
  onChange: (key: string, value: unknown) => void;
  enrichmentOverview: AiEnrichmentOverview | null;
  backgroundTaskPrompts?: Record<string, string[]>;
  /** Names of stored extra headers per profile. The values stay server-side. */
  section: AiSection;
  showJobsLink?: boolean;
}) {
  const locale = useLocale();
  const t = () => aiSettingsMessages.resolve([locale()]).t;
  const promptViewer = (key: string, title: string) => (
    <Show when={props.backgroundTaskPrompts?.[key]}>
      {(texts) => (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-label={`${t().viewBuiltInPrompts}: ${title}`}
          onClick={() =>
            dialogCore.open<void>(
              (close) => (
                <PanelDialog>
                  <PanelDialog.Header title={title} subtitle={t().builtInPromptsDescription} icon="ti ti-file-text" close={close} />
                  <PanelDialog.Body>
                    <For each={texts()}>
                      {(text, index) => (
                        <PanelDialog.Section
                          title={texts().length > 1 ? (index() === 0 ? t().turnLearningPrompt : t().workflowLearningPrompt) : title}
                          icon="ti ti-file-text"
                        >
                          <pre class="whitespace-pre-wrap break-words text-sm">{text}</pre>
                        </PanelDialog.Section>
                      )}
                    </For>
                  </PanelDialog.Body>
                </PanelDialog>
              ),
              panelDialogWideOptions,
            )
          }
        >
          {t().viewBuiltInPrompts}
        </Button>
      )}
    </Show>
  );
  const entry = (key: string) => props.entries.find((item) => item.key === key);
  const firecrawlKeyConfigured = () => (entry(AI_FIRECRAWL_API_KEY_SETTING_KEY)?.valueSource ?? "default") !== "default";
  const maxToolResultChars = () => {
    const value = Number(props.valueOf(AI_MAX_TOOL_RESULT_CHARS_SETTING_KEY));
    return Number.isFinite(value) && value > 0 ? value : 8000;
  };

  return (
    <div class="flex flex-col gap-2">
      <Show when={props.section === "general"}>
        <SettingsSection title={t().cloudAi} subtitle={t().cloudAiDescription} icon="ti ti-sparkles">
          <div class="flex flex-col gap-2">
            <Switch
              label={props.valueOf(AI_ENABLED_SETTING_KEY) ? t().aiEnabled : t().aiDisabled}
              value={() => Boolean(props.valueOf(AI_ENABLED_SETTING_KEY))}
              onValueChange={(value) => props.onChange(AI_ENABLED_SETTING_KEY, value)}
            />
            <p class="text-xs text-dimmed">{t().aiAvailability}</p>
          </div>

          <div class="flex flex-col gap-1.5">
            <div>
              <p class="text-sm font-medium text-primary">{t().globalInstructions}</p>
              <p class="text-xs text-dimmed">{t().globalInstructionsDescription}</p>
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
              {t().showPlatformPrompt}
            </summary>
            <div class="mt-2 flex flex-col gap-1.5">
              <p class="text-xs text-dimmed">{t().platformPromptDescription}</p>
              <pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-2.5 font-mono text-[11px] leading-relaxed text-zinc-700 [box-shadow:var(--ui-control-recess)] dark:bg-zinc-900 dark:text-zinc-300">
                {AI_PLATFORM_PROMPT_TEMPLATE}
              </pre>
            </div>
          </details>

          <TextInput
            variant="ai"
            multiline
            lines={10}
            label={t().localClientInstructions}
            description={t().localClientInstructionsDescription}
            value={() => asString(props.valueOf(AI_LOCAL_CLIENT_INSTRUCTIONS_SETTING_KEY))}
            onValueChange={(value) => props.onChange(AI_LOCAL_CLIENT_INSTRUCTIONS_SETTING_KEY, value)}
            placeholder={AI_LOCAL_CLIENT_DEFAULT_INSTRUCTIONS}
            error={() => props.errorFor(AI_LOCAL_CLIENT_INSTRUCTIONS_SETTING_KEY)}
          />
          <details class="group">
            <summary class="flex cursor-pointer select-none items-center gap-1.5 text-xs font-medium text-secondary hover:text-primary">
              <i class="ti ti-chevron-right transition-transform group-open:rotate-90" aria-hidden="true" />
              {t().showLocalClientInstructions}
            </summary>
            <div class="mt-2 flex flex-col gap-1.5">
              <p class="text-xs text-dimmed">{t().localClientBuiltInDescription}</p>
              <pre class="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-2.5 font-mono text-[11px] leading-relaxed text-zinc-700 [box-shadow:var(--ui-control-recess)] dark:bg-zinc-900 dark:text-zinc-300">
                {AI_LOCAL_CLIENT_DEFAULT_INSTRUCTIONS}
              </pre>
            </div>
          </details>
        </SettingsSection>

        <SettingsSection title={t().context} subtitle={t().contextDescription} icon="ti ti-package">
          <NumberInput
            label={t().turnTimeout}
            description={t().turnTimeoutDescription}
            value={() => Number(props.valueOf("ai.turn_timeout_minutes") ?? 30) || null}
            onValueChange={(value) => props.onChange("ai.turn_timeout_minutes", value ?? 0)}
            min={0}
            showSteppers={false}
            error={() => props.errorFor("ai.turn_timeout_minutes")}
          />
          <NumberInput
            label={t().toolResultCeiling}
            description={t().toolResultCeilingDescription}
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
        <SettingsSection title={t().backgroundJobs} subtitle={t().backgroundJobsDescription} icon="ti ti-clock-bolt">
          <TextInput
            label={t().chatEnrichmentSchedule}
            description={t().chatEnrichmentScheduleDescription}
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
            label={t().chatEnrichmentInstructions}
            description={t().chatEnrichmentInstructionsDescription}
            value={() => asString(props.valueOf(AI_CHAT_ENRICHMENT_INSTRUCTIONS_SETTING_KEY))}
            onValueChange={(value) => props.onChange(AI_CHAT_ENRICHMENT_INSTRUCTIONS_SETTING_KEY, value)}
            placeholder={t().chatEnrichmentPlaceholder}
            error={() => props.errorFor(AI_CHAT_ENRICHMENT_INSTRUCTIONS_SETTING_KEY)}
          />
          {promptViewer(AI_CHAT_ENRICHMENT_INSTRUCTIONS_SETTING_KEY, t().chatEnrichmentInstructions)}

          <TextInput
            label={t().personalizationSchedule}
            description={t().personalizationScheduleDescription}
            value={() => asString(props.valueOf(AI_MEMORY_LEARNING_CRON_SETTING_KEY))}
            onValueChange={(value) => props.onChange(AI_MEMORY_LEARNING_CRON_SETTING_KEY, value)}
            placeholder="*/10 * * * *"
            monospace
            error={() => props.errorFor(AI_MEMORY_LEARNING_CRON_SETTING_KEY)}
          />

          <NumberInput
            label={t().monthlyBudget}
            description={t().monthlyBudgetDescription}
            value={() => Number(props.valueOf(AI_MEMORY_LEARNING_MONTHLY_TOKEN_BUDGET_SETTING_KEY) ?? 100000)}
            onValueChange={(value) => props.onChange(AI_MEMORY_LEARNING_MONTHLY_TOKEN_BUDGET_SETTING_KEY, value ?? 100000)}
            min={10000}
            max={10000000}
            showSteppers={false}
            error={() => props.errorFor(AI_MEMORY_LEARNING_MONTHLY_TOKEN_BUDGET_SETTING_KEY)}
          />

          <TextInput
            variant="ai"
            multiline
            lines={4}
            label={t().personalizationInstructions}
            description={t().personalizationInstructionsDescription}
            value={() => asString(props.valueOf(AI_MEMORY_LEARNING_INSTRUCTIONS_SETTING_KEY))}
            onValueChange={(value) => props.onChange(AI_MEMORY_LEARNING_INSTRUCTIONS_SETTING_KEY, value)}
            placeholder={t().personalizationPlaceholder}
            error={() => props.errorFor(AI_MEMORY_LEARNING_INSTRUCTIONS_SETTING_KEY)}
          />
          {promptViewer(AI_MEMORY_LEARNING_INSTRUCTIONS_SETTING_KEY, t().personalizationInstructions)}

          <TextInput
            variant="ai"
            multiline
            lines={4}
            label={t().compactionInstructions}
            description={t().compactionInstructionsDescription}
            value={() => asString(props.valueOf(AI_COMPACTION_INSTRUCTIONS_SETTING_KEY))}
            onValueChange={(value) => props.onChange(AI_COMPACTION_INSTRUCTIONS_SETTING_KEY, value)}
            placeholder={t().compactionPlaceholder}
            error={() => props.errorFor(AI_COMPACTION_INSTRUCTIONS_SETTING_KEY)}
          />
          {promptViewer(AI_COMPACTION_INSTRUCTIONS_SETTING_KEY, t().compactionInstructions)}

          <Show when={props.enrichmentOverview}>
            {(overview) => <AiEnrichmentOverviewPanel overview={overview()} showJobsLink={props.showJobsLink} />}
          </Show>
        </SettingsSection>
      </Show>

      <Show when={props.section === "tools"}>
        <SettingsSection title={t().webTools} subtitle={t().webToolsDescription} icon="ti ti-world-search">
          <TextInput
            variant="ai"
            label={t().firecrawlKey}
            description={firecrawlKeyConfigured() ? t().firecrawlConfigured : t().firecrawlDescription}
            value={() => asString(props.valueOf(AI_FIRECRAWL_API_KEY_SETTING_KEY))}
            onValueChange={(value) => props.onChange(AI_FIRECRAWL_API_KEY_SETTING_KEY, value)}
            placeholder={firecrawlKeyConfigured() ? t().keepCurrentKey : (entry(AI_FIRECRAWL_API_KEY_SETTING_KEY)?.placeholder ?? "fc-...")}
            password
            error={() => props.errorFor(AI_FIRECRAWL_API_KEY_SETTING_KEY)}
          />
        </SettingsSection>
      </Show>
    </div>
  );
}

const AI_PROMPT_TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  { name: "user.displayName" },
  { name: "user.uid" },
  { name: "user.mail", kind: "email" },
  { name: "chatId" },
  { name: "now" },
  { name: "today" },
  { name: "time" },
];

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
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const e = () => props.entry;

  return (
    <div class="flex flex-col gap-2 rounded-lg px-3 py-2" classList={{ "bg-amber-50/50 dark:bg-amber-950/20": props.changed() }}>
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-sm font-medium text-primary">{e().label}</h3>
            <code class="text-[10px] text-dimmed">{e().key}</code>
            <Show when={props.changed()}>
              <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" title={t().unsavedChange} />
            </Show>
            <Show when={!e().unreadable} fallback={<UnreadableSettingBadge />}>
              <span
                class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                  e().valueSource === "custom"
                    ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                    : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                }`}
              >
                {sourceLabel(e().valueSource, t())}
              </span>
            </Show>
            <Show when={props.resetPending()}>
              <span class="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                {t().defaultStaged}
              </span>
            </Show>
          </div>
          <p id={`${settingControlId(e().key)}-description`} class="mt-1 text-xs text-dimmed">
            {e().description}
          </p>
          <p class="mt-1 text-[11px] text-dimmed">
            {t().useDefaultPreview} <span class="font-medium text-secondary">{formatSettingPreview(e(), e().resetValue, t())}</span>
            <span class="text-dimmed"> ({sourceLabel(e().resetValueSource, t()).toLowerCase()})</span>
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <Tooltip.Anchor content={t().defaultStageHint}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={props.onUseDefault}
              disabled={!props.canUseDefault()}
              aria-label={t().useDefaultFor({ label: e().label })}
            >
              <i class="ti ti-arrow-back-up" /> {t().useDefault}
            </Button>
          </Tooltip.Anchor>
        </div>
      </div>

      <FieldInput entry={e()} value={props.value} error={props.error} onChange={props.onChange} />
    </div>
  );
}
