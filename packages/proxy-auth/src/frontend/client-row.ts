import { formatDate, groupDisplayName } from "@k2b/cloud/shared";
import type { ProxyAuthClient } from "../contracts";
import type { ClientRow } from "./_components/ProxyAuthScreen";

/** One client as the list shows it, from the service's client: the page builds its rows so, and the list a new one. */
export const clientRow = (client: ProxyAuthClient, locale: string): ClientRow => ({
  id: client.id,
  clientId: client.clientId,
  name: client.name,
  description: client.description,
  groups: client.allowedGroups.map((group) => ({ id: group.id, label: groupDisplayName(group.name, locale) })),
  created: formatDate(client.createdAt, { locale }),
});
