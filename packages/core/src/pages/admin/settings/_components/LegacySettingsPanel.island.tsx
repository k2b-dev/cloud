import { mutation } from "@k2b/stdlib/solid";
import { Button, DataTable, type DataTableColumn, Placeholder, prompts, SettingsSection, toast, useLocale } from "@k2b/ui";
import { coreClient } from "@valentinkolb/cloud/clients/core";
import { formatDateTime as formatDate } from "@valentinkolb/cloud/shared";
import { createResource, Show } from "solid-js";
import { settingsMessages } from "./messages";

type LegacySetting = {
  key: string;
  updatedAt: string | null;
  decryptable: boolean;
};

const errorMessage = async (response: Response, fallback: string): Promise<string> => {
  const data = (await response.json().catch(() => null)) as { message?: string } | null;
  return data?.message ?? fallback;
};

const loadLegacySettings = async (fallback: string): Promise<LegacySetting[]> => {
  const response = await coreClient.admin.core.settings.legacy.$get();
  if (!response.ok) throw new Error(await errorMessage(response, fallback));
  return response.json();
};

const columns = (t: ReturnType<typeof settingsMessages.resolve>["t"]): DataTableColumn<LegacySetting>[] => [
  { id: "key", header: t.key, value: (row) => row.key },
  {
    id: "status",
    header: t.status,
    value: (row) => row.decryptable,
    headerClass: "w-px text-center whitespace-nowrap",
    cellClass: "w-px text-center whitespace-nowrap",
  },
  {
    id: "updated",
    header: t.updated,
    value: (row) => row.updatedAt,
    headerClass: "w-px text-right",
    cellClass: "w-px text-right whitespace-nowrap",
  },
];

export function LegacySettingsSection() {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const [legacySettings, { refetch }] = createResource(() => loadLegacySettings(t().loadLegacyFailed));

  const cleanup = mutation.create<{ deleted: string[] }, void>({
    mutation: async () => {
      const items = legacySettings() ?? [];
      if (items.length === 0) return { deleted: [] };
      const confirmed = await prompts.confirm(t().cleanUpConfirm({ count: items.length }), {
        title: t().cleanUpLegacySettings,
        icon: "ti ti-trash",
        variant: "danger",
        confirmText: t().cleanUp,
      });
      if (!confirmed) return { deleted: [] };

      const response = await coreClient.admin.core.settings.legacy.$delete();
      if (!response.ok) throw new Error(await errorMessage(response, t().cleanUpFailed));
      return response.json();
    },
    onSuccess: (result) => {
      if (result.deleted.length > 0) toast.success(t().legacyDeleted({ count: result.deleted.length }));
      void refetch();
    },
    onError: (error) => prompts.error(error.message),
  });

  return (
    <SettingsSection
      title={t().legacySettings}
      subtitle={t().legacySettingsDescription}
      icon="ti ti-database-off"
      actions={
        <Button
          type="button"
          variant="secondary"
          size="sm"
          class="shrink-0"
          onClick={() => void cleanup.mutate()}
          loading={cleanup.loading()}
          loadingLabel={t().cleaningUp}
          disabled={legacySettings.loading || (legacySettings()?.length ?? 0) === 0}
        >
          <i class={`ti ${cleanup.loading() ? "ti-loader-2 animate-spin" : "ti-trash"} text-sm`} />
          {t().cleanUp}
        </Button>
      }
    >
      <Show when={!legacySettings.loading} fallback={<Placeholder state="loading" align="left" title={t().loadingLegacySettings} />}>
        <DataTable
          rows={legacySettings() ?? []}
          columns={columns(t())}
          getRowId={(row) => row.key}
          density="compact"
          hoverRows
          highlightColumns={false}
          class="overflow-x-auto"
          tableClass="w-full text-xs"
          empty={t().noLegacySettings}
          renderCell={({ row, col }) => {
            if (col.id === "key") return <code class="text-[10px] text-primary">{row.key}</code>;
            if (col.id === "status") {
              return row.decryptable ? (
                <span class="mx-auto inline-flex rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                  {t().unregistered}
                </span>
              ) : (
                <span class="mx-auto inline-flex rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-500">
                  {t().unreadable}
                </span>
              );
            }
            if (col.id === "updated")
              return <span class="text-[10px] tabular-nums text-dimmed">{formatDate(row.updatedAt, { locale: locale() })}</span>;
            return "";
          }}
        />
      </Show>
    </SettingsSection>
  );
}

export default function LegacySettingsPanel() {
  return <LegacySettingsSection />;
}
