import { type ServiceAccountCredentialOverview, serviceAccountCredentials } from "@k2b/cloud/services";
import { KEYS_PER_PAGE, type KeyOwner, type KeyPage, keyFilter, toKeyPage } from "./account-keys";
import { type KeyContext, toAccountKey } from "./api-key-row";

const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a key belongs to the owner whose record asks for it; a key of another account is no key of this one. */
const belongs = (credential: ServiceAccountCredentialOverview, owner: KeyOwner) =>
  owner.kind === "person"
    ? credential.serviceAccount.kind === "user_delegated" && credential.serviceAccount.delegatedUserId === owner.userId
    : credential.serviceAccount.id === owner.id;

/**
 * The first page of an account's keys for its record (server only): the same service query the section's API pages
 * through. With `open` (the address's `?key=`, a key's id) the key is also looked up by its id wherever it stands, one
 * statement more, so an old link opens a key beyond the first page. Null when the keys could not be read; the section
 * then offers a retry.
 */
export const firstKeyPage = async (owner: KeyOwner, context: KeyContext, open?: string): Promise<KeyPage | null> => {
  const lookup = open && KEY_ID.test(open);
  const [answer, credential] = await Promise.all([
    serviceAccountCredentials.listOverview({ pagination: { page: 1, perPage: KEYS_PER_PAGE }, filter: keyFilter(owner) }).catch(() => null),
    lookup ? serviceAccountCredentials.getOverview({ id: open }).catch(() => null) : null,
  ]);
  if (!answer) return null;
  const page = toKeyPage(answer, 1, context);
  if (!lookup) return page;
  return { ...page, open: credential && belongs(credential, owner) ? toAccountKey(credential, context) : null };
};
