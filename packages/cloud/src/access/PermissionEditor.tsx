import { mutation } from "@k2b/stdlib/solid";
import { IconButton, Placeholder, prompts, SelectChip, Tooltip, useLocale } from "@k2b/ui";
import { createMemo, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { CloudAvatar } from "../account/Avatar";
import type { AccessEntry, PermissionLevel, Principal, ServiceAccountKind } from "../contracts/shared";
import { groupDisplayName } from "../shared/account-display";
import { createGroupCoverage, type GroupCoverage, GroupCoveragePanel, GroupCoverageToggle } from "./GroupCoverage";
import { isManagerEntry } from "./managers";
import { accessMessages } from "./messages";
import PrincipalPicker from "./PrincipalPicker";
import { serviceAccountKindDisplay } from "./service-account-kind";

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
   *  display metadata lets deferred form drafts retain the selected name
   *  and, for service accounts, the kind shown in the row. */
  grantAccess: (
    principal: Principal,
    permission: GrantableLevel,
    display?: { displayName: string; serviceAccountKind?: ServiceAccountKind },
  ) => Promise<AccessEntry>;

  /** Update an existing entry's permission level. */
  updateAccess: (accessId: string, permission: GrantableLevel) => Promise<void>;

  /** Revoke an existing entry. Any entry can be revoked except the last
   *  manager: once exactly one entry manages the resource (`admin` for a
   *  person, group, all signed-in users, or a standalone or agent service
   *  account), its row can neither be lowered nor removed. */
  revokeAccess: (accessId: string) => Promise<void>;

  /** The entries that still apply when the resource lets one entry shadow
   *  another, such as a `none` that overrides the same principal's `admin`.
   *  The editor counts managers only among them, so pass the same function
   *  the service applies before `ensureManagerRemains()`. Defaults to every
   *  entry. */
  effectiveEntries?: (entries: readonly AccessEntry[]) => readonly AccessEntry[];

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
   *  afterwards. A function may restrict levels by principal (for example public read-only). */
  allowedLevels?: AllowedLevel[] | ((principal: Principal) => AllowedLevel[]);
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

const getEntryDisplayName = (entry: AccessEntry, t: ReturnType<typeof accessMessages.resolve>["t"], locale: string): string => {
  // Audiences always use the localized label; a server-supplied name is not translated.
  if (entry.principal.type === "authenticated") return t.allUsers;
  if (entry.principal.type === "public") return t.public;
  if (entry.displayName) return entry.principal.type === "group" ? groupDisplayName(entry.displayName, locale) : entry.displayName;
  if (entry.principal.type === "user") return entry.principal.userId;
  if (entry.principal.type === "service_account") return entry.principal.serviceAccountId;
  return entry.principal.groupId;
};

const getPrincipalIcon = (entry: AccessEntry, t: ReturnType<typeof accessMessages.resolve>["t"]): string => {
  switch (entry.principal.type) {
    case "user":
      return "ti-user";
    case "group":
      return "ti-users-group";
    case "service_account":
      return entry.serviceAccountKind ? serviceAccountKindDisplay(entry.serviceAccountKind, t).icon : "ti-key";
    case "authenticated":
      return "ti-lock-open-2";
    case "public":
      return "ti-world";
  }
};

// ─────────────────────────────────────────────────────────────────────────
// PermissionEditor
// ─────────────────────────────────────────────────────────────────────────

export default function PermissionEditor(props: PermissionEditorProps) {
  const locale = useLocale();
  const t = () => accessMessages.resolve([locale()]).t;
  // A store keeps each row's identity across level changes, so an expanded member list stays open. It holds
  // copies: store writes go into the objects themselves, and the caller's entries are not the editor's to change.
  const [entries, setEntries] = createStore<AccessEntry[]>(props.initialEntries.map((entry) => ({ ...entry })));
  const canEdit = () => props.canEdit !== false;
  const allowPublic = () => props.allowPublic === true;
  const allowAuthenticated = () => props.allowAuthenticated !== false;
  const allowed = (principal: Principal) =>
    resolveAllowedLevels(typeof props.allowedLevels === "function" ? props.allowedLevels(principal) : props.allowedLevels, t());

  // Defensive dev-warning: an empty allowedLevels array makes the editor
  // unable to grant anything.
  if (Array.isArray(props.allowedLevels) && props.allowedLevels.length === 0) {
    if (typeof console !== "undefined") {
      console.warn(
        "[PermissionEditor] `allowedLevels=[]` — the editor cannot grant any permission. Pass at least one level or omit the prop for the default View / Edit / Manage set.",
      );
    }
  }

  const grantMut = mutation.create({
    mutation: async (data: {
      principal: Principal;
      permission: GrantableLevel;
      display: { displayName: string; serviceAccountKind?: ServiceAccountKind };
    }) => props.grantAccess(data.principal, data.permission, data.display),
    onSuccess: (newEntry) => {
      setEntries(entries.length, { ...newEntry });
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
        setEntries((entry) => entry.id === result.accessId, "permission", result.permission);
      }
    },
    onError: (err) => prompts.error(err.message),
  });

  const revokeMut = mutation.create<string | null, AccessEntry>({
    mutation: async (entry) => {
      const displayName = getEntryDisplayName(entry, t(), locale());
      const confirmed = await prompts.confirm(t().removeAccessConfirm({ name: displayName }), {
        title: t().removeAccess,
        variant: "danger",
      });
      if (!confirmed) return null;
      await props.revokeAccess(entry.id);
      return entry.id;
    },
    onSuccess: (accessId) => {
      if (accessId) setEntries((current) => current.filter((entry) => entry.id !== accessId));
    },
    onError: (err) => prompts.error(err.message),
  });
  const busy = () => grantMut.loading() || updateMut.loading() || revokeMut.loading();
  // The service refuses to remove the last manager; the row says so up front.
  const lastManagerId = createMemo(() => {
    const managers = (props.effectiveEntries?.(entries) ?? entries).filter(isManagerEntry);
    return managers.length === 1 ? managers[0]!.id : null;
  });

  return (
    <div class="flex flex-col gap-3">
      {/* Existing entries */}
      <div class="flex flex-col gap-1">
        <For each={entries}>
          {(entry) => {
            // A row keeps its principal, so its group coverage is created once per row.
            const coverage = entry.principal.type === "group" ? createGroupCoverage(entry.principal.groupId) : undefined;
            return (
              <AccessEntryRow
                entry={entry}
                coverage={coverage}
                canEdit={canEdit()}
                disabled={busy()}
                lastManager={entry.id === lastManagerId()}
                allowed={allowed(entry.principal)}
                singlePicker={allowed(entry.principal).length === 1}
                onUpdatePermission={(permission) => {
                  if (!busy()) void updateMut.mutate({ accessId: entry.id, permission });
                }}
                onRevoke={() => {
                  if (!busy()) void revokeMut.mutate(entry);
                }}
              />
            );
          }}
        </For>
        <Show when={entries.length === 0}>
          <Placeholder align="left" class="px-1 py-2" description={t().noDirectGrants} />
        </Show>
      </div>

      {/* Add access — single Combobox, granted at the lowest allowed
          level on pick. The user upgrades via the row pill if they want
          a higher level. KISS: one decision per step. */}
      <Show when={canEdit()}>
        <PrincipalPicker
          existing={entries.map((e) => e.principal)}
          allowPublic={allowPublic()}
          allowAuthenticated={allowAuthenticated()}
          allowServiceAccounts={props.allowServiceAccounts}
          disabled={busy()}
          onSelect={(principal, display) => {
            const permission = allowed(principal)[0]?.level;
            if (permission && !busy()) grantMut.mutate({ principal, permission, display });
          }}
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
  /** The only entry that manages the resource: it keeps its level and cannot be removed. */
  lastManager: boolean;
  allowed: ResolvedLevel[];
  /** When true the per-row picker collapses to a non-interactive badge
   *  (single-level mode — there's nothing to switch to). */
  singlePicker: boolean;
  /** Present for group grants: who currently receives access through the group. */
  coverage?: GroupCoverage;
  onUpdatePermission: (permission: GrantableLevel) => void;
  onRevoke: () => void;
}) {
  const locale = useLocale();
  const t = () => accessMessages.resolve([locale()]).t;
  const displayName = () => getEntryDisplayName(props.entry, t(), locale());
  const display = () => resolveEntryDisplay(props.entry.permission, props.allowed, t());
  const manageLabel = () => resolveEntryDisplay("admin", props.allowed, t()).label;
  const removeLabel = () => (props.lastManager ? t().lastManager({ level: manageLabel() }) : t().remove({ name: displayName() }));
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
    <div>
      <div class="group/access-row flex items-center gap-2 py-1.5">
        <Show
          when={props.entry.principal.type === "user"}
          fallback={
            <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
              <i class={`ti ${getPrincipalIcon(props.entry, t())} text-sm`} />
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

        {/* Display name. Name and label share one line so every row keeps its height on phones:
          when both do not fit, each gets an equal share and the shorter one stays whole. A group's
          members toggle always stays whole; the name takes the rest. */}
        <div
          class="grid min-w-0 flex-1 auto-cols-[minmax(0,max-content)] grid-flow-col items-baseline gap-1"
          classList={{ "grid-cols-[minmax(0,max-content)_max-content]": props.coverage !== undefined }}
        >
          <span class="truncate text-sm">{displayName()}</span>
          <Show when={props.entry.principal.type === "public"}>
            <span class="truncate text-xs text-dimmed">({t().anyoneWithLink})</span>
          </Show>
          <Show
            when={
              props.entry.principal.type === "service_account" &&
              props.entry.serviceAccountKind &&
              serviceAccountKindDisplay(props.entry.serviceAccountKind, t()).label
            }
          >
            {(label) => <span class="truncate text-xs text-dimmed">({label()})</span>}
          </Show>
          <Show when={props.coverage}>{(coverage) => <GroupCoverageToggle coverage={coverage()} groupName={displayName()} />}</Show>
        </div>

        {/* Permission badge — interactive single-value picker when editable,
          plain span otherwise. */}
        <Show when={isInteractive()} fallback={<span class={`${badgeClass} cursor-default`}>{badgeContent}</span>}>
          <SelectChip
            aria-label={t().permissionFor({ name: displayName() })}
            value={() => props.entry.permission as GrantableLevel}
            options={props.allowed.map((option) => {
              const locked = props.lastManager && option.level !== "admin";
              return {
                value: option.level,
                label: option.label,
                icon: `ti ${option.icon}`,
                disabled: locked,
                description: locked ? t().lastManagerOption({ level: manageLabel() }) : undefined,
              };
            })}
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
            content={removeLabel()}
            class="shrink-0 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/access-row:opacity-100 sm:group-focus-within/access-row:opacity-100"
          >
            <IconButton
              type="button"
              label={t().remove({ name: displayName() })}
              variant="ghost"
              size="xs"
              onClick={props.onRevoke}
              disabled={props.disabled || props.lastManager}
              aria-label={t().remove({ name: displayName() })}
              // A disabled button takes no focus and touch has no hover, so the reason also reaches assistive technology.
              aria-description={props.lastManager ? removeLabel() : undefined}
              class="focus-ui flex h-7 w-7 items-center justify-center rounded text-zinc-400 transition-colors focus:opacity-100 enabled:hover:bg-red-500/[0.08] enabled:hover:text-red-600 dark:enabled:hover:text-red-400"
            >
              <i class="ti ti-x text-sm" />
            </IconButton>
          </Tooltip.Anchor>
        </Show>
      </div>
      {/* Expanding pushes the rows below down, only on the viewer's own request. */}
      <Show when={props.coverage}>{(coverage) => <GroupCoveragePanel coverage={coverage()} groupName={displayName()} />}</Show>
    </div>
  );
}
