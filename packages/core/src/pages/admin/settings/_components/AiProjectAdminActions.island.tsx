import { openAccessDialog } from "@k2b/cloud/access/ui";
import type { AiProjectAccess } from "@k2b/cloud/ai";
import { coreClient } from "@k2b/cloud/clients/core";
import { AuthenticatedPrincipalSchema } from "@k2b/cloud/contracts";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Dropdown, prompts, toast, useLocale } from "@k2b/ui";
import { onCleanup } from "solid-js";
import { findAiServiceAccount } from "./ai-service-account-lookup";
import { settingsMessages } from "./messages";

type Props = {
  projectId: string;
  projectName: string;
};

const readError = async (response: Pick<Response, "json">, fallback: string): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message || fallback;
};

const openPermissionDialog = async (props: Props, locale: string, signal: AbortSignal) => {
  const t = settingsMessages.resolve([locale]).t;
  const response = await coreClient.admin.core["ai-projects"][":projectId"].access.$get(
    { param: { projectId: props.projectId } },
    { init: { signal } },
  );
  if (!response.ok) throw new Error(await readError(response, t.loadProjectPermissionsFailed));
  const initialEntries: AiProjectAccess[] = (await response.json()).access;
  // The page may have changed while the list loaded; never open the dialog over another page.
  if (signal.aborted) return;
  // Set by every saved change, also when a later one fails and the person discards the rest.
  let wrote = false;
  await openAccessDialog({
    resourceName: props.projectName,
    subtitle: t.projectAccessSubtitle,
    initialEntries,
    allowPublic: false,
    findServiceAccount: (handle, signal) => findAiServiceAccount({ type: "core.ai.project", id: props.projectId }, handle, signal),
    signal,
    grantAccess: async (principal, permission) => {
      const response = await coreClient.admin.core["ai-projects"][":projectId"].access.$post({
        param: { projectId: props.projectId },
        json: { principal: AuthenticatedPrincipalSchema.parse(principal), permission },
      });
      if (!response.ok) throw new Error(await readError(response, t.grantProjectAccessFailed));
      wrote = true;
      return (await response.json()).access;
    },
    updateAccess: async (accessId, permission) => {
      const response = await coreClient.admin.core["ai-projects"][":projectId"].access[":accessId"].$patch({
        param: { projectId: props.projectId, accessId },
        json: { permission },
      });
      if (!response.ok) throw new Error(await readError(response, t.updateProjectAccessFailed));
      wrote = true;
    },
    revokeAccess: async (accessId) => {
      const response = await coreClient.admin.core["ai-projects"][":projectId"].access[":accessId"].$delete({
        param: { projectId: props.projectId, accessId },
      });
      if (!response.ok) throw new Error(await readError(response, t.revokeProjectAccessFailed));
      wrote = true;
    },
  });
  // After navigation the page is another one; refreshing it would cancel where the person went.
  if (wrote && !signal.aborted) refreshCurrentPath();
};

export default function AiProjectAdminActions(props: Props) {
  const locale = useLocale();
  const t = () => settingsMessages.resolve([locale()]).t;
  const loading = new AbortController();
  onCleanup(() => loading.abort());
  // Loading the stored entries shows on the trigger; a failure says why instead of opening an empty dialog.
  const permissions = mutations.create<void, void>({
    mutation: () => openPermissionDialog(props, locale(), loading.signal),
    onError: (error) => {
      if (!loading.signal.aborted) void prompts.error(error.message);
    },
  });
  const remove = mutations.create<void, void>({
    mutation: async () => {
      const response = await coreClient.admin.core["ai-projects"][":projectId"].$delete({ param: { projectId: props.projectId } });
      if (!response.ok) throw new Error(await readError(response, t().deleteProjectFailed));
    },
    onSuccess: () => {
      toast.success(t().projectDeleted);
      refreshCurrentPath();
    },
    onError: (error) => prompts.error(error instanceof Error ? error.message : t().deleteProjectFailed),
  });

  const handleDelete = async () => {
    const confirmed = await prompts.confirm(t().deleteProjectConfirm({ name: props.projectName }), {
      title: t().deleteProject,
      icon: "ti ti-trash",
      variant: "danger",
      confirmText: t().delete,
    });
    if (confirmed) remove.mutate();
  };

  return (
    <Dropdown.Root
      position="bottom-left"
      width="13rem"
      items={[
        {
          items: [
            {
              icon: "ti ti-shield",
              label: t().permissions,
              action: () => void (permissions.loading() || permissions.mutate()),
            },
            {
              icon: "ti ti-trash",
              label: t().deleteProject,
              variant: "danger",
              action: () => void handleDelete(),
            },
          ],
        },
      ]}
    >
      <Dropdown.Trigger iconOnly label={t().actionsFor({ name: props.projectName })} size="xs" tooltip={t().projectActions}>
        <i class={permissions.loading() ? "ti ti-loader-2 animate-spin text-sm" : "ti ti-settings text-sm"} />
        <span class="sr-only" role="status">
          {permissions.loading() ? t().loadingProjectAccess : ""}
        </span>
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
