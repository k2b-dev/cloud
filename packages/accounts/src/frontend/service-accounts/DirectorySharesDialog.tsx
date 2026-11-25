import { coreClient } from "@k2b/cloud/clients/core";
import { useLocale } from "@k2b/ui";
import { Button, Dialog, Field, Lookup, Text } from "@k2b/ui/v2";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { createSignal, Show } from "solid-js";
import { z } from "zod";
import DirectoryAccessSection from "./DirectoryAccessSection";
import { directoryMessages } from "./directory-messages";
import { useApiKeyMessages } from "./messages";

const AccountsSchema = z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) });

/**
 * Directory access from the list of all API keys: choose an agent, then its directory access as its record shows it.
 * Switching the agent starts its section afresh, so the previous agent's entries never show for the next one.
 */
export default function DirectorySharesDialog(props: { close: () => void }) {
  const locale = useLocale();
  const words = useApiKeyMessages();
  const t = () => directoryMessages.resolve([locale()]).t;
  const [recipient, setRecipient] = createSignal<LookupItem | null>(null);
  const known = new Map<string, LookupItem>();
  const load = async (search: string, context: { signal: AbortSignal; limit: number }) => {
    const response = await coreClient.admin.identity["service-accounts"].$get(
      { query: { search, status: "active", perPage: String(context.limit) } },
      { init: { signal: context.signal } },
    );
    if (!response.ok) throw new Error(t().loadFailed);
    const items = AccountsSchema.parse(await response.json()).items.map((account) => ({
      value: account.id,
      label: account.name,
      meta: t().agent,
    }));
    for (const item of items) known.set(item.value, item);
    return { items };
  };
  return (
    <Dialog
      title={t().title}
      open
      onOpenChange={(open) => {
        if (!open) props.close();
      }}
      foot={<Button onClick={props.close}>{t().close}</Button>}
    >
      <Field label={t().machine}>
        {/* k2b-ui gap: Lookup has no single choice; the dialog keeps only the newest pick. */}
        <Lookup
          label={t().machine}
          value={recipient() ? [recipient()!.value] : []}
          known={recipient() ? [recipient()!] : []}
          load={load}
          onChange={(values) => {
            const picked = values.find((value) => value !== recipient()?.value) ?? values[0];
            setRecipient(picked ? (known.get(picked) ?? null) : null);
          }}
        />
      </Field>
      <Show when={recipient()} keyed fallback={<Text type="meta">{words().directoryChooseFirst}</Text>}>
        {(chosen) => <DirectoryAccessSection account={{ id: chosen.value, name: chosen.label }} />}
      </Show>
    </Dialog>
  );
}
