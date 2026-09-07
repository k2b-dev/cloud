import { mutation } from "@k2b/stdlib/solid";
import { Button, Combobox, type ComboboxOption, IconButton, Placeholder, prompts, SelectChip, Tooltip, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { CloudAvatar } from "../account/Avatar";
import type { AccessEntry, PermissionLevel, Principal } from "../contracts/shared";
import { accessMessages } from "./messages";

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/** The three grantable permission levels — `"none"` exists in the
 *  contract for resolution semantics but is never directly granted. */
export type GrantableLevel = Exclude<PermissionLevel, "none">;

/** Either a bare level (uses the default View / Edit / Manage label and
 *  icon) or an object with per-context overrides. */
export type AllowedLevel = GrantableLevel | { level: GrantableLevel; label?: string; icon?: string };

type PermissionEditorProps = {
  /** Initial access entries — caller stays the source of truth for
   *  what's stored on the resource; the editor updates its local copy
   *  after successful mutations. */
  initialEntries: AccessEntry[];

  /** Whether the current user can edit permissions. When `false`, the
   *  editor renders the entries read-only — no row dropdowns, no
   *  delete buttons, no add form. */
  canEdit?: boolean;

  /** Grant access. The caller closes over the resource id. The optional
   *  display metadata lets deferred form drafts retain the selected name. */
  grantAccess: (principal: Principal, permission: GrantableLevel, display?: { displayName: string }) => Promise<AccessEntry>;

  /** Update an existing entry's permission level. */
  updateAccess: (accessId: string, permission: GrantableLevel) => Promise<void>;

  /** Revoke an existing entry. The last entry IS deletable — for
   *  hierarchical resources the parent ACL still applies. */
  revokeAccess: (accessId: string) => Promise<void>;

  /** Allow granting `public` access from this editor. */
  allowPublic?: boolean;

  /** Allow granting access to every authenticated user. Defaults to
   *  true; resources with an explicit principal allowlist can disable it. */
  allowAuthenticated?: boolean;

  /** Allow granting service accounts. Off by default so ordinary
   *  permission pickers stay user/group focused. */
  allowServiceAccounts?: boolean;

  /** Which levels the UI offers — and what they're called. Bare strings
   *  use the default labels (View / Edit / Manage). Objects override
   *  label and/or icon for per-context vocabulary (e.g. forms call
   *  write "Use", views call read "View"). When undefined, all three
   *  are offered with default labels. New entries are granted
   *  `allowedLevels[0]` on pick — the user upgrades via the row pill
   *  afterwards. */
  allowedLevels?: AllowedLevel[];
};

// ─────────────────────────────────────────────────────────────────────────
// Defaults & helpers
// ─────────────────────────────────────────────────────────────────────────

const defaultLabels = (t: ReturnType<typeof accessMessages.resolve>["t"]): Record<PermissionLevel, { label: string; icon: string }> => ({
  read: { label: t.view, icon: "ti-eye" },
  write: { label: t.edit, icon: "ti-pencil" },
  admin: { label: t.manage, icon: "ti-shield" },
  // Defensive — never granted by this editor, but renders correctly if
  // a legacy entry has permission === "none".
  none: { label: t.noAccess, icon: "ti-ban" },
});

type ResolvedLevel = {
  level: GrantableLevel;
  label: string;
  icon: string;
};

/** Resolve the AllowedLevel union into a flat shape the renderer can
 *  loop over. Falls back to the default View / Edit / Manage list when
 *  no override is given. */
const resolveAllowedLevels = (allowed: AllowedLevel[] | undefined, t: ReturnType<typeof accessMessages.resolve>["t"]): ResolvedLevel[] => {
  const defaults = defaultLabels(t);
  const list = allowed && allowed.length > 0 ? allowed : (["read", "write", "admin"] as GrantableLevel[]);
  return list.map((entry) => {
    const level = typeof entry === "string" ? entry : entry.level;
    const override = typeof entry === "string" ? null : entry;
    const def = defaults[level];
    return {
      level,
      label: override?.label ?? def.label,
      icon: override?.icon ?? def.icon,
    };
  });
};

/** Resolve a stored entry's permission to a renderable {label,icon},
 *  preferring the caller's allowedLevels override and falling back to
 *  the platform defaults. Tolerates "none" / unknown legacy values. */
const resolveEntryDisplay = (
  permission: PermissionLevel,
  allowed: ResolvedLevel[],
  t: ReturnType<typeof accessMessages.resolve>["t"],
): { label: string; icon: string } => {
  const fromAllowed = allowed.find((a) => a.level === permission);
  if (fromAllowed) return fromAllowed;
  const defaults = defaultLabels(t);
  return defaults[permission] ?? defaults.none;
};

const getEntryDisplayName = (entry: AccessEntry, t: ReturnType<typeof accessMessages.resolve>["t"]): string => {
  if (entry.displayName) return entry.displayName;
  if (entry.principal.type === "authenticated") return t.allUsers;
  if (entry.principal.type === "public") return t.public;
  if (entry.principal.type === "user") return entry.principal.userId;
  if (entry.principal.type === "service_account") return entry.principal.serviceAccountId;
  return entry.principal.groupId;
};

const getPrincipalIcon = (principal: Principal): string => {
  switch (principal.type) {
    case "user":
      return "ti-user";
    case "group":
      return "ti-users-group";
    case "service_account":
      return "ti-key";
    case "authenticated":
      return "ti-lock-open-2";
    case "public":
      return "ti-world";
  }
};

// Backend `/api/accounts/entities` shape (the subset we consume).
type ApiEntity =
  | { kind: "user"; user: { id: string; uid: string; displayName: string; mail: string | null } }
  | { kind: "group"; group: { id: string; name: string; description: string | null } }
  | {
      kind: "service_account";
      serviceAccount: {
        id: string;
        name: string;
        kind: "user_delegated" | "resource_bound";
        appId: string | null;
        resourceType: string | null;
        resourceId: string | null;
      };
    };

// ─────────────────────────────────────────────────────────────────────────
// PermissionEditor
// ─────────────────────────────────────────────────────────────────────────

export default function PermissionEditor(props: PermissionEditorProps) {
  const locale = useLocale();
  const t = () => accessMessages.resolve([locale()]).t;
  const [entries, setEntries] = createSignal<AccessEntry[]>([...props.initialEntries]);
  const canEdit = () => props.canEdit !== false;
  const allowPublic = () => props.allowPublic === true;
  const allowAuthenticated = () => props.allowAuthenticated !== false;
  const allowed = () => resolveAllowedLevels(props.allowedLevels, t());
  const isSinglePicker = () => allowed().length === 1;

  // Defensive dev-warning: an empty allowedLevels array makes the editor
  // unable to grant anything.
  if (props.allowedLevels && props.allowedLevels.length === 0) {
    if (typeof console !== "undefined") {
      console.warn(
        "[PermissionEditor] `allowedLevels=[]` — the editor cannot grant any permission. Pass at least one level or omit the prop for the default View / Edit / Manage set.",
      );
    }
  }

  const existingUserIds = () =>
    entries()
      .filter((e) => e.principal.type === "user")
      .map((e) => (e.principal as { type: "user"; userId: string }).userId);
  const existingGroupIds = () =>
    entries()
      .filter((e) => e.principal.type === "group")
      .map((e) => (e.principal as { type: "group"; groupId: string }).groupId);
  const existingServiceAccountIds = () =>
    entries()
      .filter((e) => e.principal.type === "service_account")
      .map((e) => (e.principal as { type: "service_account"; serviceAccountId: string }).serviceAccountId);
  const hasAuthenticatedEntry = () => entries().some((entry) => entry.principal.type === "authenticated");
  const hasPublicEntry = () => entries().some((entry) => entry.principal.type === "public");

  const grantMut = mutation.create({
    mutation: async (data: { principal: Principal; permission: GrantableLevel; display: { displayName: string } }) =>
      props.grantAccess(data.principal, data.permission, data.display),
    onSuccess: (newEntry) => {
      setEntries([...entries(), newEntry as AccessEntry]);
    },
    onError: (err) => prompts.error(err.message),
  });

  const updateMut = mutation.create<{ accessId: string; permission: GrantableLevel }, { accessId: string; permission: GrantableLevel }>({
    mutation: async (data) => {
      await props.updateAccess(data.accessId, data.permission);
      return data;
    },
    onSuccess: (result) => {
      if (result) {
        setEntries(entries().map((e) => (e.id === result.accessId ? { ...e, permission: result.permission } : e)));
      }
    },
    onError: (err) => prompts.error(err.message),
  });

  const revokeMut = mutation.create<string | null, AccessEntry>({
    mutation: async (entry) => {
      const displayName = getEntryDisplayName(entry, t());
      const confirmed = await prompts.confirm(t().removeAccessConfirm({ name: displayName }), {
        title: t().removeAccess,
        variant: "danger",
      });
      if (!confirmed) return null;
      await props.revokeAccess(entry.id);
      return entry.id;
    },
    onSuccess: (accessId) => {
      if (accessId) setEntries(entries().filter((entry) => entry.id !== accessId));
    },
    onError: (err) => prompts.error(err.message),
  });
  const busy = () => grantMut.loading() || updateMut.loading() || revokeMut.loading();

  // ── Combobox add-flow ─────────────────────────────────────────────────
  // The Combobox is a fire-and-forget input: type → pick → granted at the
  // lowest allowed level. The `principalsByOptId` map carries the original
  // discriminated principal across the ComboboxOption boundary so onSelect
  // can route it to grantAccess without re-parsing prefixed ids.
  let principalsByOptId = new Map<string, Principal>();

  const fetchPrincipals = async (q: string, signal: AbortSignal): Promise<ComboboxOption[]> => {
    const map = new Map<string, Principal>();
    const opts: ComboboxOption[] = [];

    // Synthetic principals — only when allowed AND not already granted.
    // Placed first so they're visible immediately on focus, before any
    // typing kicks off a backend request.
    if (allowAuthenticated() && !hasAuthenticatedEntry()) {
      map.set("auth", { type: "authenticated" });
      opts.push({
        id: "auth",
        label: t().allUsers,
        description: t().signedInDescription,
        icon: "ti-lock-open-2",
      });
    }
    if (allowPublic() && !hasPublicEntry()) {
      map.set("public", { type: "public" });
      opts.push({
        id: "public",
        label: t().public,
        description: t().publicDescription,
        icon: "ti-world",
      });
    }

    // Real entities require a query — avoid a wide listing on every focus.
    if (q.length >= 2) {
      const url = new URL("/api/accounts/entities", window.location.origin);
      url.searchParams.set("search", q);
      url.searchParams.set("kinds", props.allowServiceAccounts ? "user,group,service_account" : "user,group");
      url.searchParams.set("per_page", "10");
      const userIds = existingUserIds();
      if (userIds.length) url.searchParams.set("exclude_user_ids", userIds.join(","));
      const groupIds = existingGroupIds();
      if (groupIds.length) url.searchParams.set("exclude_group_ids", groupIds.join(","));
      const serviceAccountIds = existingServiceAccountIds();
      if (serviceAccountIds.length) url.searchParams.set("exclude_service_account_ids", serviceAccountIds.join(","));

      const res = await fetch(url.toString(), { credentials: "same-origin", signal });
      if (res.ok) {
        const data = (await res.json()) as { items?: ApiEntity[] };
        for (const item of data.items ?? []) {
          if (item.kind === "user") {
            const id = `u:${item.user.id}`;
            map.set(id, { type: "user", userId: item.user.id });
            opts.push({
              id,
              label: item.user.displayName,
              description: item.user.mail ?? item.user.uid,
              icon: "ti ti-user",
            });
          } else if (item.kind === "group") {
            const id = `g:${item.group.id}`;
            map.set(id, { type: "group", groupId: item.group.id });
            opts.push({
              id,
              label: item.group.name,
              description: item.group.description ?? undefined,
              icon: "ti ti-users-group",
            });
          } else if (item.kind === "service_account") {
            const id = `sa:${item.serviceAccount.id}`;
            map.set(id, { type: "service_account", serviceAccountId: item.serviceAccount.id });
            opts.push({
              id,
              label: item.serviceAccount.name,
              description:
                item.serviceAccount.kind === "user_delegated"
                  ? t().userBoundServiceAccount
                  : [item.serviceAccount.appId, item.serviceAccount.resourceType, item.serviceAccount.resourceId]
                      .filter(Boolean)
                      .join(" · "),
              icon: "ti ti-key",
            });
          }
        }
      }
    }

    principalsByOptId = map;
    return opts;
  };

  const handleSelect = (option: ComboboxOption) => {
    if (busy()) return;
    const principal = principalsByOptId.get(option.id);
    if (!principal) return;
    const firstLevel = allowed()[0]?.level;
    if (!firstLevel) return; // dev-warned above; bail silently
    grantMut.mutate({ principal, permission: firstLevel, display: { displayName: option.label } });
  };

  return (
    <div class="flex flex-col gap-3">
      {/* Existing entries */}
      <div class="flex flex-col gap-1">
        <For each={entries()}>
          {(entry) => (
            <AccessEntryRow
              entry={entry}
              canEdit={canEdit()}
              disabled={busy()}
              allowed={allowed()}
              singlePicker={isSinglePicker()}
              onUpdatePermission={(permission) => {
                if (!busy()) void updateMut.mutate({ accessId: entry.id, permission });
              }}
              onRevoke={() => {
                if (!busy()) void revokeMut.mutate(entry);
              }}
            />
          )}
        </For>
        <Show when={entries().length === 0}>
          <Placeholder align="left" class="px-1 py-2" description={t().noDirectGrants} />
        </Show>
      </div>

      {/* Add access — single Combobox, granted at the lowest allowed
          level on pick. The user upgrades via the row pill if they want
          a higher level. KISS: one decision per step. */}
      <Show when={canEdit()}>
        <Combobox
          placeholder={
            props.allowServiceAccounts
              ? allowAuthenticated()
                ? t().addAll
                : t().addService
              : allowAuthenticated()
                ? t().addAudience
                : t().addBasic
          }
          fetchData={fetchPrincipals}
          onSelect={handleSelect}
          disabled={busy()}
        />
      </Show>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Access Entry Row
// ─────────────────────────────────────────────────────────────────────────

function AccessEntryRow(props: {
  entry: AccessEntry;
  canEdit: boolean;
  disabled: boolean;
  allowed: ResolvedLevel[];
  /** When true the per-row picker collapses to a non-interactive badge
   *  (single-level mode — there's nothing to switch to). */
  singlePicker: boolean;
  onUpdatePermission: (permission: GrantableLevel) => void;
  onRevoke: () => void;
}) {
  const locale = useLocale();
  const t = () => accessMessages.resolve([locale()]).t;
  const displayName = () => getEntryDisplayName(props.entry, t());
  const display = () => resolveEntryDisplay(props.entry.permission, props.allowed, t());
  const isInteractive = () =>
    props.canEdit && !props.disabled && !props.singlePicker && props.allowed.some((option) => option.level === props.entry.permission);

  const badgeClass =
    "flex min-h-7 items-center gap-1 rounded-full border border-transparent bg-[var(--ui-surface-muted)] px-2.5 py-1 text-xs text-secondary";

  const badgeContent = (
    <>
      <i class={`ti ${display().icon}`} />
      <span>{display().label}</span>
      <Show when={isInteractive()}>
        <i class="ti ti-chevron-down text-[10px]" />
      </Show>
    </>
  );

  return (
    <div class="group/access-row flex items-center gap-2 py-1.5">
      <Show
        when={props.entry.principal.type === "user"}
        fallback={
          <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
            <i class={`ti ${getPrincipalIcon(props.entry.principal)} text-sm`} />
          </div>
        }
      >
        <CloudAvatar
          username={displayName()}
          userId={props.entry.principal.type === "user" ? props.entry.principal.userId : undefined}
          avatarHash={props.entry.avatarHash}
          size="xs"
          class="h-7 w-7"
        />
      </Show>

      {/* Display name */}
      <div class="min-w-0 flex-1">
        <span class="truncate text-sm">{displayName()}</span>
        <Show when={props.entry.principal.type === "public"}>
          <span class="ml-1 text-xs text-dimmed">({t().anyoneWithLink})</span>
        </Show>
      </div>

      {/* Permission badge — interactive single-value picker when editable,
          plain span otherwise. */}
      <Show when={isInteractive()} fallback={<span class={`${badgeClass} cursor-default`}>{badgeContent}</span>}>
        <SelectChip
          aria-label={t().permissionFor({ name: displayName() })}
          value={() => props.entry.permission as GrantableLevel}
          options={props.allowed.map((option) => ({
            value: option.level,
            label: option.label,
            icon: `ti ${option.icon}`,
          }))}
          icon={`ti ${display().icon}`}
          position="bottom-left"
          onValueChange={(permission) => {
            if (permission !== props.entry.permission) props.onUpdatePermission(permission);
          }}
        />
      </Show>

      {/* Destructive row actions stay quiet until the row is engaged. They
          remain keyboard reachable and stay visible on touch-sized layouts. */}
      <Show when={props.canEdit}>
        <Tooltip.Anchor
          content={t().remove({ name: displayName() })}
          class="shrink-0 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/access-row:opacity-100 sm:group-focus-within/access-row:opacity-100"
        >
          <IconButton
            type="button"
            label={t().remove({ name: displayName() })}
            variant="ghost"
            size="xs"
            onClick={props.onRevoke}
            disabled={props.disabled}
            aria-label={t().remove({ name: displayName() })}
            class="focus-ui flex h-7 w-7 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-red-500/[0.08] hover:text-red-600 focus:opacity-100 dark:hover:text-red-400"
          >
            <i class="ti ti-x text-sm" />
          </IconButton>
        </Tooltip.Anchor>
      </Show>
    </div>
  );
}
