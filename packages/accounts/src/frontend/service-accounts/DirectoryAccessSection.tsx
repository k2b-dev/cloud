import { PrincipalPicker } from "@k2b/cloud/access/ui";
import { coreClient } from "@k2b/cloud/clients/core";
import type { Principal } from "@k2b/cloud/contracts";
import { principalLabel } from "@k2b/cloud/shared";
import { mutation, query } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Empty, Failed, Field, Loading, Notice, Row, Section } from "@k2b/ui/v2";
import { createEffect, createSignal, For, Show } from "solid-js";
import { useAccountsMessages } from "../messages";
import { directoryMessages } from "./directory-messages";
import { useApiKeyMessages } from "./messages";

const api = coreClient.admin.identity["directory-shares"];
/** Entries per page, as the directory access list always showed them. */
export const DIRECTORY_PER_PAGE = 20;
type ExactPrincipal = Exclude<Principal, { type: "authenticated" } | { type: "public" }>;

/** One shared entry as `directoryShares.list` returns it. */
export type DirectoryEntry = {
  id: string;
  label: string;
  serviceAccountKind: string | null;
  principal: ExactPrincipal;
};

/** One page of an agent's directory shares: the answer of `directoryShares.list`. */
export type DirectoryPage = { items: readonly DirectoryEntry[]; total: number; page: number; perPage: number };

export type DirectoryAccessSectionProps = {
  /** The agent (a standalone service account) whose directory access this is. */
  account: { id: string; name: string };
  /** The first page the record's server read, so the first picture needs no loading; without it the section loads it. */
  initial?: DirectoryPage;
};

/**
 * Which directory entries an agent may find by name, as a section of its record: the shared people, groups and
 * accounts, one row each with a way to remove it, and the identity picker to add one. A failed change keeps the
 * entries and offers to repeat it; a page that failed to load offers a retry in its place.
 */
export default function DirectoryAccessSection(props: DirectoryAccessSectionProps) {
  const locale = useLocale();
  const accountsText = useAccountsMessages();
  const words = useApiKeyMessages();
  const t = () => directoryMessages.resolve([locale()]).t;
  const [page, setPage] = createSignal(1);
  const entries = query.create({
    source: () => ({ recipientId: props.account.id, page: page() }),
    isSameSource: (left, right) => left.recipientId === right.recipientId && left.page === right.page,
    initial: props.initial
      ? { source: { recipientId: props.account.id, page: 1 }, data: { ...props.initial, requestedPage: 1 } }
      : undefined,
    load: async (source, { abortSignal }) => {
      const response = await api[":recipientId"].$get(
        { param: { recipientId: source.recipientId }, query: { page: String(source.page), per_page: String(DIRECTORY_PER_PAGE) } },
        { init: { signal: abortSignal } },
      );
      const result = await response.json();
      if (!response.ok || !("items" in result)) throw new Error(t().loadFailed);
      return { ...result, requestedPage: source.page };
    },
  });
  const change = mutation.create({
    mutation: async (input: { principal: ExactPrincipal } | { id: string }, { abortSignal }) => {
      const recipientId = props.account.id;
      const response =
        "principal" in input
          ? await api[":recipientId"].$post(
              { param: { recipientId }, json: { principal: input.principal } },
              { init: { signal: abortSignal } },
            )
          : await api[":recipientId"][":id"].$delete({ param: { recipientId, id: input.id } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(t().failed);
    },
    onSuccess: () => {
      entries.refresh();
    },
  });
  // Only the answer for the page asked for counts.
  const current = () => (entries.data()?.requestedPage === page() ? entries.data() : undefined);
  // A removal can empty the last page: show the page before it.
  createEffect(() => {
    const snapshot = current();
    if (!entries.loading() && !entries.refreshing() && !entries.error() && snapshot && !snapshot.items.length && page() > 1)
      setPage(Math.max(1, Math.ceil(snapshot.total / DIRECTORY_PER_PAGE)));
  });
  const loading = () => entries.loading() || entries.refreshing() || change.loading();
  const blocked = () => loading() || Boolean(entries.error());
  const kindWord = (kind: string | null) =>
    kind === "resource_bound"
      ? accountsText().resourceBoundServiceAccount
      : kind === "user_delegated"
        ? accountsText().userBoundServiceAccount
        : accountsText().agentServiceAccount;

  return (
    <>
      <Section
        title={t().title}
        icon="address-book"
        count={current() ? new Intl.NumberFormat(locale()).format(current()!.total) : undefined}
        summary={t().hint}
      >
        <Show when={change.error()}>
          {(error) => (
            <Notice
              tone="bad"
              actions={[{ label: words().repeatChange, icon: "refresh", disabled: change.loading(), onClick: () => void change.retry() }]}
            >
              {error().message}
            </Notice>
          )}
        </Show>
        <Field label={words().addEntry}>
          {/* k2b-ui gap: no v2 identity picker; the platform's PrincipalPicker (v1) stands in until @k2b/cloud has one. */}
          <PrincipalPicker
            allowAuthenticated={false}
            allowPublic={false}
            // every kind but Code accounts, which are found by their handle with a resource target only, never by name
            serviceAccountKinds={["user_delegated", "resource_bound", "standalone", "agent"]}
            disabled={blocked()}
            onSelect={(principal) => {
              if (principal.type !== "authenticated" && principal.type !== "public") void change.mutate({ principal });
            }}
          />
        </Field>
        <Show when={!entries.error()} fallback={<Failed text={t().loadFailed} onRetry={() => entries.refresh()} />}>
          <Show when={!loading() && current()} fallback={<Loading rows={3} />}>
            {(snapshot) => (
              <Show when={snapshot().items.length} fallback={<Empty icon="address-book" text={t().empty} />}>
                <For each={snapshot().items}>
                  {(entry) => (
                    <Row
                      lines={[principalLabel({ principal: entry.principal, displayName: entry.label }, locale())]}
                      meta={entry.principal.type === "service_account" ? kindWord(entry.serviceAccountKind) : undefined}
                      icon={entry.principal.type === "group" ? "users-group" : entry.principal.type === "user" ? "user" : "robot"}
                      end={
                        <Button
                          variant="ghost"
                          icon="x"
                          label={`${t().revoke}: ${entry.label}`}
                          disabled={blocked()}
                          onClick={() => void change.mutate({ id: entry.id })}
                        />
                      }
                    />
                  )}
                </For>
              </Show>
            )}
          </Show>
        </Show>
      </Section>
      <Show when={(current()?.total ?? 0) > DIRECTORY_PER_PAGE || page() > 1}>
        <Bar
          end={
            <>
              <Button icon="chevron-left" disabled={blocked() || page() === 1} onClick={() => setPage((value) => value - 1)}>
                {t().previous}
              </Button>
              <Button
                forward
                disabled={blocked() || page() * DIRECTORY_PER_PAGE >= (current()?.total ?? 0)}
                onClick={() => setPage((value) => value + 1)}
              >
                {t().next}
              </Button>
            </>
          }
        />
      </Show>
    </>
  );
}
