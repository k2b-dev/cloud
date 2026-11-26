import { coreClient } from "@k2b/cloud/clients/core";
import { query } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Chip, Empty, Failed, Loading, Menu, type MenuItem, Notice, Row, Section, Text, useToast } from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import { z } from "zod";
import { apiClient } from "@/api/client";
import { usePageSwap } from "../lib/page-swap";
import { useAccountsMessages } from "../messages";
import { KEYS_PER_PAGE, type KeyOwner, type KeyPage, toKeyPage } from "./account-keys";
import type { AccountKey } from "./api-key-row";
import { accessLabel, confirmRevoke, KeyDialog, ReplaceKeyDialog, revokeCredential } from "./credential-dialogs";
import MachineKeyDialog from "./MachineKeyDialog";
import { useApiKeyMessages } from "./messages";
import { shortName } from "./short-name";

/** The account a key section belongs to, as the record's server passes it. */
export type KeyAccount = KeyOwner & {
  name: string;
  /** An agent gets new keys only while active; a person's own keys come from that person. */
  active: boolean;
};

export type ApiKeysSectionProps = {
  account: KeyAccount;
  /** The first page the record's server read with `firstKeyPage`; null when it could not be read. */
  first: KeyPage | null;
  /** Whether the OpenAI-compatible API is on, so a key may be limited to AI models. */
  modelsAvailable: boolean;
  /** The person's time zone: dates and a key's last day follow it. */
  timeZone: string;
};

const SourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(["active", "revoked"]),
  tokenPrefix: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
  serviceAccount: z.object({ id: z.string(), kind: z.string() }),
});
const AgentPageSchema = z.object({ items: z.array(SourceSchema), total: z.number() });
const PersonPageSchema = z.object({ credentials: z.array(SourceSchema), pagination: z.object({ total: z.number() }) });

type Replacing = { name: string; serviceAccountId: string; credentialId: string };

/**
 * An account's API keys as a section of its record: the true count in the head, one short row per key with its
 * prefix, purpose and last use, and the pages of the existing API beyond the first, which the server sent. A row opens
 * the key's facts; "…" and the open key revoke it, and an agent's legacy key is replaced by a new one. An active agent
 * gets a new key here; its token shows once, in the dialog. After a change the record is read again.
 */
