import { mutation } from "@k2b/stdlib/solid";
import { announce, IconButton, Placeholder, prompts, SelectChip, Tooltip, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { CloudAvatar } from "../account/Avatar";
import type { AccessEntry, PermissionLevel, Principal, ServiceAccountKind } from "../contracts/shared";
import { createGroupCoverage, type GroupCoverage, GroupCoveragePanel, GroupCoverageToggle } from "./GroupCoverage";
import { isManagerEntry } from "./managers";
import { accessMessages } from "./messages";
import PrincipalPicker, { principalKey } from "./PrincipalPicker";
import { principalLabel } from "./principal-label";
import { serviceAccountKindDisplay } from "./service-account-kind";

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

/** The three grantable permission levels — `"none"` exists in the
 *  contract for resolution semantics but is never directly granted. */
export type GrantableLevel = Exclude<PermissionLevel, "none">;

/** Either a bare level (uses the default View / Edit / Manage label and
 *  icon) or an object with per-context overrides. A `scope` offers the level
 *  on a narrower part of the resource that the application defines, such as
 *  Mail's assigned conversations; it reaches the callbacks and matches the
 *  entry's `scope`. `description` explains an option in the level menu. */
export type AllowedLevel = GrantableLevel | { level: GrantableLevel; scope?: string; label?: string; icon?: string; description?: string };

type PermissionEditorProps = {
  /** The editor mounts from this list and merges later lists by entry id once no change is saving.
   *  Rows the caller changed since its last list win; unchanged rows keep the editor's confirmed result.
   *  Keep the editor mounted (no keyed Show or unmount during refresh) and pass refetched data. */
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
    display?: { displayName: string; avatarHash?: string | null; serviceAccountKind?: ServiceAccountKind },
    scope?: string,
  ) => Promise<AccessEntry>;

  /** Update an existing entry's permission level and, for a scoped level, its scope. */
  updateAccess: (accessId: string, permission: GrantableLevel, scope?: string) => Promise<void>;

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

  /** Allow granting service accounts. Defaults to true, including agents.
   *  Disable only when the resource documents a user-backed identity requirement. */
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
  scope: string | undefined;
  /** Unique per option: the level, prefixed by its scope. */
  key: string;
  label: string;
  icon: string;
  description: string | undefined;
};

const levelKey = (level: PermissionLevel, scope: string | undefined): string => (scope ? `${scope}:${level}` : level);

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
      scope: override?.scope,
      key: levelKey(level, override?.scope),
      label: override?.label ?? def.label,
      icon: override?.icon ?? def.icon,
      description: override?.description,
    };
  });
};

/** Resolve a stored entry's permission to a renderable {label,icon},
 *  preferring the caller's allowedLevels override and falling back to
 *  the platform defaults. Tolerates "none" / unknown legacy values. */
