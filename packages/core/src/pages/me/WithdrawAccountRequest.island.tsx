import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts, useLocale } from "@k2b/ui";
import { apiClient } from "@valentinkolb/cloud/clients/core";
import { accountMessages } from "./messages";

export default function WithdrawAccountRequest() {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const mutation = mutations.create<void, void>({
    mutation: async () => {
      const res = await apiClient.me["account-request"].$delete();
      if (!res.ok) {
        throw new Error(t().withdrawFailed);
      }
    },
    onSuccess: () => window.location.reload(),
    onError: (err) => prompts.error(err.message),
  });

  const handleClick = async () => {
    const confirmed = await prompts.confirm(t().withdrawConfirm, {
      title: t().withdrawRequest,
      icon: "ti ti-x",
      confirmText: t().withdraw,
      cancelText: t().cancel,
      variant: "danger",
    });

    if (confirmed) {
      await mutation.mutate();
    }
  };

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={handleClick}
      loading={mutation.loading()}
      loadingLabel={t().withdrawing}
      class="leading-none"
    >
      {mutation.loading() ? <i class="ti ti-loader-2 animate-spin text-sm" /> : <i class="ti ti-x text-sm" />}
      {t().withdrawRequest}
    </Button>
  );
}
