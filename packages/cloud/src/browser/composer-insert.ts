import type { ChatAttachment, ChatCommand, ChatCommandResult, ChatCommandScope } from "@k2b/ui";
import type { CloudResourceRef } from "../contracts";
import type { CloudSearchTag } from "./composer-catalog";
import { composerInsertMessages } from "./composer-insert-messages";
import { type CloudResourcePickerItem, openCloudResourcePicker } from "./resource-picker";

export {
  type CloudComposerCatalog,
  type CloudComposerCatalogState,
  type CloudComposerCommand,
  type CloudSearchTag,
  createCloudComposerCatalog,
  loadCloudComposerCatalog,
} from "./composer-catalog";

export {
  type CloudCommandMenu,
  type CloudCommandMenuOptions,
  cloudCommandMenu,
  type OpenComposerCommandOptions,
  openComposerCommand,
} from "./composer-open";

export type CloudInsertMenuOptions = {
  locale: string;
  /** Every app's search tags, from `loadCloudComposerCatalog`. */
  tags: readonly CloudSearchTag[];
  /** Section of the rows in the composer's slash list. */
  section?: string;
  /** Turns the chosen resource into the reference the composer puts where `/…` was. */
  mention: (item: CloudResourcePickerItem) => ChatAttachment;
  /** References the draft already holds; the picker leaves them out. Read when the picker opens. */
  excludeRefs?: () => readonly CloudResourceRef[];
  /** Why nothing can be inserted now, such as a full message; it replaces each row's description. */
  reason?: string;
  /** First words of the composer's own scopes. A tag never claims them, so they keep narrowing as before. */
  reservedWords?: readonly string[];
  /** More first words for one tag, keyed `appId:tag`, such as a short word an app uses for its own tag. */
  scopeWords?: Readonly<Record<string, readonly string[]>>;
  /**
   * Tags, keyed `appId:tag`, whose resources of one type this composer reads itself, such as
   * `{ "assistant:studio-app": "assistant.app" }`. Their picker lists only that type, also without a Cloud reader, even
   * after the person removes the scope chip. Every other picker lists only resources with a reader (`requireReader`).
   */
  ownReaders?: Readonly<Record<string, string>>;
};

export type CloudInsertMenu = {
  /** "Insert from Cloud": the picker across all apps. */
  insert: ChatCommand;
  /** One row per search tag, only while searching. Enter opens the picker narrowed to the tag; Tab narrows the list. */
  tags: ChatCommand[];
  /** One scope per tag that keeps a first word of its own, titled like "Notes from Notebooks". */
  scopes: ChatCommandScope[];
  /** For the composer's `commandFallback`: "Search Notes for “q3”" in a tag scope, "Search Cloud for “q3”" otherwise. */
  fallback: (search: { query: string; scope?: string }) => ChatCommand | undefined;
};

const fold = (text: string) => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/ß/g, "ss");
const tagKey = (tag: Pick<CloudSearchTag, "appId" | "tag">) => `${tag.appId}:${tag.tag}`;
const scopeId = (tag: Pick<CloudSearchTag, "appId" | "tag">) => `cloud-tag:${tagKey(tag)}`;

/**
 * Slash-list rows that insert Cloud content the person can read. Every row opens the resource picker, narrowed on the
 * server to an app and tag when it has one, and hands the chosen item back as a `mention` for the token's place.
 */
export const cloudInsertMenu = (options: CloudInsertMenuOptions): CloudInsertMenu => {
  const t = composerInsertMessages.resolve([options.locale]).t;
  const pick = async (tag: CloudSearchTag | undefined, query: string): Promise<ChatCommandResult> => {
    const ownType = tag ? options.ownReaders?.[tagKey(tag)] : undefined;
    const item = await openCloudResourcePicker({
      title: tag ? t.insertTag({ tag: tag.title }) : t.insertFromCloud,
      scope: tag ? { appId: tag.appId, tag: tag.tag, label: `${tag.title} · ${tag.appName}`, icon: tag.appIcon } : undefined,
      query: query || undefined,
      ...(ownType ? { resourceType: ownType } : { requireReader: true }),
      excludeRefs: options.excludeRefs?.(),
    });
    return item ? { mention: options.mention(item) } : "cancelled";
  };

  const reserved = new Set((options.reservedWords ?? []).map(fold));
  // The title comes first, so Tab writes the word the person reads ("notizen ").
  const candidates = options.tags.map((tag) => {
    const title = fold(tag.title);
    return [
      ...new Set(
        [...(/\s/.test(title) ? [] : [title]), tag.tag, ...tag.aliases, ...(options.scopeWords?.[tagKey(tag)] ?? [])]
          .map(fold)
          .filter((word) => word && !/\s/.test(word) && !reserved.has(word)),
      ),
    ];
  });
  // A word two tags share narrows to neither, so Tab on either row would leave the list unscoped; neither keeps it.
  const uses = new Map<string, number>();
  for (const word of candidates.flat()) uses.set(word, (uses.get(word) ?? 0) + 1);
  const scoped = new Map<string, CloudSearchTag>();
  const scopes: ChatCommandScope[] = [];
  const tags = options.tags.map((tag, index): ChatCommand => {
    const words = candidates[index]!.filter((word) => uses.get(word) === 1);
    if (words.length) {
      scoped.set(scopeId(tag), tag);
      scopes.push({ id: scopeId(tag), title: t.tagFromApp({ tag: tag.title, app: tag.appName }), words });
    }
    return {
      id: scopeId(tag),
      section: options.section,
      name: tag.tag,
      label: tag.title,
      description: t.chooseFrom({ app: tag.appName }),
      icon: tag.appIcon,
      keywords: [tag.title, tag.appName, tag.tag, ...tag.aliases, ...(options.scopeWords?.[tagKey(tag)] ?? [])],
      app: tag.appName,
      scope: words.length ? scopeId(tag) : undefined,
      hiddenUntilSearch: true,
      reason: options.reason,
      action: () => pick(tag, ""),
    };
  });

  return {
    insert: {
      id: "cloud-insert",
      section: options.section,
      name: "cloud",
      label: t.insertFromCloud,
      description: t.insertFromCloudHint,
      icon: "ti ti-cloud-search",
      keywords: ["cloud", "insert", "einfügen", "inhalt", "content", "ressource", "resource", "verweis", "reference", "link"],
      reason: options.reason,
      action: () => pick(undefined, ""),
    },
    tags,
    scopes,
    fallback: ({ query, scope }) => {
      if (scope !== undefined) {
        const tag = scoped.get(scope);
        if (!tag) return undefined;
        return {
          id: `cloud-search:${tagKey(tag)}`,
          name: `cloud-search:${tagKey(tag)}`,
          label: query ? t.searchTagFor({ tag: tag.title, query }) : t.searchTag({ tag: tag.title }),
          description: t.fromAppWithPreview({ app: tag.appName }),
          icon: "ti ti-search",
          reason: options.reason,
          action: () => pick(tag, query),
        };
      }
      if (!query) return undefined;
      return {
        id: "cloud-search",
        name: "cloud-search",
        label: t.searchCloudFor({ query }),
        description: t.searchAllApps,
        icon: "ti ti-search",
        reason: options.reason,
        action: () => pick(undefined, query),
      };
    },
  };
};
