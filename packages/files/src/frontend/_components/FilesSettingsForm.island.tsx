/**
 * Bespoke admin form for files.* settings — app-files-internal island.
 *
 * Hand-coded form (8 fields) instead of dynamic dispatch. Bulk-PUTs to the
 * app's own /api/files/admin/settings endpoint.
 */

import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  prompts,
  readSettingsError,
  SettingsField,
  SettingsPage,
  SettingsPanelFooter,
  SettingsSection,
  sameSettingValue,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import { filesMessages } from "../messages";

type Initial = {
  "files.filegate_url": string;
  "files.filegate_token": string;
  "files.base_homes": string;
  "files.base_groups": string;
  "files.home_dir_mode": string;
  "files.home_file_mode": string;
  "files.group_dir_mode": string;
  "files.group_file_mode": string;
};

type Props = { initial: Initial };

export default function FilesSettingsForm(props: Props) {
  const locale = useLocale();
  const t = () => filesMessages.resolve([locale()]).t;
  const [draft, setDraft] = createSignal<Initial>({ ...props.initial });
  const [fieldErrors, setFieldErrors] = createSignal<Record<string, string>>({});

  const update = <K extends keyof Initial>(key: K, value: Initial[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _, ...rest } = prev;
      return rest;
    });
  };

  const changedKeys = createMemo<Array<keyof Initial>>(() => {
    const d = draft();
    return (Object.keys(props.initial) as Array<keyof Initial>).filter((k) => !sameSettingValue(d[k], props.initial[k]));
  });
  const hasChanges = () => changedKeys().length > 0;

  if (typeof window !== "undefined") {
    window.onbeforeunload = () => (hasChanges() ? "" : null);
  }

  const save = mutations.create<void, void>({
    mutation: async () => {
      const updates: Record<string, string> = {};
      for (const k of changedKeys()) updates[k as string] = draft()[k];
      const response = await apiClient.admin.settings.$put({ json: updates });
      if (!response.ok) {
        const { fields } = await readSettingsError(response, t().settingsSaveFailed);
        setFieldErrors(fields);
        throw new Error(t().settingsSaveFailed);
      }
    },
    onSuccess: () => {
      window.onbeforeunload = null;
      toast.success(t().settingsSaved);
      refreshCurrentPath();
    },
    onError: (e) => prompts.error(e.message),
  });

  const discardAll = () => {
    setDraft({ ...props.initial });
    setFieldErrors({});
  };

  const isChanged = (key: keyof Initial) => !sameSettingValue(draft()[key], props.initial[key]);

  return (
    <SettingsPage
      style="view-transition-name: admin-files-settings"
      title={t().files}
      subtitle={t().settingsSubtitle}
      icon="ti ti-folder"
      scrollPreserveKey="files-admin"
      footer={
        <SettingsPanelFooter
          changeCount={() => changedKeys().length}
          loading={() => save.loading()}
          onDiscard={discardAll}
          onSave={() => save.mutate()}
        />
      }
    >
      <SettingsSection title="Filegate" subtitle={t().filegateSubtitle} icon="ti ti-server">
        <p class="text-xs text-dimmed">{t().filegateBody}</p>
        <SettingsField
          label={t().filegateUrl}
          description={t().filegateUrlDescription}
          error={() => fieldErrors()["files.filegate_url"]}
          changed={() => isChanged("files.filegate_url")}
        >
          <TextInput
            value={() => draft()["files.filegate_url"]}
            onValueChange={(v) => update("files.filegate_url", v)}
            placeholder={t().filegateUrlExample}
            type="url"
          />
        </SettingsField>

        <SettingsField
          label={t().filegateToken}
          description={t().filegateTokenDescription}
          error={() => fieldErrors()["files.filegate_token"]}
          changed={() => isChanged("files.filegate_token")}
        >
          <TextInput
            value={() => draft()["files.filegate_token"]}
            onValueChange={(v) => update("files.filegate_token", v)}
            password
            placeholder={t().keepCurrent}
          />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title={t().basePaths} subtitle={t().basePathsSubtitle} icon="ti ti-folders">
        <SettingsField
          label={t().baseHomes}
          description={t().baseHomesDescription}
          error={() => fieldErrors()["files.base_homes"]}
          changed={() => isChanged("files.base_homes")}
        >
          <TextInput
            value={() => draft()["files.base_homes"]}
            onValueChange={(v) => update("files.base_homes", v)}
            placeholder={t().homePathExample}
          />
        </SettingsField>

        <SettingsField
          label={t().baseGroups}
          description={t().baseGroupsDescription}
          error={() => fieldErrors()["files.base_groups"]}
          changed={() => isChanged("files.base_groups")}
        >
          <TextInput
            value={() => draft()["files.base_groups"]}
            onValueChange={(v) => update("files.base_groups", v)}
            placeholder={t().groupPathExample}
          />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title={t().unixPermissions} subtitle={t().unixPermissionsSubtitle} icon="ti ti-lock">
        <p class="text-xs text-dimmed">{t().unixBody}</p>
        <SettingsField
          label={t().homeDirMode}
          description={t().homeDirModeDescription}
          error={() => fieldErrors()["files.home_dir_mode"]}
          changed={() => isChanged("files.home_dir_mode")}
        >
          <TextInput
            value={() => draft()["files.home_dir_mode"]}
            onValueChange={(v) => update("files.home_dir_mode", v)}
            placeholder="700"
          />
        </SettingsField>

        <SettingsField
          label={t().homeFileMode}
          description={t().homeFileModeDescription}
          error={() => fieldErrors()["files.home_file_mode"]}
          changed={() => isChanged("files.home_file_mode")}
        >
          <TextInput
            value={() => draft()["files.home_file_mode"]}
            onValueChange={(v) => update("files.home_file_mode", v)}
            placeholder="600"
          />
        </SettingsField>

        <SettingsField
          label={t().groupDirMode}
          description={t().groupDirModeDescription}
          error={() => fieldErrors()["files.group_dir_mode"]}
          changed={() => isChanged("files.group_dir_mode")}
        >
          <TextInput
            value={() => draft()["files.group_dir_mode"]}
            onValueChange={(v) => update("files.group_dir_mode", v)}
            placeholder="2770"
          />
        </SettingsField>

        <SettingsField
          label={t().groupFileMode}
          description={t().groupFileModeDescription}
          error={() => fieldErrors()["files.group_file_mode"]}
          changed={() => isChanged("files.group_file_mode")}
        >
          <TextInput
            value={() => draft()["files.group_file_mode"]}
            onValueChange={(v) => update("files.group_file_mode", v)}
            placeholder="660"
          />
        </SettingsField>
      </SettingsSection>
    </SettingsPage>
  );
}
