import { SettingsGroup } from "@k2b/ui";
import { PermissionEditor, type ResourceApiKey, ResourceApiKeys } from "@valentinkolb/cloud/access/ui";
import { apiClient } from "@/api/client";
import type { AccessEntry } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import { readErrorMessage } from "./utils";

export function PermissionsSection(props: { spaceId: string; accessEntries: AccessEntry[]; onWorkspaceChange?: () => void }) {
  const m = useSpaceMessages();
  return (
    <SettingsGroup title={m.peopleAndGroups} description={m.accessDescription}>
      <PermissionEditor
        initialEntries={props.accessEntries.filter((entry) => entry.principal.type !== "service_account")}
        canEdit
        grantAccess={async (principal, permission) => {
          const res = await apiClient[":id"].access.$post({
            param: { id: props.spaceId },
            json: { principal, permission },
          });
          if (!res.ok) throw new Error(await readErrorMessage(res, m.grantAccessFailed));
          const entry = await res.json();
          props.onWorkspaceChange?.();
          return entry;
        }}
        updateAccess={async (accessId, permission) => {
          const res = await apiClient[":id"].access[":accessId"].$patch({
            param: { id: props.spaceId, accessId },
            json: { permission },
          });
          if (!res.ok) throw new Error(await readErrorMessage(res, m.updatePermissionFailed));
          props.onWorkspaceChange?.();
        }}
        revokeAccess={async (accessId) => {
          const res = await apiClient[":id"].access[":accessId"].$delete({
            param: { id: props.spaceId, accessId },
          });
          if (!res.ok) throw new Error(await readErrorMessage(res, m.revokeAccessFailed));
          props.onWorkspaceChange?.();
        }}
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
