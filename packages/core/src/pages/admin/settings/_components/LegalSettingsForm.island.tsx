/**
 * Legal-documents admin form.
 *
 * Edits the 9 `legal.<kind>.{mode,content,url}` settings (3 kinds: terms,
 * privacy, imprint) in one bulk-PUT to `/api/admin/core/settings`.
 *
 * Layout: one section per legal page. The Content textarea and URL
 * input show/hide based on the mode toggle to keep the form scannable.
 */

import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  prompts,
  readSettingsError,
  Select,
  SettingsPage,
  SettingsPanelFooter,
  SettingsSection,
  sameSettingValue,
  TextInput,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import { coreClient } from "@valentinkolb/cloud/clients/core";
import type { SettingValueSource } from "@valentinkolb/cloud/contracts";
import { createMemo, createSignal, type JSX, Show } from "solid-js";
import type { SettingFieldDef } from "./CoreSettingsForm.island";
import { settingsMessages } from "./messages";

type LegalKind = "terms" | "privacy" | "imprint";
type LegalMode = "local" | "external";

const kinds = (
  t: ReturnType<typeof settingsMessages.resolve>["t"],
): ReadonlyArray<{ id: LegalKind; label: string; description: string; icon: string; path: string }> => [
  {
    id: "terms",
    label: t.terms,
    description: t.termsDescription,
    icon: "ti ti-file-text",
    path: "/legal/terms",
  },
  {
    id: "privacy",
    label: t.privacy,
    description: t.privacyDescription,
    icon: "ti ti-shield-lock",
    path: "/legal/privacy",
  },
  {
    id: "imprint",
    label: t.imprint,
    description: t.imprintDescription,
    icon: "ti ti-info-circle",
    path: "/impressum",
  },
];

const modeOptions = (t: ReturnType<typeof settingsMessages.resolve>["t"]) => [
  { id: "local", value: "local", label: t.localContent },
  { id: "external", value: "external", label: t.externalUrl },
];

export type LegalInitial = {
  "legal.terms.mode": LegalMode;
  "legal.terms.content": string;
  "legal.terms.url": string;
  "legal.privacy.mode": LegalMode;
  "legal.privacy.content": string;
  "legal.privacy.url": string;
  "legal.imprint.mode": LegalMode;
  "legal.imprint.content": string;
  "legal.imprint.url": string;
};

type Props = {
  title: string;
  subtitle: string;
  icon: string;
  initial: LegalInitial;
  entries: SettingFieldDef[];
};

