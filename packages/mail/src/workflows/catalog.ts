export type MailWorkflowFolderCatalogEntry = {
  id: string;
  name: string;
  /** Display path including parent folders, such as `Projects / 2025 / Archive`. */
  path?: string;
  role?: string;
};

export type MailWorkflowAssignableUserCatalogEntry = {
  id: string;
  name: string;
};

export type MailWorkflowSenderIdentityCatalogEntry = {
  id: string;
  name: string;
};

export type MailWorkflowLocalTagCatalogEntry = { id: string; name: string; color?: string };
export type MailWorkflowNotificationUserCatalogEntry = { id: string; name: string };

export type MailWorkflowCatalogEntry =
  | MailWorkflowFolderCatalogEntry
  | MailWorkflowAssignableUserCatalogEntry
  | MailWorkflowSenderIdentityCatalogEntry
  | MailWorkflowLocalTagCatalogEntry
  | MailWorkflowNotificationUserCatalogEntry;

export type MailWorkflowCatalogIndex<T extends MailWorkflowCatalogEntry> = {
  refs: Map<string, T>;
  ambiguous: Set<string>;
};

export type MailWorkflowCatalog = {
  folders: MailWorkflowCatalogIndex<MailWorkflowFolderCatalogEntry>;
  assignableUsers: MailWorkflowCatalogIndex<MailWorkflowAssignableUserCatalogEntry>;
  senderIdentities: MailWorkflowCatalogIndex<MailWorkflowSenderIdentityCatalogEntry>;
  localTags: MailWorkflowCatalogIndex<MailWorkflowLocalTagCatalogEntry>;
  notificationUsers: MailWorkflowCatalogIndex<MailWorkflowNotificationUserCatalogEntry>;
};

export type MailWorkflowCatalogSnapshot = {
  folders: MailWorkflowFolderCatalogEntry[];
  assignableUsers: MailWorkflowAssignableUserCatalogEntry[];
  senderIdentities?: MailWorkflowSenderIdentityCatalogEntry[];
  localTags?: MailWorkflowLocalTagCatalogEntry[];
  notificationUsers?: MailWorkflowNotificationUserCatalogEntry[];
};

export type MailWorkflowCatalogInput = {
  folders: MailWorkflowFolderCatalogEntry[];
  assignableUsers: MailWorkflowAssignableUserCatalogEntry[];
  senderIdentities?: MailWorkflowSenderIdentityCatalogEntry[];
  localTags?: MailWorkflowLocalTagCatalogEntry[];
  notificationUsers?: MailWorkflowNotificationUserCatalogEntry[];
};

const compareIds = (left: MailWorkflowCatalogEntry, right: MailWorkflowCatalogEntry): number =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

const buildIndex = <T extends MailWorkflowCatalogEntry>(entries: T[]): MailWorkflowCatalogIndex<T> => {
  const index: MailWorkflowCatalogIndex<T> = { refs: new Map(), ambiguous: new Set() };
  for (const entry of [...entries].sort(compareIds)) {
    for (const reference of [entry.id, entry.name]) {
      const existing = index.refs.get(reference);
      if (existing && existing.id !== entry.id) index.ambiguous.add(reference);
      else index.refs.set(reference, entry);
    }
  }
  return index;
};

export const buildMailWorkflowCatalog = (input: MailWorkflowCatalogInput): MailWorkflowCatalog => ({
  folders: buildIndex(input.folders),
  assignableUsers: buildIndex(input.assignableUsers),
  senderIdentities: buildIndex(input.senderIdentities ?? []),
  localTags: buildIndex(input.localTags ?? []),
  notificationUsers: buildIndex(input.notificationUsers ?? []),
});

const uniqueEntries = <T extends MailWorkflowCatalogEntry>(index: MailWorkflowCatalogIndex<T>): T[] =>
  [...new Map([...index.refs.values()].map((entry) => [entry.id, entry])).values()].sort(compareIds);

export const snapshotMailWorkflowCatalog = (catalog: MailWorkflowCatalog): MailWorkflowCatalogSnapshot => ({
  folders: uniqueEntries(catalog.folders),
  assignableUsers: uniqueEntries(catalog.assignableUsers),
  senderIdentities: uniqueEntries(catalog.senderIdentities),
  localTags: uniqueEntries(catalog.localTags),
  notificationUsers: uniqueEntries(catalog.notificationUsers),
});

export const restoreMailWorkflowCatalog = (snapshot: MailWorkflowCatalogSnapshot): MailWorkflowCatalog =>
  buildMailWorkflowCatalog({
    ...snapshot,
    senderIdentities: snapshot.senderIdentities ?? [],
    localTags: snapshot.localTags ?? [],
    notificationUsers: snapshot.notificationUsers ?? [],
  });

export const getMailWorkflowCatalogRef = <T extends MailWorkflowCatalogEntry>(
  index: MailWorkflowCatalogIndex<T>,
  reference: string,
): T | null => {
  if (index.ambiguous.has(reference)) return null;
  return index.refs.get(reference) ?? null;
};
