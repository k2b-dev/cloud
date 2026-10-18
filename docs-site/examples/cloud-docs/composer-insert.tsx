import { cloudInsertMenu, createCloudComposerCatalog } from "@k2b/cloud/browser/composer-insert";
import { Chat, type ChatMention, useLocale } from "@k2b/ui";
import { createMemo, createSignal } from "solid-js";

export function ResourceComposer() {
  const locale = useLocale();
  const [text, setText] = createSignal("");
  const [mentions, setMentions] = createSignal<readonly ChatMention[]>([]);
  const catalog = createCloudComposerCatalog();
  const menu = createMemo(() =>
    cloudInsertMenu({
      locale: locale(),
      tags: catalog.tags(),
      section: "insert",
      mention: (item) => ({ id: `resource:${item.ref.type}:${item.ref.id}`, name: item.title, data: item.ref }),
    }),
  );
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
      searchCommands={async (query, _signal, search) => {
        // Starts this opening's catalog load; typed text outside a scope waits for it.
        await catalog.ready(query, search, locale());
        return [];
      }}
      onSubmit={(input) => {
        console.log(input.text, input.mentions);
      }}
    />
  );
}