const resolveEntryDisplay = (
  permission: PermissionLevel,
  scope: string | undefined,
  allowed: ResolvedLevel[],
  t: ReturnType<typeof accessMessages.resolve>["t"],
): { label: string; icon: string } => {
  const fromAllowed = allowed.find((a) => a.key === levelKey(permission, scope));
  if (fromAllowed) return fromAllowed;
  const defaults = defaultLabels(t);
  return defaults[permission] ?? defaults.none;
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
  const initialEntries = props.initialEntries;
  let appliedCallerEntries = new Map(initialEntries.map((entry) => [entry.id, JSON.stringify(entry)]));
  const [entries, setEntries] = createStore<AccessEntry[]>(initialEntries.map((entry) => ({ ...entry })));
  const [pending, setPending] = createSignal<string | null>(null);
  const grantPending = () => pending() !== null;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
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

  const grant = async (
    principal: Principal,
    display: { displayName: string; avatarHash?: string | null; serviceAccountKind?: ServiceAccountKind },
  ) => {
    if (disposed || grantPending() || updateMut.loading() || revokeMut.loading()) return;
    const key = principalKey(principal);
    if (entries.some((entry) => principalKey(entry.principal) === key)) return;
    const first = allowed(principal)[0];
    if (!first) return;
    const id = `pending:${key}`;
    setPending(id);
    setEntries(entries.length, {
      id,
      principal,
      permission: first.level,
      scope: first.scope,
      createdAt: new Date().toISOString(),
      ...display,
    });
    try {
      const entry = await props.grantAccess(principal, first.level, display, first.scope);
      if (disposed) return;
      const index = entries.findIndex((entry) => entry.id === id);
      const saved = {
        ...entry,
        displayName: entry.displayName ?? display.displayName,
        avatarHash: entry.avatarHash !== undefined ? entry.avatarHash : display.avatarHash,
        serviceAccountKind: entry.serviceAccountKind ?? display.serviceAccountKind,
      };
      if (index !== -1) setEntries(index, reconcile(saved));
      announce(t().accessGranted({ name: principalLabel(saved, locale()) }));
    } catch (err) {
      if (!disposed) setEntries((current) => current.filter((entry) => entry.id !== id));
      // Prompts are global, so a grant that fails after its dialog closed still says so.
      if (!(typeof err === "object" && err !== null && "name" in err && err.name === "AbortError")) {
        prompts.error(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (!disposed) setPending(null);
    }
  };

  type LevelChange = { accessId: string; permission: GrantableLevel; scope: string | undefined };
  // The row whose change is saving: it shows the chosen level with a spinner, the other rows wait.
  const [updating, setUpdating] = createSignal<LevelChange | null>(null);
  const [revoking, setRevoking] = createSignal<string | null>(null);
  const updatingRow = (accessId: string) => {
    const change = updating();
    return change?.accessId === accessId ? change : undefined;
  };
  const updateMut = mutation.create<LevelChange, LevelChange>({
    mutation: async (data) => {
      setUpdating(data);
      await props.updateAccess(data.accessId, data.permission, data.scope);
      return data;
    },
    onSuccess: (result) => {
      if (result) {
        setEntries((entry) => entry.id === result.accessId, { permission: result.permission, scope: result.scope });
      }
    },
    onError: (err) => prompts.error(err.message),
    onFinally: () => {
      if (!disposed) setUpdating(null);
    },
  });

  const revokeMut = mutation.create<string | null, AccessEntry>({
    mutation: async (entry) => {
      const displayName = principalLabel(entry, locale());
      const confirmed = await prompts.confirm(t().removeAccessConfirm({ name: displayName }), {
        title: t().removeAccess,
        variant: "danger",
      });
      if (!confirmed) return null;
      setRevoking(entry.id);
      await props.revokeAccess(entry.id);
      return entry.id;
    },
    onSuccess: (accessId) => {
      if (accessId) setEntries((current) => current.filter((entry) => entry.id !== accessId));
    },
    onError: (err) => prompts.error(err.message),
    onFinally: () => {
      if (!disposed) setRevoking(null);
    },
  });
  const busy = () => grantPending() || updateMut.loading() || revokeMut.loading();
  createEffect(() => {
    const next = props.initialEntries;
    const nextCallerEntries = new Map(next.map((entry) => [entry.id, JSON.stringify(entry)]));
    // Mutation loading clears before onSuccess; wait for its local writes and onFinally too.
    if (busy() || updating() !== null || revoking() !== null) return;
    if (
      nextCallerEntries.size === appliedCallerEntries.size &&
      next.every((entry) => nextCallerEntries.get(entry.id) === appliedCallerEntries.get(entry.id))
    )
      return;
    // Rows the caller changed since its last list win; unchanged rows keep the editor's confirmed result.
    const localEntries = new Map(entries.map((entry) => [entry.id, entry]));
    const merged: AccessEntry[] = [];
    for (const entry of next) {
      const row = nextCallerEntries.get(entry.id) !== appliedCallerEntries.get(entry.id) ? entry : localEntries.get(entry.id);
      if (row) merged.push({ ...row });
    }
    for (const entry of entries) {
      if (!nextCallerEntries.has(entry.id) && !appliedCallerEntries.has(entry.id)) merged.push({ ...entry });
    }
    setEntries(reconcile(merged, { key: "id" }));
    appliedCallerEntries = nextCallerEntries;
  });
  // The service refuses to remove the last manager; the row says so up front.
  const lastManagerId = createMemo(() => {
    // A grant on part of the resource never manages it.
    const granted = entries.filter((entry) => entry.id !== pending());
    const managers = (props.effectiveEntries?.(granted) ?? granted).filter((entry) => !entry.scope && isManagerEntry(entry));
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
                pending={entry.id === pending()}
                updating={updatingRow(entry.id)}
                revoking={entry.id === revoking()}
                disabled={busy()}
                lastManager={entry.id === lastManagerId()}
                allowed={allowed(entry.principal)}
                singlePicker={allowed(entry.principal).length === 1}
                onUpdatePermission={(option) => {
                  if (!busy()) void updateMut.mutate({ accessId: entry.id, permission: option.level, scope: option.scope });
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
          readOnly={grantPending()}
          disabled={updateMut.loading() || revokeMut.loading()}
          onSelect={(principal, display) => void grant(principal, display)}
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
  /** Another change is saving: the row keeps its controls, disabled. */
  disabled: boolean;
  /** This row's grant is saving. */
  pending?: boolean;
  /** This row's level change is saving. */
  updating?: { permission: GrantableLevel; scope: string | undefined };
  /** This row's removal is saving. */
  revoking?: boolean;
  /** The only entry that manages the resource: it keeps its level and cannot be removed. */
  lastManager: boolean;
  allowed: ResolvedLevel[];
  /** When true the per-row picker collapses to a non-interactive badge
   *  (single-level mode — there's nothing to switch to). */
  singlePicker: boolean;
  /** Present for group grants: who currently receives access through the group. */
  coverage?: GroupCoverage;
  onUpdatePermission: (option: ResolvedLevel) => void;
  onRevoke: () => void;
}) {
  const locale = useLocale();
  const t = () => accessMessages.resolve([locale()]).t;
  const displayName = () => principalLabel(props.entry, locale());
  const entryKey = () => levelKey(props.entry.permission, props.entry.scope);
  const display = () => resolveEntryDisplay(props.entry.permission, props.entry.scope, props.allowed, t());
  const manageLabel = () => resolveEntryDisplay("admin", undefined, props.allowed, t()).label;
  const removeLabel = () => (props.lastManager ? t().lastManager({ level: manageLabel() }) : t().remove({ name: displayName() }));
  // Whether the row offers a picker depends only on what the viewer may do, never on a change in flight, so a
  // saving change never swaps the picker for the badge and the rows keep their size.
  const hasPicker = () => props.canEdit && !props.singlePicker && props.allowed.some((option) => option.key === entryKey());
  const saving = () => props.pending || props.updating !== undefined || props.revoking === true;
  // While a level change saves, the picker already shows the chosen level.
  const shownKey = () => (props.updating ? levelKey(props.updating.permission, props.updating.scope) : entryKey());
  const shownDisplay = () =>
    props.updating ? resolveEntryDisplay(props.updating.permission, props.updating.scope, props.allowed, t()) : display();

  const badgeClass =
    "flex min-h-7 items-center gap-1 rounded-full border border-transparent bg-[var(--ui-surface-muted)] px-2.5 py-1 text-xs text-secondary";

  const badgeContent = (
    <>
      <i class={props.pending ? "ti ti-loader-2 animate-spin" : `ti ${display().icon}`} />
      <span>{display().label}</span>
    </>
  );

  return (
    <div>
      <div class="group/access-row flex items-center gap-2 py-1.5" aria-busy={saving() ? "true" : undefined}>
        <Show
          when={props.entry.principal.type === "user"}
          fallback={
            <div class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-secondary dark:bg-zinc-700">
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
          <Show when={props.coverage}>
            {(coverage) => <GroupCoverageToggle coverage={coverage()} groupName={displayName()} disabled={props.pending} />}
          </Show>
        </div>

        {/* Permission badge — interactive single-value picker when editable,
          plain span otherwise. */}
        <Show when={hasPicker()} fallback={<span class={`${badgeClass} cursor-default`}>{badgeContent}</span>}>
          <SelectChip
            aria-label={t().permissionFor({ name: displayName() })}
            value={shownKey}
            disabled={props.disabled}
            loading={props.pending || props.updating !== undefined}
            options={props.allowed.map((option) => {
              const locked = props.lastManager && (option.level !== "admin" || option.scope !== undefined);
              return {
                value: option.key,
                label: option.label,
                icon: `ti ${option.icon}`,
                disabled: locked,
                description: locked ? t().lastManagerOption({ level: manageLabel() }) : option.description,
              };
            })}
            icon={`ti ${shownDisplay().icon}`}
            position="bottom-left"
            onValueChange={(key) => {
              const option = props.allowed.find((candidate) => candidate.key === key);
              if (option && key !== entryKey()) props.onUpdatePermission(option);
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
              disabled={props.disabled || props.pending || props.lastManager}
              loading={props.revoking}
              aria-label={t().remove({ name: displayName() })}
              // A disabled button takes no focus and touch has no hover, so the reason also reaches assistive technology.
              aria-description={props.lastManager ? removeLabel() : undefined}
              class="focus-ui flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors focus:opacity-100 enabled:hover:bg-red-500/[0.08] enabled:hover:text-red-600 dark:enabled:hover:text-red-400"
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