export default function LegalSettingsForm(props: Props) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const [draft, setDraft] = createSignal<LegalInitial>({ ...props.initial });
  const [resetKeys, setResetKeys] = createSignal<Record<string, true>>({});
  const [fieldErrors, setFieldErrors] = createSignal<Record<string, string>>({});

  const entryMap = createMemo(() => {
    const entries: Partial<Record<keyof LegalInitial, SettingFieldDef>> = {};
    for (const entry of props.entries) entries[entry.key as keyof LegalInitial] = entry;
    return entries;
  });

  const clearFieldError = (key: keyof LegalInitial) => {
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  const update = <K extends keyof LegalInitial>(key: K, value: LegalInitial[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setResetKeys((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _, ...rest } = prev;
      return rest;
    });
    clearFieldError(key);
  };

  const resetValueFor = <K extends keyof LegalInitial>(key: K): LegalInitial[K] => {
    const value = entryMap()[key]?.resetValue;
    if (key.endsWith(".mode")) return (value === "external" ? "external" : "local") as LegalInitial[K];
    return (typeof value === "string" ? value : "") as LegalInitial[K];
  };

  const stageDefault = <K extends keyof LegalInitial>(key: K) => {
    setDraft((prev) => ({ ...prev, [key]: resetValueFor(key) }));
    setResetKeys((prev) => ({ ...prev, [key]: true }));
    clearFieldError(key);
  };

  const resetKeyList = createMemo(() => Object.keys(resetKeys()) as Array<keyof LegalInitial>);
  const isResetPending = (key: keyof LegalInitial) => key in resetKeys();

  const isChanged = (key: keyof LegalInitial) => isResetPending(key) || !sameSettingValue(draft()[key], props.initial[key]);

  const canUseDefault = (key: keyof LegalInitial) => {
    const entry = entryMap()[key];
    if (!entry || isResetPending(key)) return false;
    return (
      entry.isCustom || !sameSettingValue(draft()[key], resetValueFor(key)) || !sameSettingValue(props.initial[key], resetValueFor(key))
    );
  };

  const changedKeys = createMemo<Array<keyof LegalInitial>>(() => {
    const d = draft();
    const keys = new Set<keyof LegalInitial>(resetKeyList());
    for (const k of Object.keys(props.initial) as Array<keyof LegalInitial>) {
      if (!sameSettingValue(d[k], props.initial[k])) keys.add(k);
    }
    return [...keys];
  });
  const hasChanges = () => changedKeys().length > 0;

  if (typeof window !== "undefined") {
    window.onbeforeunload = () => (hasChanges() ? "" : null);
  }

  const save = mutations.create<void, void>({
    mutation: async () => {
      const resets = resetKeyList().filter((key) => changedKeys().includes(key));
      const updates: Record<string, unknown> = {};
      for (const k of changedKeys()) {
        if (!resets.includes(k)) updates[k] = draft()[k];
      }
      const response = await coreClient.admin.core.settings.$put({ json: resets.length > 0 ? { updates, resets } : updates });
      if (!response.ok) {
        const { message, fields } = await readSettingsError(response, t().saveFailed({ status: response.status }));
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

  const discardAll = () => {
    setDraft({ ...props.initial });
    setResetKeys({});
    setFieldErrors({});
  };

  return (
    <SettingsPage
      title={props.title}
      subtitle={props.subtitle}
      icon={props.icon}
      footer={
        <SettingsPanelFooter
          changeCount={() => changedKeys().length}
          loading={() => save.loading()}
          onDiscard={discardAll}
          onSave={() => save.mutate()}
        />
      }
    >
      {kinds(t()).map((kind) => {
        const modeKey = `legal.${kind.id}.mode` as const;
        const contentKey = `legal.${kind.id}.content` as const;
        const urlKey = `legal.${kind.id}.url` as const;
        const currentMode = () => draft()[modeKey];

        return (
          <SettingsSection
            title={kind.label}
            subtitle={kind.description}
            icon={kind.icon}
            actions={
              <ButtonLink href={kind.path} target="_blank" variant="secondary" size="sm" rel="noreferrer">
                <i class="ti ti-external-link" /> {t().open}
              </ButtonLink>
            }
          >
            <LegalField
              label={t().source}
              description={t().sourceDescription}
              entry={entryMap()[modeKey]}
              error={() => fieldErrors()[modeKey]}
              changed={() => isChanged(modeKey)}
              resetPending={() => isResetPending(modeKey)}
              canUseDefault={() => canUseDefault(modeKey)}
              onUseDefault={() => stageDefault(modeKey)}
            >
              <Select
                value={() => currentMode()}
                onValueChange={(value) => value !== null && update(modeKey, value as LegalMode)}
                options={modeOptions(t())}
              />
            </LegalField>

            <Show when={currentMode() === "local"}>
              <LegalField
                label={t().content}
                description={t().contentDescription}
                entry={entryMap()[contentKey]}
                error={() => fieldErrors()[contentKey]}
                changed={() => isChanged(contentKey)}
                resetPending={() => isResetPending(contentKey)}
                canUseDefault={() => canUseDefault(contentKey)}
                onUseDefault={() => stageDefault(contentKey)}
              >
                <TextInput
                  multiline
                  value={() => draft()[contentKey]}
                  onValueChange={(v) => update(contentKey, v)}
                  placeholder={`# ${kind.label}\n\n...`}
                />
              </LegalField>
            </Show>

            <Show when={currentMode() === "external"}>
              <LegalField
                label="URL"
                description={t().urlDescription}
                entry={entryMap()[urlKey]}
                error={() => fieldErrors()[urlKey]}
                changed={() => isChanged(urlKey)}
                resetPending={() => isResetPending(urlKey)}
                canUseDefault={() => canUseDefault(urlKey)}
                onUseDefault={() => stageDefault(urlKey)}
              >
                <TextInput
                  type="url"
                  value={() => draft()[urlKey]}
                  onValueChange={(v) => update(urlKey, v)}
                  placeholder="https://example.org/..."
                />
              </LegalField>
            </Show>
          </SettingsSection>
        );
      })}
    </SettingsPage>
  );
}

const legalSourceLabel = (source: SettingValueSource, t: ReturnType<typeof settingsMessages.resolve>["t"]) => {
  if (source === "custom") return t.customOverride;
  if (source === "env") return t.environmentFallback;
  return t.codeDefault;
};

const legalResetPreview = (entry: SettingFieldDef | undefined, empty: string) => {
  const value = entry?.resetValue;
  if (value === "" || value === null || value === undefined) return empty;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
};

function LegalField(props: {
  label: string;
  description: string;
  entry: SettingFieldDef | undefined;
  error: () => string | undefined;
  changed: () => boolean;
  resetPending: () => boolean;
  canUseDefault: () => boolean;
  onUseDefault: () => void;
  children: JSX.Element;
}) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  return (
    <div class="flex flex-col gap-2 rounded-lg px-3 py-2" classList={{ "bg-amber-50/50 dark:bg-amber-950/20": props.changed() }}>
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-sm font-medium text-primary">{props.label}</h3>
            <Show when={props.entry}>
              {(entry) => (
                <>
                  <code class="text-[10px] text-dimmed">{entry().key}</code>
                  <span
                    class={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      entry().valueSource === "custom"
                        ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                        : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                    }`}
                  >
                    {legalSourceLabel(entry().valueSource, t())}
                  </span>
                </>
              )}
            </Show>
            <Show when={props.resetPending()}>
              <span class="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                {t().defaultStaged}
              </span>
            </Show>
          </div>
          <p class="mt-1 text-xs text-dimmed">{props.description}</p>
          <Show when={props.entry}>
            {(entry) => (
              <p class="mt-1 text-[11px] text-dimmed">
                {t().useDefaultPreview} <span class="font-medium text-secondary">{legalResetPreview(entry(), t().empty)}</span>
                <span class="text-dimmed"> ({legalSourceLabel(entry().resetValueSource, t()).toLowerCase()})</span>
              </p>
            )}
          </Show>
        </div>
        <Tooltip.Anchor content={t().defaultStageHint}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            class="shrink-0"
            onClick={props.onUseDefault}
            disabled={!props.canUseDefault()}
          >
            <i class="ti ti-arrow-back-up" /> {t().useDefault}
          </Button>
        </Tooltip.Anchor>
      </div>
      {props.children}
      <Show when={props.error()}>
        <p class="flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
          <i class="ti ti-alert-circle text-xs" /> {props.error()}
        </p>
      </Show>
    </div>
  );
}
