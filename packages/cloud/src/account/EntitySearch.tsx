import { timed } from "@k2b/stdlib/solid";
import { Button, ScrollArea, TextInput } from "@k2b/ui";
import type { JSX } from "solid-js";
import { createSignal, For, Show } from "solid-js";
import { CloudAvatar } from "./Avatar";

/**
 * Discriminated principal returned to `onSelect`. Field names match the
 * platform `Principal` contract (`userId`/`groupId`) so callers can pass
 * `onSelect={grant}` directly via structural typing — the extra display
 * fields (uid, displayName, etc.) are silently ignored by `Principal`-
 * typed callbacks.
 */
export type EntitySearchPrincipal =
  | {
      type: "user";
      userId: string;
      uid: string;
      displayName: string;
      avatarHash: string | null;
      mail: string | null;
      provider: "ipa" | "local";
    }
  | {
      type: "group";
      groupId: string;
      provider: "ipa" | "local";
      name: string;
      description: string | null;
    }
  | {
      type: "service_account";
      serviceAccountId: string;
      name: string;
      kind: "user_delegated" | "resource_bound";
      appId: string | null;
      resourceType: string | null;
      resourceId: string | null;
    }
  | { type: "authenticated" }
  | { type: "public" };

type EntitySearchProps = {
  // ── Include flags (one per principal type, all default false) ────────
  /** Surface real user accounts in the result list. */
  includeUsers?: boolean;
  /** Surface real groups in the result list. */
  includeGroups?: boolean;
  /** Surface service accounts in the result list. Off by default. */
  includeServiceAccounts?: boolean;
  /** Inject a synthetic "All authenticated users" row at the top. */
  includeAuthenticated?: boolean;
  /** Inject a synthetic "Public" row at the top. */
  includePublic?: boolean;

  // ── Exclude filters (apply only when the related kind is included) ──
  excludeUserIds?: string[];
  excludeGroupIds?: string[];
  excludeServiceAccountIds?: string[];

  /** Provider filter — applies uniformly to BOTH users and groups.
   *  Whitelist semantics: `["local"]` shows only local accounts,
   *  `["ipa"]` only IPA. Empty / both / undefined → no filter.
   *  Backend accepts a single provider; this client only sends the
   *  filter when the array has exactly one entry, since both-allowed
   *  is identical to no-filter. */
  providers?: ("ipa" | "local")[];

  /** Restrict users to those who are members of at least one of these
   *  groups. User-side qualifier — only meaningful when
   *  `includeUsers` is true. */
  onlyMembersOf?: string[];

  // ── Output ──────────────────────────────────────────────────────────
  onSelect: (principal: EntitySearchPrincipal) => void;

  // ── Cosmetics ───────────────────────────────────────────────────────
  placeholder?: string;
  /** Override the result-list height. Default `h-48`. */
  resultsHeightClass?: string;
  /** Disables every "+" button in the result list while a parent-side
   *  mutation is in flight. */
  disabled?: boolean;
};

// Backend `/api/accounts/entities` shape (subset we consume here).
type ApiUser = {
  id: string;
  uid: string;
  displayName: string;
  avatarHash: string | null;
  mail: string | null;
  provider: "ipa" | "local";
};
type ApiGroup = {
  id: string;
  provider: "ipa" | "local";
  name: string;
  description: string | null;
};
type ApiServiceAccount = {
  id: string;
  name: string;
  kind: "user_delegated" | "resource_bound";
  appId: string | null;
  resourceType: string | null;
  resourceId: string | null;
};

