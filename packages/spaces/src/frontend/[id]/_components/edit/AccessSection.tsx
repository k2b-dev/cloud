import { type GrantableLevel, openAccessDialog, PermissionEditor, type ResourceApiKey, ResourceApiKeys } from "@k2b/cloud/access/ui";
import type { Principal } from "@k2b/cloud/contracts";
import { Button, prompts, SettingsGroup } from "@k2b/ui";
import { createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import type { AccessEntry } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import { readErrorMessage } from "./utils";

/** Object keys have their own tab; every other grant, agents included, belongs to who may use the space. */
const visibleEntries = (entries: AccessEntry[]) => entries.filter((entry) => entry.serviceAccountKind !== "resource_bound");

export function PermissionsSection(props: {
  spaceId: string;
  spaceName: string;
  accessEntries: AccessEntry[];
  onWorkspaceChange?: () => void;
}) {
  const m = useSpaceMessages();
  const [entries, setEntries] = createSignal(visibleEntries(props.accessEntries));
  const grantAccess = async (principal: Principal, permission: GrantableLevel) => {
    const res = await apiClient[":id"].access.$post({ param: { id: props.spaceId }, json: { principal, permission } });
    if (!res.ok) throw new Error(await readErrorMessage(res, m.grantAccessFailed));
    return await res.json();
  };
  const updateAccess = async (accessId: string, permission: GrantableLevel) => {
    const res = await apiClient[":id"].access[":accessId"].$patch({ param: { id: props.spaceId, accessId }, json: { permission } });
    if (!res.ok) throw new Error(await readErrorMessage(res, m.updatePermissionFailed));
  };
  const revokeAccess = async (accessId: string) => {
    const res = await apiClient[":id"].access[":accessId"].$delete({ param: { id: props.spaceId, accessId } });
    if (!res.ok) throw new Error(await readErrorMessage(res, m.revokeAccessFailed));
  };
  // Changes are collected in the dialog and saved together; the list here shows what is stored.
  const edit = async () => {
    const saved = await openAccessDialog({
      resourceName: props.spaceName,
      subtitle: m.accessDialogSubtitle,
      initialEntries: entries(),
      grantAccess,
      updateAccess,
      revokeAccess,
    });
    if (!saved) return;
    const res = await apiClient[":id"].access.$get({ param: { id: props.spaceId } });
    props.onWorkspaceChange?.();
    if (!res.ok) throw new Error(await readErrorMessage(res, m.loadPermissionsFailed));
    setEntries(visibleEntries(await res.json()));
  };
  return (
    <SettingsGroup title={m.peopleAndGroups} description={m.accessDescription}>
      <SettingsGroup.Action>
        <Button size="sm" variant="secondary" onClick={() => void edit().catch((error: Error) => prompts.error(error.message))}>
          <i class="ti ti-pencil" aria-hidden="true" />
          {m.editAccess}
        </Button>
      </SettingsGroup.Action>
      <PermissionEditor
        initialEntries={entries()}
        canEdit={false}
        grantAccess={grantAccess}
        updateAccess={updateAccess}
        revokeAccess={revokeAccess}
      />
    </SettingsGroup>
  );
}

export function ApiKeysSection(props: { spaceId: string; apiKeys: ResourceApiKey[] }) {
  const m = useSpaceMessages();
  return (
    <SettingsGroup title={m.integrationAccess} description={m.integrationAccessDescription}>
      <ResourceApiKeys
        title={m.apiKeys}
        description={m.apiKeysDescription}
        initialKeys={props.apiKeys}
        createKey={async (input) => {
          const res = await apiClient[":id"]["api-keys"].$post({
            param: { id: props.spaceId },
            json: input,
          });
          if (!res.ok) throw new Error(await readErrorMessage(res, m.createApiKeyFailed));
          return (await res.json()) as { credential: ResourceApiKey; token: string };
        }}
        revokeKey={async (credentialId) => {
          const res = await apiClient[":id"]["api-keys"][":credentialId"].$delete({
            param: { id: props.spaceId, credentialId },
          });
          if (!res.ok) throw new Error(await readErrorMessage(res, m.revokeApiKeyFailed));
        }}
      />
    </SettingsGroup>
  );
}
