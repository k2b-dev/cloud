import { openAccessDialog } from "@k2b/cloud/access/ui";
import { refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Dropdown, prompts, useLocale } from "@k2b/ui";
import { onCleanup } from "solid-js";
import { apiClient } from "@/api/client";
import { readErrorMessage } from "./api";
import { bookMessages } from "./book-messages";

type AdminBookActionsProps = {
  bookId: string;
  bookName: string;
};

const openPermissionDialog = async (props: AdminBookActionsProps, locale: string, signal: AbortSignal) => {
  const t = bookMessages.resolve([locale]).t;
  const response = await apiClient.admin.books[":bookId"].access.$get({ param: { bookId: props.bookId } }, { init: { signal } });
  if (!response.ok) throw new Error(await readErrorMessage(response, t.loadPermissionsFailed));
  const initialEntries = await response.json();
  // The page may have changed while the list loaded; never open the dialog over another page.
  if (signal.aborted) return;
  // Set by every saved change, also when a later one fails and the person discards the rest.
  let wrote = false;
  await openAccessDialog({
    resourceName: props.bookName,
    subtitle: t.accessDialogSubtitle,
    initialEntries,
    grantAccess: async (principal, permission) => {
      const response = await apiClient.admin.books[":bookId"].access.$post({
        param: { bookId: props.bookId },
        json: { principal, permission },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, t.adminGrantAccessFailed));
      wrote = true;
      return response.json();
    },
    updateAccess: async (accessId, permission) => {
      const response = await apiClient.admin.books[":bookId"].access[":accessId"].$patch({
        param: { bookId: props.bookId, accessId },
        json: { permission },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, t.adminUpdateAccessFailed));
      wrote = true;
    },
    revokeAccess: async (accessId) => {
      const response = await apiClient.admin.books[":bookId"].access[":accessId"].$delete({
        param: { bookId: props.bookId, accessId },
      });
      if (!response.ok) throw new Error(await readErrorMessage(response, t.adminRevokeAccessFailed));
      wrote = true;
    },
  });
  if (wrote) refreshCurrentPath();
};

const AdminBookActions = (props: AdminBookActionsProps) => {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const loading = new AbortController();
  onCleanup(() => loading.abort());
  // Loading the stored entries shows on the trigger; a failure says why instead of opening an empty dialog.
  const permissions = mutations.create<void, void>({
    mutation: () => openPermissionDialog(props, locale(), loading.signal),
    onError: (error) => {
      if (!loading.signal.aborted) void prompts.error(error.message);
    },
  });
  return (
    <Dropdown.Root
      position="bottom-left"
      width="13rem"
      items={[
        {
          items: [
            {
              icon: "ti ti-shield",
              label: t().permissionsLabel,
              action: () => void (permissions.loading() || permissions.mutate()),
            },
          ],
        },
      ]}
    >
      <Dropdown.Trigger iconOnly label={t().managePermissionsFor({ name: props.bookName })} size="xs" tooltip={t().managePermissions}>
        <i class={permissions.loading() ? "ti ti-loader-2 animate-spin text-sm" : "ti ti-settings text-sm"} />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
};

export default AdminBookActions;