const EntitySearch = (props: EntitySearchProps) => {
  const [search, setSearch] = createSignal("");
  const [users, setUsers] = createSignal<ApiUser[]>([]);
  const [groups, setGroups] = createSignal<ApiGroup[]>([]);
  const [serviceAccounts, setServiceAccounts] = createSignal<ApiServiceAccount[]>([]);
  const [loading, setLoading] = createSignal(false);

  // Defensive dev-warning: at least one principal kind must be enabled,
  // otherwise the component is decorative-only and the caller probably
  // forgot a flag.
  if (!props.includeUsers && !props.includeGroups && !props.includeServiceAccounts && !props.includeAuthenticated && !props.includePublic) {
    if (typeof console !== "undefined") {
      console.warn(
        "[EntitySearch] No `includeUsers / includeGroups / includeServiceAccounts / includeAuthenticated / includePublic` flag is set — the search will never produce a result.",
      );
    }
  }

  const doSearch = async (q: string) => {
    if (q.length < 2) {
      setUsers([]);
      setGroups([]);
      setServiceAccounts([]);
      return;
    }

    const kinds = [
      ...(props.includeUsers ? ["user"] : []),
      ...(props.includeGroups ? ["group"] : []),
      ...(props.includeServiceAccounts ? ["service_account"] : []),
    ];
    if (kinds.length === 0) {
      // Special-principals-only mode (e.g. `includeAuthenticated`).
      // Nothing to fetch from the backend; the synthetic rows render
      // unconditionally.
      setUsers([]);
      setGroups([]);
      setServiceAccounts([]);
      return;
    }

    setLoading(true);
    try {
      const url = new URL("/api/accounts/entities", window.location.origin);
      url.searchParams.set("search", q);
      url.searchParams.set("kinds", kinds.join(","));
      url.searchParams.set("per_page", "10");

      if (props.excludeUserIds?.length) {
        url.searchParams.set("exclude_user_ids", props.excludeUserIds.join(","));
      }
      if (props.excludeGroupIds?.length) {
        url.searchParams.set("exclude_group_ids", props.excludeGroupIds.join(","));
      }
      if (props.excludeServiceAccountIds?.length) {
        url.searchParams.set("exclude_service_account_ids", props.excludeServiceAccountIds.join(","));
      }
      if (props.onlyMembersOf?.length) {
        url.searchParams.set("user_member_of_group_ids", props.onlyMembersOf.join(","));
      }
      // Provider whitelist — only meaningful when restricting to a single
      // provider (both-allowed = no filter).
      if (props.providers?.length === 1) {
        url.searchParams.set("provider", props.providers[0]!);
      }

      const res = await fetch(url.toString(), { credentials: "same-origin" });
      if (res.ok) {
        const data = await res.json();
        const items: {
          kind: "user" | "group" | "service_account";
          user?: ApiUser;
          group?: ApiGroup;
          serviceAccount?: ApiServiceAccount;
        }[] = data.items ?? [];
        setUsers(items.filter((item) => item.kind === "user" && item.user).map((item) => item.user!));
        setGroups(items.filter((item) => item.kind === "group" && item.group).map((item) => item.group!));
        setServiceAccounts(
          items.filter((item) => item.kind === "service_account" && item.serviceAccount).map((item) => item.serviceAccount!),
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const { debouncedFn: debouncedSearch } = timed.debounce(doSearch, 300);

  const handleInput = (value: string) => {
    setSearch(value);
    debouncedSearch(value);
  };

  const resultsHeightClass = () => props.resultsHeightClass ?? "h-48";

  // Synthetic principals show whenever the flag is on — they're a
  // standing offer, not gated on the search query. They render at the
  // top of the list above real entities.
  const showSynthetic = () => props.includeAuthenticated || props.includePublic;
  const hasRealResults = () => users().length > 0 || groups().length > 0 || serviceAccounts().length > 0;
  const hasAnyResults = () => showSynthetic() || hasRealResults();

  return (
    <div class="flex flex-col gap-3">
      <TextInput icon="ti ti-search" placeholder={props.placeholder ?? "Search..."} value={() => search()} onValueChange={handleInput} />

      <ScrollArea class={`${resultsHeightClass()} `}>
        <Show when={loading()}>
          <div class="flex items-center justify-center py-8 text-dimmed">
            <i class="ti ti-loader-2 animate-spin text-xl" />
          </div>
        </Show>

        <Show when={!loading() && hasAnyResults()}>
          <div class="flex flex-col gap-1">
            {/* Synthetic principals — always available when their flag
                is on, irrespective of the search query. */}
            <Show when={props.includeAuthenticated}>
              <ResultRow
                icon="ti-lock-open-2"
                title="All users (incl. guests)"
                subtitle="Anyone signed in to the cloud"
                disabled={props.disabled}
                onSelect={() => props.onSelect({ type: "authenticated" })}
              />
            </Show>
            <Show when={props.includePublic}>
              <ResultRow
                icon="ti-world"
                title="Public"
                subtitle="Anyone with the link, even unauthenticated"
                disabled={props.disabled}
                onSelect={() => props.onSelect({ type: "public" })}
              />
            </Show>

            {/* Real entities — only after a search query. */}
            <For each={users()}>
              {(user) => (
                <ResultRow
                  icon="ti-user"
                  title={user.displayName}
                  subtitle={user.mail ? `${user.uid} · ${user.mail}` : user.uid}
                  avatar={<CloudAvatar username={user.displayName || user.uid} userId={user.id} avatarHash={user.avatarHash} size="sm" />}
                  disabled={props.disabled}
                  onSelect={() =>
                    props.onSelect({
                      type: "user",
                      userId: user.id,
                      uid: user.uid,
                      displayName: user.displayName,
                      avatarHash: user.avatarHash,
                      mail: user.mail,
                      provider: user.provider,
                    })
                  }
                />
              )}
            </For>
            <For each={groups()}>
              {(group) => (
                <ResultRow
                  icon="ti-users-group"
                  title={group.name}
                  subtitle={group.description ?? undefined}
                  disabled={props.disabled}
                  onSelect={() =>
                    props.onSelect({
                      type: "group",
                      groupId: group.id,
                      provider: group.provider,
                      name: group.name,
                      description: group.description,
                    })
                  }
                />
              )}
            </For>
            <For each={serviceAccounts()}>
              {(serviceAccount) => (
                <ResultRow
                  icon="ti-key"
                  title={serviceAccount.name}
                  subtitle={
                    serviceAccount.kind === "user_delegated"
                      ? "User-bound service account"
                      : [serviceAccount.appId, serviceAccount.resourceType, serviceAccount.resourceId].filter(Boolean).join(" · ")
                  }
                  disabled={props.disabled}
                  onSelect={() =>
                    props.onSelect({
                      type: "service_account",
                      serviceAccountId: serviceAccount.id,
                      name: serviceAccount.name,
                      kind: serviceAccount.kind,
                      appId: serviceAccount.appId,
                      resourceType: serviceAccount.resourceType,
                      resourceId: serviceAccount.resourceId,
                    })
                  }
                />
              )}
            </For>
          </div>
        </Show>

        <Show when={!loading() && !hasAnyResults() && search().length >= 2}>
          <p class="flex items-center justify-center gap-1.5 py-8 text-xs text-dimmed">
            <i class="ti ti-search-off text-sm" />
            No results found
          </p>
        </Show>

        <Show when={!loading() && !hasAnyResults() && search().length < 2}>
          <p class="flex items-center justify-center gap-1.5 py-8 text-xs text-dimmed">
            <i class="ti ti-search text-sm" />
            Type at least 2 characters
          </p>
        </Show>
      </ScrollArea>
    </div>
  );
};

const ResultRow = (props: {
  icon: string;
  title: string;
  subtitle?: string;
  avatar?: JSX.Element;
  disabled?: boolean;
  onSelect: () => void;
}) => (
  <Button onClick={props.onSelect} disabled={props.disabled} variant="ghost" class="w-full justify-start gap-3 text-left">
    <Show
      when={props.avatar}
      fallback={
        <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
          <i class={`ti ${props.icon} text-sm`} />
        </div>
      }
    >
      {props.avatar}
    </Show>
    <div class="min-w-0 flex-1">
      <div class="truncate text-sm font-medium">{props.title}</div>
      <Show when={props.subtitle}>
        <div class="truncate text-xs text-dimmed">{props.subtitle}</div>
      </Show>
    </div>
    <i class="ti ti-plus text-emerald-500" />
  </Button>
);

export default EntitySearch;
