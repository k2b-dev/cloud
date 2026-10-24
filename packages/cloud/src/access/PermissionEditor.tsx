import { mutation } from "@k2b/stdlib/solid";
import { announce, Button, IconButton, Placeholder, prompts, Select, SelectChip, Tooltip, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { CloudAvatar } from "../account/Avatar";
import type { AccessEntry, PermissionLevel, Principal, ServiceAccountKind, ServiceAccountStatus } from "../contracts/shared";
import { createGroupCoverage, type GroupCoverage, GroupCoveragePanel, GroupCoverageToggle } from "./GroupCoverage";
import { isManagerEntry } from "./managers";
import { accessMessages } from "./messages";
import PrincipalAvatar from "./PrincipalAvatar";
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
  /** Expanded form: choose a principal and level before adding; show durable inline feedback. */
  expanded?: boolean;
  /** Mark these entries as the viewer's own grants in the expanded form. */
  ownEntryIds?: readonly string[];
  /** Confirm a consequential change. When supplied, replaces the default removal confirmation. */
  beforeChange?: (entry: AccessEntry, next: GrantableLevel | null) => Promise<boolean>;

  /** The editor mounts from this list and merges later lists by entry id once no change is saving.
   *  Rows the caller changed since its last list win; unchanged rows keep the editor's confirmed result.
   *  Keep the editor mounted (no keyed Show or unmount during refresh) and pass refetched data. */
  initialEntries: AccessEntry[];

  /** Whether the current user can edit permissions. When `false`, the
   *  editor renders the entries read-only — no row dropdowns, no
   *  delete buttons, no add form. When it becomes `true` again, failed
   *  changes and their retries are cleared, so re-enable editing only
   *  after the list passed in is canonical again. In expanded mode the caller
   *  explains why editing stopped; row errors leave with editing. */
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
  /** Optional directory filters for the resource's accepted credential kinds. */
  serviceAccountKinds?: ServiceAccountKind[];
  /** Grant selection defaults to active accounts; existing entries are unaffected. */
  serviceAccountStatus?: ServiceAccountStatus;

  /** The principal search's placeholder, in the consumer's terms. Defaults to the principal kinds it offers. */
  placeholder?: string;

  /** The consumer's name and description for every signed-in person, in rows and in the principal search. */
  signedIn?: { label: string; description: string };

  /** Expanded form: a row's subtitle instead of its principal kind, such as a group's member count. */
  entryDetail?: (entry: AccessEntry) => string | undefined;

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
  type Draft = {
    principal: Principal;
    display: { displayName: string; avatarHash?: string | null; serviceAccountKind?: ServiceAccountKind };
  };
  const [draft, setDraft] = createSignal<Draft>();
  const [draftLevel, setDraftLevel] = createSignal("read");
  const [feedback, setFeedback] = createStore<Record<string, { message: string; retry?: () => void } | undefined>>({});
  const failure = (id: string, error: unknown, retry: () => void) => {
    const message = error instanceof Error ? error.message : String(error);
    if (props.expanded) setFeedback(id, { message, retry });
    else prompts.error(message);
  };
  const saved = (id: string) => {
    if (props.expanded) setFeedback(id, { message: t().saved });
  };
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
  const labelOf = (entry: AccessEntry) =>
    entry.principal.type === "authenticated" && props.signedIn ? props.signedIn.label : principalLabel(entry, locale());

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
    choice?: ResolvedLevel,
  ) => {
    if (!canStart()) return;
    const key = principalKey(principal);
    if (entries.some((entry) => principalKey(entry.principal) === key)) {
      // A retry or selection for a principal already in the list has nothing left to add.
      setFeedback("add", undefined);
      if (draft() && principalKey(draft()!.principal) === key) {
        setDraft(undefined);
        if (props.expanded) focusPrincipalPicker();
      }
      return;
    }
    const first = choice ?? allowed(principal)[0];
    if (!first) return;
    const id = `pending:${key}`;
    let granted = false;
    setPending(id);
    setFeedback("add", undefined);
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
      announce(t().accessGranted({ name: labelOf(saved) }));
      setDraft(undefined);
      granted = true;
      if (props.expanded) setFeedback(saved.id, { message: t().saved });
    } catch (err) {
      if (!disposed) setEntries((current) => current.filter((entry) => entry.id !== id));
      // Prompts are global, so a grant that fails after its dialog closed still says so.
      if (!(typeof err === "object" && err !== null && "name" in err && err.name === "AbortError")) {
        failure("add", err, () => void grant(principal, display, first));
      }
    } finally {
      if (!disposed) setPending(null);
      if (props.expanded && granted) focusPrincipalPicker();
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
  const updateMut = mutation.create<LevelChange | null, LevelChange>({
    mutation: async (data) => {
      const entry = entries.find((entry) => entry.id === data.accessId);
      if (!entry || disposed || !canEdit()) return null;
      if (props.beforeChange && !(await props.beforeChange(entry, data.permission))) return null;
      if (disposed || !canEdit()) return null;
      setUpdating(data);
      setFeedback(data.accessId, undefined);
      await props.updateAccess(data.accessId, data.permission, data.scope);
      return data;
    },
    onSuccess: (result) => {
      if (result) {
        setEntries((entry) => entry.id === result.accessId, { permission: result.permission, scope: result.scope });
        saved(result.accessId);
      }
    },
    onError: (err) => {
      const change = updating();
      if (change) failure(change.accessId, err, () => startUpdate(change));
      else prompts.error(err.message);
    },
    onFinally: () => {
      if (!disposed) setUpdating(null);
    },
  });

  const revokeMut = mutation.create<string | null, AccessEntry>({
    mutation: async (entry) => {
      if (disposed || !canEdit()) return null;
      const displayName = labelOf(entry);
      const confirmed = props.beforeChange
        ? await props.beforeChange(entry, null)
        : await prompts.confirm(t().removeAccessConfirm({ name: displayName }), {
            title: t().removeAccess,
            variant: "danger",
          });
      if (!confirmed || disposed || !canEdit()) return null;
      setRevoking(entry.id);
      setFeedback(entry.id, undefined);
      await props.revokeAccess(entry.id);
      return entry.id;
    },
    onSuccess: (accessId) => {
      if (!accessId) return;
      const index = entries.findIndex((entry) => entry.id === accessId);
      setEntries((current) => current.filter((entry) => entry.id !== accessId));
      focusAfterRemoval(index);
    },
    onError: (err) => {
      const entry = entries.find((entry) => entry.id === revoking());
      if (entry) failure(entry.id, err, () => startRevoke(entry));
      else prompts.error(err.message);
    },
    onFinally: () => {
      if (!disposed) setRevoking(null);
    },
  });
  // Confirmation holds the operation lock, but its opener must stay focusable until the dialog returns focus.
  const saving = () => grantPending() || updating() !== null || revoking() !== null;
  const busy = () => saving() || updateMut.loading() || revokeMut.loading();
  const canStart = () => !disposed && canEdit() && !busy();
  const startUpdate = (change: LevelChange): void => {
    if (canStart()) void updateMut.mutate(change);
  };
  const startRevoke = (entry: AccessEntry): void => {
    if (canStart()) void revokeMut.mutate(entry);
  };
  let editorRoot: HTMLDivElement | undefined;
  let principalPickerHost: HTMLDivElement | undefined;
  const focusPrincipalPicker = () => {
    queueMicrotask(() => {
      if (!disposed && canEdit() && !busy()) principalPickerHost?.querySelector<HTMLInputElement>('input[role="combobox"]')?.focus();
    });
  };
  // A removed row takes its focused button along; continue at the neighbouring row, else the principal search.
  const focusAfterRemoval = (index: number) => {
    queueMicrotask(() => {
      if (disposed || busy()) return;
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      const removes = Array.from(editorRoot?.querySelectorAll<HTMLButtonElement>("button[data-access-remove]") ?? []);
      const next = [removes[index], removes[index - 1]].find((button) => button && !button.disabled);
      (next ?? editorRoot?.querySelector<HTMLInputElement>('input[role="combobox"]:enabled'))?.focus();
    });
  };
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
  // Editing returns once the caller has the canonical list again, even an unchanged one: earlier failures and their
  // retries no longer apply. Rows, confirmations and an unrelated selection stay.
  createEffect(
    on(canEdit, (editable, wasEditable) => {
      if (!editable || wasEditable !== false) return;
      for (const [id, state] of Object.entries(feedback)) if (state?.retry) setFeedback(id, undefined);
      const selection = draft();
      if (selection && entries.some((entry) => principalKey(entry.principal) === principalKey(selection.principal))) setDraft(undefined);
    }),
  );
  // The service refuses to remove the last manager; the row says so up front.
  const lastManagerId = createMemo(() => {
    // A grant on part of the resource never manages it.
    const granted = entries.filter((entry) => entry.id !== pending());
    const managers = (props.effectiveEntries?.(granted) ?? granted).filter((entry) => !entry.scope && isManagerEntry(entry));
    return managers.length === 1 ? managers[0]!.id : null;
  });

  return (
    <div
      ref={editorRoot}
      class={props.expanded ? "flex flex-col gap-4" : "flex flex-col gap-3"}
      style={
        props.expanded
          ? { "--k2b-field-surface": "var(--k2b-surface)", "--k2b-field-border": "var(--k2b-border)", "--k2b-field-font-size": "15px" }
          : undefined
      }
    >
      <Show when={props.expanded && canEdit()}>
        {/* Every control in the row stretches to the 36px field height, including the selection that replaces the search. */}
        <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_176px_auto]">
          <div ref={principalPickerHost} class="col-span-2 flex min-w-0 flex-col sm:col-span-1">
            <Show
              when={draft()}
              fallback={
                <PrincipalPicker
                  existing={entries.map((entry) => entry.principal)}
                  allowPublic={allowPublic()}
                  allowAuthenticated={allowAuthenticated()}
                  allowServiceAccounts={props.allowServiceAccounts}
                  serviceAccountKinds={props.serviceAccountKinds}
                  serviceAccountStatus={props.serviceAccountStatus ?? "active"}
                  placeholder={props.placeholder}
                  signedIn={props.signedIn}
                  disabled={saving()}
                  onSelect={(principal, display) => {
                    if (!canStart()) return;
                    setDraft({ principal, display });
                    setDraftLevel(allowed(principal)[0]?.key ?? "read");
                  }}
                />
              }
            >
              {(selection) => (
                <Button
                  variant="input"
                  style={{ "font-size": "15px" }}
                  align="start"
                  disabled={saving()}
                  class="w-full font-normal"
                  aria-label={t().clearSelection({ name: selection().display.displayName })}
                  onClick={() => {
                    if (!canStart()) return;
                    setDraft(undefined);
                    focusPrincipalPicker();
                  }}
                >
                  <span class="min-w-0 flex-1 truncate">{selection().display.displayName}</span>
                  <i class="ti ti-x" aria-hidden="true" />
                </Button>
              )}
            </Show>
          </div>
          <Select
            aria-label={t().newPermission}
            value={draftLevel}
            disabled={saving()}
            options={allowed(draft()?.principal ?? { type: "user", userId: "" }).map((option) => ({
              value: option.key,
              label: option.label,
            }))}
            onValueChange={(value) => {
              if (value && canStart()) setDraftLevel(value);
            }}
          />
          <Button
            style={{ "font-size": "15px" }}
            disabled={!draft() || saving()}
            loading={grantPending()}
            onClick={() => {
              const selection = draft();
              if (selection)
                void grant(
                  selection.principal,
                  selection.display,
                  allowed(selection.principal).find((option) => option.key === draftLevel()),
                );
            }}
          >
            {t().add}
          </Button>
        </div>
        <Show when={feedback.add}>
          {(state) => (
            <div role="alert" class="text-sm text-danger">
              {state().message}{" "}
              <Button variant="text" disabled={saving()} onClick={() => state().retry?.()}>
                {t().retry}
              </Button>
            </div>
          )}
        </Show>
      </Show>
      {/* Existing entries */}
      <div class={props.expanded ? "flex flex-col" : "flex flex-col gap-1"}>
        <For each={entries}>
          {(entry) => {
            // A row keeps its principal, so its group coverage is created once per row. Expanded rows name the
            // group's size in their subtitle instead.
            const coverage = entry.principal.type === "group" && !props.expanded ? createGroupCoverage(entry.principal.groupId) : undefined;
            return (
              <AccessEntryRow
                entry={entry}
                label={labelOf(entry)}
                detail={props.expanded ? props.entryDetail?.(entry) : undefined}
                signedInDescription={props.signedIn?.description}
                expanded={props.expanded}
                ownEntry={props.ownEntryIds?.includes(entry.id)}
                feedback={feedback[entry.id]}
                coverage={coverage}
                canEdit={canEdit()}
                pending={entry.id === pending()}
                updating={updatingRow(entry.id)}
                revoking={entry.id === revoking()}
                disabled={saving()}
                lastManager={entry.id === lastManagerId()}
                allowed={allowed(entry.principal)}
                singlePicker={allowed(entry.principal).length === 1}
                onUpdatePermission={(option) => {
                  startUpdate({ accessId: entry.id, permission: option.level, scope: option.scope });
                }}
                onRevoke={() => startRevoke(entry)}
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
      <Show when={canEdit() && !props.expanded}>
        <PrincipalPicker
          existing={entries.map((e) => e.principal)}
          allowPublic={allowPublic()}
          allowAuthenticated={allowAuthenticated()}
          allowServiceAccounts={props.allowServiceAccounts}
          serviceAccountKinds={props.serviceAccountKinds}
          serviceAccountStatus={props.serviceAccountStatus ?? "active"}
          placeholder={props.placeholder}
          signedIn={props.signedIn}
          readOnly={grantPending()}
          disabled={updating() !== null || revoking() !== null}
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
  label: string;
  /** Replaces the expanded subtitle's principal kind. */
  detail?: string;
  signedInDescription?: string;
  expanded?: boolean;
  ownEntry?: boolean;
  feedback?: { message: string; retry?: () => void };
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
  const displayName = () => props.label;
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
      <div
        class={
          props.expanded
            ? "group/access-row grid min-h-[52px] grid-cols-[32px_minmax(0,1fr)_36px] items-center gap-x-3 gap-y-1.5 rounded-[var(--ui-radius-control)] py-2 sm:flex sm:px-2 sm:py-1.5 sm:hover:bg-[var(--ui-surface-subtle)]"
            : "group/access-row flex items-center gap-2 py-1.5"
        }
        aria-busy={saving() ? "true" : undefined}
      >
        <Show when={!props.expanded} fallback={<PrincipalAvatar entry={props.entry} label={displayName()} />}>
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
        </Show>

        {/* Display name. Name and label share one line so every row keeps its height on phones:
          when both do not fit, each gets an equal share and the shorter one stays whole. A group's
          members toggle always stays whole; the name takes the rest. */}
        <div
          class={
            props.expanded ? "min-w-0 flex-1" : "grid min-w-0 flex-1 auto-cols-[minmax(0,max-content)] grid-flow-col items-baseline gap-1"
          }
          classList={{ "grid-cols-[minmax(0,max-content)_max-content]": props.coverage !== undefined }}
        >
          <span class={props.expanded ? "block truncate text-[15px] font-medium" : "truncate text-sm"}>{displayName()}</span>
          <Show when={props.expanded}>
            <span class="block text-[13px] text-dimmed">
              {props.detail ??
                (props.entry.principal.type === "user"
                  ? t().person
                  : props.entry.principal.type === "group"
                    ? t().group
                    : props.entry.principal.type === "authenticated"
                      ? (props.signedInDescription ?? t().signedInDescription)
                      : props.entry.principal.type === "service_account"
                        ? (props.entry.serviceAccountKind && serviceAccountKindDisplay(props.entry.serviceAccountKind, t()).label) ||
                          t().standaloneServiceAccount
                        : "")}
              <Show when={props.ownEntry}> · {t().you}</Show>
            </span>
          </Show>
          <Show when={props.entry.principal.type === "public"}>
            <span class="truncate text-xs text-dimmed">({t().anyoneWithLink})</span>
          </Show>
          <Show
            when={
              !props.expanded &&
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

        <Show when={props.expanded}>
          <span class="col-start-3 row-start-2 w-5 text-center text-sm" role="status">
            <Show
              when={saving()}
              fallback={
                <Show when={props.feedback && !props.feedback.retry}>
                  <>
                    <i class="ti ti-check text-success" aria-hidden="true" />
                    <span class="sr-only">{t().saved}</span>
                  </>
                </Show>
              }
            >
              <>
                <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />
                <span class="sr-only">{t().saving}</span>
              </>
            </Show>
          </span>
        </Show>

        {/* Permission badge — interactive single-value picker when editable,
          plain span otherwise. */}
        <div class={props.expanded ? "col-start-2 row-start-2 min-w-0 sm:w-44 sm:flex-none" : "contents"}>
          <Show
            when={props.expanded}
            fallback={
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
            }
          >
            <Select
              aria-label={t().permissionFor({ name: displayName() })}
              value={shownKey}
              disabled={props.disabled || !props.canEdit || props.singlePicker}
              options={props.allowed.map((option) => ({
                value: option.key,
                label: option.label,
                disabled: props.lastManager && option.level !== "admin",
              }))}
              onValueChange={(key) => {
                const option = props.allowed.find((candidate) => candidate.key === key);
                if (option && key !== entryKey()) props.onUpdatePermission(option);
              }}
            />
          </Show>
        </div>

        {/* Destructive row actions stay quiet until the row is engaged. They
          remain keyboard reachable and stay visible on touch-sized layouts. */}
        <Show when={props.canEdit}>
          <Tooltip.Anchor
            content={removeLabel()}
            class={
              props.expanded
                ? "col-start-3 row-start-1 shrink-0"
                : "shrink-0 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/access-row:opacity-100 sm:group-focus-within/access-row:opacity-100"
            }
          >
            <IconButton
              type="button"
              label={t().remove({ name: displayName() })}
              variant="ghost"
              size={props.expanded ? "md" : "xs"}
              onClick={props.onRevoke}
              disabled={props.disabled || props.pending || props.lastManager}
              loading={props.revoking}
              aria-label={t().remove({ name: displayName() })}
              // A disabled button takes no focus and touch has no hover, so the reason also reaches assistive technology.
              aria-description={props.lastManager ? removeLabel() : undefined}
              data-access-remove=""
              style={props.expanded ? { width: "2.25rem", height: "2.25rem", "min-height": "2.25rem" } : undefined}
              class="focus-ui flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors focus:opacity-100 enabled:hover:bg-red-500/[0.08] enabled:hover:text-red-600 dark:enabled:hover:text-red-400"
            >
              <i class={props.expanded ? "ti ti-x text-lg" : "ti ti-x text-sm"} />
            </IconButton>
          </Tooltip.Anchor>
        </Show>
      </div>
      <Show when={props.expanded && props.lastManager && props.canEdit}>
        <p class="pb-2 pl-11 text-[13px] text-dimmed sm:pl-13">{t().lastManager({ level: manageLabel() })}</p>
      </Show>
      <Show when={props.expanded && props.canEdit && props.feedback?.retry}>
        <div role="alert" class="pl-11 text-[13px] text-danger sm:pl-13">
          {props.feedback?.message}{" "}
          <Button variant="text" disabled={props.disabled} onClick={() => props.feedback?.retry?.()}>
            {t().retry}
          </Button>
        </div>
      </Show>
      {/* Expanding pushes the rows below down, only on the viewer's own request. */}
      <Show when={props.coverage}>{(coverage) => <GroupCoveragePanel coverage={coverage()} groupName={displayName()} />}</Show>
    </div>
  );
}
