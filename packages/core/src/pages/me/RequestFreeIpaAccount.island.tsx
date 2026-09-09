import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, NoticeCard, prompts, useLocale } from "@k2b/ui";
import { apiClient } from "@k2b/cloud/clients/core";
import { accountMessages } from "./messages";

type RequestFreeIpaAccountProps = {
  givenname: string;
  sn: string;
  displayName: string;
  phone: string | null;
  agbUrl?: string;
  privacyUrl?: string;
  appName?: string;
};

export default function RequestFreeIpaAccount(props: RequestFreeIpaAccountProps) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const mutation = mutations.create<
    { id: string; message?: string },
    {
      firstName: string;
      lastName: string;
      displayName?: string;
      phone?: string;
      comment?: string;
      acceptedAgb: true;
    }
  >({
    mutation: async (vars) => {
      const profileRes = await apiClient.me.$patch({
        json: {
          givenname: vars.firstName,
          sn: vars.lastName,
          displayName: vars.displayName || `${vars.firstName} ${vars.lastName}`,
        },
      });
      if (!profileRes.ok) {
        throw new Error(t().requestProfileUpdateFailed);
      }

      const res = await apiClient.me["account-request"].$post({
        json: {
          phone: vars.phone,
          comment: vars.comment,
          acceptedAgb: vars.acceptedAgb,
        },
      });
      const data = (await res.json()) as { id?: string; message?: string };
      if (!res.ok) {
        throw new Error(t().requestSubmitFailed);
      }
      return { id: data.id ?? "", message: data.message };
    },
    onSuccess: () => {
      prompts.alert(t().requestSubmittedBody, {
        title: t().requestSubmittedTitle,
        icon: "ti ti-check",
      });
      window.location.reload();
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleClick = async () => {
    const result = await prompts.form({
      title: t().requestAccountTitle({ appName: props.appName || "Cloud" }),
      icon: "ti ti-building-fortress",
      confirmText: t().submitRequest,
      fields: {
        info: {
          type: "info",
          content: () => (
            <NoticeCard tone="info" icon={false}>
              {t().verifyRequestDetails}
            </NoticeCard>
          ),
        },
        firstName: {
          type: "text",
          label: t().firstName,
          placeholder: t().yourFirstNamePlaceholder,
          icon: "ti ti-user",
          required: true,
          default: props.givenname,
        },
        lastName: {
          type: "text",
          label: t().lastName,
          placeholder: t().yourLastNamePlaceholder,
          icon: "ti ti-user",
          required: true,
          default: props.sn,
        },
        displayName: {
          type: "text",
          label: t().displayName,
          placeholder: t().displayNameQuestion,
          icon: "ti ti-id-badge-2",
          default: props.displayName,
        },
        phone: {
          type: "text",
          label: t().phoneOptional,
          placeholder: t().yourPhonePlaceholder,
          icon: "ti ti-phone",
          default: props.phone ?? "",
        },
        comment: {
          type: "text",
          multiline: true,
          label: t().whyFreeIpa,
          placeholder: t().freeIpaReasonPlaceholder,
          description: t().freeIpaReasonDescription,
        },
        agbNotice: {
          type: "info",
          content: () => (
            <div class="text-xs text-dimmed">
              {t().termsPrefix}{" "}
              {props.agbUrl ? (
                <a href={props.agbUrl} target="_blank" class="text-blue-500 hover:underline">
                  {t().termsOfService}
                </a>
              ) : (
                <span>{t().termsOfService}</span>
              )}{" "}
              {t().and}{" "}
              {props.privacyUrl ? (
                <a href={props.privacyUrl} target="_blank" class="text-blue-500 hover:underline">
                  {t().privacyPolicy}
                </a>
              ) : (
                <span>{t().privacyPolicy}</span>
              )}
              {"."}
            </div>
          ),
        },
        acceptedAgb: {
          type: "boolean",
          label: t().acceptTerms,
          required: true,
        },
      },
    });

    if (!result) return;

    await mutation.mutate({
      firstName: result.firstName,
      lastName: result.lastName,
      displayName: result.displayName || undefined,
      phone: result.phone || undefined,
      comment: result.comment || undefined,
      acceptedAgb: true,
    });
  };

  return (
    <Button type="button" size="sm" onClick={handleClick} loading={mutation.loading()} loadingLabel={t().requesting}>
      {mutation.loading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-building-fortress" />}
      <span>{t().requestFreeIpaAccount}</span>
    </Button>
  );
}
