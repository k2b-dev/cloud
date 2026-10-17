import { type CloudSearchTag, cloudInsertMenu, loadCloudComposerCatalog } from "@k2b/cloud/browser/composer-insert";
import { Chat, type ChatMention, useLocale } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";

export function ResourceComposer() {
  const locale = useLocale();
  const [text, setText] = createSignal("");
  const [mentions, setMentions] = createSignal<readonly ChatMention[]>([]);
  const [tags, setTags] = createSignal<readonly CloudSearchTag[]>([]);
  const menu = createMemo(() =>
    cloudInsertMenu({
      locale: locale(),
      tags: tags(),
      section: "insert",
      mention: (item) => ({ id: `resource:${item.ref.type}:${item.ref.id}`, name: item.title, data: item.ref }),
    }),
  );
  let opening: number | undefined;
  return (
    <Chat.Composer
      value={text()}
      onValueChange={setText}
      mentions={mentions()}
      onMentionsChange={setMentions}
      commandSections={[{ id: "insert", label: "Insert" }]}
      commands={[menu().insert, ...menu().tags]}
      commandScopes={menu().scopes}
      commandFallback={menu().fallback}
      searchCommands={async (_query, _signal, search) => {
        if (opening !== search.opening) {
          opening = search.opening;
          try {
            setTags((await loadCloudComposerCatalog(locale())).tags);
          } catch {
            /* Keep the current tags; the next opening retries. */
          }
        }
        return [];
      }}
      onSubmit={(input) => {
        console.log(input.text, input.mentions);
      }}
    />
  );
}
