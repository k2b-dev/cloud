import type { User } from "@k2b/cloud/contracts";
import { directoryShares } from "@k2b/cloud/services/accounts/directory-shares";
import { DIRECTORY_PER_PAGE, type DirectoryPage } from "./DirectoryAccessSection";

/**
 * The first page of an agent's directory access for its record (server only), through the same permission-aware
 * service the section's API pages through: administrators only, agents only. Undefined when it cannot be read, so the
 * section loads it itself and shows a retry in place if that fails too.
 */
export const firstDirectoryPage = async (
  actor: Pick<User, "id" | "uid" | "provider" | "roles">,
  agentId: string,
): Promise<DirectoryPage | undefined> => {
  const result = await directoryShares.list({ actor, recipientId: agentId, page: 1, perPage: DIRECTORY_PER_PAGE }).catch(() => null);
  return result?.ok ? result.data : undefined;
};
