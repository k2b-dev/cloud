import { serviceAccountCredentials } from "@k2b/cloud/services";
import { KEYS_PER_PAGE, type KeyOwner, type KeyPage, keyFilter, toKeyPage } from "./account-keys";
import type { KeyContext } from "./api-key-row";

/**
 * The first page of an account's keys for its record (server only): the same service query the section's API pages
 * through, one statement pair as every page. Null when the keys could not be read; the section then offers a retry.
 */
export const firstKeyPage = async (owner: KeyOwner, context: KeyContext): Promise<KeyPage | null> =>
  serviceAccountCredentials
    .listOverview({ pagination: { page: 1, perPage: KEYS_PER_PAGE }, filter: keyFilter(owner) })
    .then((answer) => toKeyPage(answer, 1, context))
    .catch(() => null);
