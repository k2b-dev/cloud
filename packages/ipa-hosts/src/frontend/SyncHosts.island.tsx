import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import { hostMessages } from "./messages";

const SyncHosts = () => {
  const locale = useLocale();
  const t = () => hostMessages.resolve([locale()]).t;
  const mutation = mutations.create<void, void>({
    mutation: async () => {
      const response = await apiClient.sync.$post();
      if (!response.ok) {
        throw new Error(t().failedStartSync);
      }
    },
    onSuccess: async () => {
      const showLogs = await prompts.confirm(t().syncStartedBody, {
        title: t().syncStarted,
        icon: "ti ti-refresh",
        confirmText: t().showLogs,
        cancelText: t().stayHere,
      });
      if (showLogs) {
        navigateTo("/admin/observability/logs?source=ipa-hosts:sync");
      }
    },
    onError: (error) => prompts.error(error.message),
  });

  const handleClick = async () => {
    const confirmed = await prompts.confirm(t().syncConfirm, {
      title: t().runSync,
      icon: "ti ti-refresh",
      confirmText: t().startSync,
      cancelText: t().cancel,
    });
    if (confirmed) {
      await mutation.mutate();
    }
  };

  return (
    <Button size="sm" variant="secondary" onClick={handleClick} loading={mutation.loading()} loadingLabel={t().startingSync}>
      <i class="ti ti-refresh" aria-hidden="true" />
      {t().syncNow}
    </Button>
  );
};

export default SyncHosts;