export default function ApiKeysSection(props: ApiKeysSectionProps) {
  const locale = useLocale();
  const t = useAccountsMessages();
  const words = useApiKeyMessages();
  const toast = useToast();
  const { showChanges } = usePageSwap();
  const [page, setPage] = createSignal(1);
  const [creating, setCreating] = createSignal(false);
  const [opened, setOpened] = createSignal<AccountKey | null>(null);
  const [replacing, setReplacing] = createSignal<Replacing | null>(null);
  // a first page the server could not read shows its failure in place; "Erneut versuchen" then asks the API
  const [unread, setUnread] = createSignal(props.first === null);
  const keys = query.create({
    source: () => page(),
    enabled: () => !unread(),
    initial: props.first ? { source: 1, data: props.first } : undefined,
    load: async (number, { abortSignal }) => {
      const owner = props.account;
      const context = { locale: locale(), timeZone: props.timeZone, now: new Date() };
      if (owner.kind === "agent") {
        const response = await coreClient.admin.identity["service-accounts"][":id"]["api-keys"].$get(
          { param: { id: owner.id }, query: { page: String(number), perPage: String(KEYS_PER_PAGE) } },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) throw new Error(words().keysFailed);
        return toKeyPage(AgentPageSchema.parse(await response.json()), number, context);
      }
      const response = await apiClient["service-accounts"].$get(
        {
          query: { userId: owner.userId, kind: "user_delegated", status: "active", page: String(number), per_page: String(KEYS_PER_PAGE) },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(words().keysFailed);
      const answer = PersonPageSchema.parse(await response.json());
      return toKeyPage({ items: answer.credentials, total: answer.pagination.total }, number, context);
    },
  });
  const current = () => (keys.data()?.page === page() ? keys.data() : undefined);
  // the count stays while another page loads
  const total = () => keys.data()?.total ?? props.first?.total;
  const pages = () => Math.max(1, Math.ceil((total() ?? 0) / KEYS_PER_PAGE));
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const creatable = () => props.account.kind === "agent" && props.account.active;
  const create = { label: t().createMachineKey, icon: "plus", onClick: () => setCreating(true) };

  const revoke = async (entry: AccountKey) => {
    setOpened(null);
    if (!(await confirmRevoke(t(), words(), entry))) return;
    try {
      await revokeCredential(entry.id, t().revokeApiKeyFailed);
      toast(words().revoked_({ name: shortName(entry.name) }), { status: "ok" });
      await showChanges();
    } catch (failure) {
      // k2b-ui gap: a v2 toast has no description line for the server's reason (baseline in toast-copy).
      toast(failure instanceof Error ? failure.message : t().revokeApiKeyFailed, { status: "bad" });
    }
  };
  const replace = (entry: AccountKey, serviceAccountId: string) => {
    setOpened(null);
    setReplacing({ name: entry.name, serviceAccountId, credentialId: entry.id });
  };
  const deeds = (entry: AccountKey): MenuItem[] => [
    ...(entry.replace ? [{ label: t().replaceKey, icon: "replace", onClick: () => replace(entry, entry.replace!.serviceAccountId) }] : []),
    { label: t().revoke, icon: "key-off", danger: true, onClick: () => void revoke(entry) },
  ];
  const second = (entry: AccountKey) =>
    words().keyLine({
      prefix: entry.prefix,
      access: accessLabel(t(), entry.access),
      used: !entry.active
        ? words().createdOn({ when: entry.created })
        : entry.expired
          ? words().expiredOn({ when: entry.expires ?? "" })
          : entry.lastUsed
            ? words().usedOn({ when: entry.lastUsed })
            : words().neverUsed,
    });

  return (
    <>
      <Section
        title={words().keysTitle}
        icon="key"
        count={total() === undefined ? undefined : number(total()!)}
        actions={creatable() ? [create] : undefined}
      >
        <Show when={props.account.kind === "agent" && !props.account.active}>
          <Notice tone="warn">{words().agentInactive}</Notice>
        </Show>
        <Show when={current()?.keys.some((entry) => entry.access === "legacy" && entry.active)}>
          <Notice tone="note" icon="lock" title={t().legacyLimitedKey}>
            {t().legacyLimitedKeyHint}
          </Notice>
        </Show>
        <Show
          when={!keys.error() && !unread()}
          fallback={
            <Failed
              text={words().keysFailed}
              onRetry={() => {
                if (unread()) setUnread(false);
                else void keys.refresh();
              }}
            />
          }
        >
          <Show when={current()} fallback={<Loading rows={5} lines={2} />}>
            {(shown) => (
              <Show
                when={shown().keys.length}
                fallback={<Empty icon="key" text={words().keysEmpty} action={creatable() ? create : undefined} />}
              >
                {/* k2b-ui gap: virtualized list (lane MW); until it lands the section shows one API page of keys at a time. */}
                <For each={shown().keys}>
                  {(entry) => (
                    <Row
                      // k2b-ui gap: Row has no title for its full text; a long name is shortened in the middle, the open key shows it whole.
                      lines={[shortName(entry.name), second(entry)]}
                      icon={entry.expired || !entry.active ? "key-off" : "key"}
                      onOpen={() => setOpened(entry)}
                      end={
                        <>
                          <Show when={!entry.active || entry.expired}>
                            <Chip status={entry.active ? "warn" : "bad"}>{entry.active ? words().expired : t().revoked}</Chip>
                          </Show>
                          <Show when={entry.active}>
                            <Menu label={words().keyActions({ name: shortName(entry.name) })} items={deeds(entry)} />
                          </Show>
                        </>
                      }
                    />
                  )}
                </For>
              </Show>
            )}
          </Show>
        </Show>
      </Section>
      <Show when={pages() > 1}>
        <Bar
          start={<Text type="meta">{words().pageOf({ page: number(page()), pages: number(pages()) })}</Text>}
          end={
            <>
              <Button icon="chevron-left" disabled={page() <= 1 || keys.loading()} onClick={() => setPage((value) => value - 1)}>
                {words().previous}
              </Button>
              <Button forward disabled={page() >= pages() || keys.loading()} onClick={() => setPage((value) => value + 1)}>
                {words().next}
              </Button>
            </>
          }
        />
      </Show>
      <Show when={creating() && props.account.kind === "agent" ? props.account : undefined}>
        {(agent) => (
          <MachineKeyDialog
            account={{ id: agent().id, name: props.account.name }}
            modelsAvailable={props.modelsAvailable}
            timeZone={props.timeZone}
            close={(changed) => {
              setCreating(false);
              if (changed) void showChanges();
            }}
          />
        )}
      </Show>
      <KeyDialog entry={opened()} close={() => setOpened(null)} revoke={(entry) => void revoke(entry)} replace={replace} />
      <Show when={replacing()}>
        {(target) => (
          <ReplaceKeyDialog
            name={target().name}
            serviceAccountId={target().serviceAccountId}
            credentialId={target().credentialId}
            close={(changed) => {
              setReplacing(null);
              if (changed) void showChanges();
            }}
          />
        )}
      </Show>
    </>
  );
}
