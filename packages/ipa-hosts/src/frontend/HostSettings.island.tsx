import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts, toast, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { hostMessages } from "./messages";

const HostSettings = () => {
  const locale = useLocale();
  const t = () => hostMessages.resolve([locale()]).t;
  const saveMutation = mutations.create<void, string>({
    mutation: async (cron) => {
      const response = await apiClient.settings["sync-cron"].$put({ json: { cron } });
      if (!response.ok) {
        throw new Error(t().failedSaveSchedule);
      }
    },
    onSuccess: () => toast.success(t().scheduleUpdated),
    onError: (error) => prompts.error(error.message),
  });

  const handleSettings = async () => {
    const response = await apiClient.settings["sync-cron"].$get();
    let current = "*/5 * * * *";
    let timezone = "Europe/Berlin";
    if (response.ok) {
      const data = await response.json();
      current = data.cron;
      timezone = data.timezone;
    } else {
      prompts.error(t().scheduleLoadFailed);
    }

    const result = await prompts.form({
      title: t().syncSettings,
      icon: "ti ti-settings",
      confirmText: t().save,
      fields: {
        sync_cron: {
          type: "text" as const,
          label: t().syncSchedule,
          description: t().syncScheduleDescription({ timezone }),
          default: current,
          required: true,
          placeholder: "*/5 * * * *",
        },
      },
    });

    if (!result) return;
    await saveMutation.mutate(result.sync_cron);
  };

  return (
    <Button size="sm" variant="secondary" onClick={handleSettings} loading={saveMutation.loading()} loadingLabel={t().savingSettings}>
      <i class="ti ti-settings" aria-hidden="true" />
      {t().settings}
    </Button>
  );
};

export default HostSettings;
