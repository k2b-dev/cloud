import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, prompts, SettingsGroup, toast, useLocale } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { Notebook } from "../sidebar/types";
import { readErrorMessage } from "./utils";
import { notebookSettingsMessages } from "./messages";

export function DangerZone(props: { notebook: Notebook }) {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  const mutation = mutations.create({
    mutation: async () => {
      const res = await apiClient[":id"].$delete({
        param: { id: props.notebook.id },
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, t().deleteFailed));
    },
    onSuccess: () => navigateTo("/app/notebooks"),
    onError: (err) => prompts.error(err.message),
  });

  const handleDelete = async () => {
    const enteredName = await prompts.prompt(t().deletePrompt({ name: props.notebook.name }), "", {
      title: t().deleteNotebook,
      icon: "ti ti-trash",
      variant: "danger",
      confirmText: t().deleteNotebook,
    });
    if (enteredName === null) return;
    if (enteredName !== props.notebook.name) {
      toast.error(t().nameMismatch);
      return;
    }
    mutation.mutate(undefined);
  };

  return (
    <SettingsGroup title={t().deleteNotebook} description={t().deleteDescription}>
      <SettingsGroup.Action>
        <Button variant="danger" onClick={handleDelete} loading={mutation.loading()} loadingLabel={t().deleting}>
          {mutation.loading() ? (
            <>
              <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />
              {t().deleting}
            </>
          ) : (
            <>
              <i class="ti ti-trash" aria-hidden="true" />
              {t().deleteNotebook}
            </>
          )}
        </Button>
      </SettingsGroup.Action>
    </SettingsGroup>
  );
}
