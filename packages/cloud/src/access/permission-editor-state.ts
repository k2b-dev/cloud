import { mutation } from "@k2b/stdlib/solid";
import { announce } from "@k2b/ui";
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { AccessEntry, Principal, ServiceAccountKind } from "../contracts/shared";
import { isManagerEntry } from "./managers";
import { accessMessages } from "./messages";
import type { PermissionEditorProps } from "./PermissionEditor";
import { type GrantableLevel, type ResolvedLevel, resolveAllowedLevels } from "./permission-levels";
import { principalKey } from "./principal-key";
import { principalLabel } from "./principal-label";

/** What a look of the editor does where the rules need the page: ask, report an error, move the focus. */
export type PermissionEditorView = {
  confirm: (question: { title: string; body: string }) => Promise<boolean | undefined>;
  error: (message: string) => void;
  focusAdd: () => void;
  focusAfterRemoval: (index: number) => void;
};

/**
 * The state and rules of the permission editor, shared by its v1 and v2 looks: entries that apply at once (grant,
 * change, revoke one at a time), the caller's later lists merged by id, the last-manager guard, a failure with its
 * retry per row, and the selection before an expanded add.
 */
export function createPermissionEditorState(props: PermissionEditorProps, locale: () => string, view: PermissionEditorView) {
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
    else view.error(message);
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
  const allowed = (principal: Principal, kind?: ServiceAccountKind) => {
    const levels = resolveAllowedLevels(
      typeof props.allowedLevels === "function" ? props.allowedLevels(principal) : props.allowedLevels,
      t(),
    );
    const accountKind = kind ?? entries.find((entry) => principalKey(entry.principal) === principalKey(principal))?.serviceAccountKind;
    return accountKind === "code" ? levels.filter((option) => option.level !== "admin") : levels;
  };
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
        if (props.expanded) view.focusAdd();
      }
      return;
    }
    const first = choice ?? allowed(principal, display.serviceAccountKind)[0];
    if (display.serviceAccountKind === "code" && first?.level === "admin") return;
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
      if (props.expanded && granted) view.focusAdd();
    }
  };

  type LevelChange = { accessId: string; permission: GrantableLevel; scope: string | undefined };
  // The row whose change is saving: it shows the chosen level with a spinner, the other rows wait.
  const [updating, setUpdating] = createSignal<LevelChange | null>(null);
  const [revoking, setRevoking] = createSignal<string | null>(null);
  // The call that runs, also before its row saves: a check that throws first (`beforeChange`, the confirmation)
  // belongs to that row, so its failure speaks there with "Try again" as every other.
  let updateCall: LevelChange | undefined;
  let revokeCall: AccessEntry | undefined;
  const updatingRow = (accessId: string) => {
    const change = updating();
    return change?.accessId === accessId ? change : undefined;
  };
  const updateMut = mutation.create<LevelChange | null, LevelChange>({
    mutation: async (data) => {
      updateCall = data;
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
      const change = updating() ?? updateCall;
      if (change) failure(change.accessId, err, () => startUpdate(change));
      else view.error(err.message);
    },
    onFinally: () => {
      if (!disposed) setUpdating(null);
    },
  });

  const revokeMut = mutation.create<string | null, AccessEntry>({
    mutation: async (entry) => {
      revokeCall = entry;
      if (disposed || !canEdit()) return null;
      const displayName = labelOf(entry);
      const confirmed = props.beforeChange
        ? await props.beforeChange(entry, null)
        : await view.confirm({ title: t().removeAccess, body: t().removeAccessConfirm({ name: displayName }) });
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
      view.focusAfterRemoval(index);
    },
    onError: (err) => {
      const entry = entries.find((entry) => entry.id === (revoking() ?? revokeCall?.id));
      if (entry) failure(entry.id, err, () => startRevoke(entry));
      else view.error(err.message);
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
  const shareEntries = () => entries;
  // The service refuses to remove the last manager; the row says so up front.
  const lastManagerId = createMemo(() => {
    // A grant on part of the resource never manages it.
    const granted = shareEntries().filter((entry) => entry.id !== pending());
    const managers = (props.effectiveEntries?.(granted) ?? granted).filter((entry) => !entry.scope && isManagerEntry(entry));
    return managers.length === 1 ? managers[0]!.id : null;
  });

  return {
    t,
    entries,
    draft,
    setDraft,
    draftLevel,
    setDraftLevel,
    feedback,
    pending,
    grantPending,
    canEdit,
    allowPublic,
    allowAuthenticated,
    allowed,
    labelOf,
    grant,
    updating,
    revoking,
    updatingRow,
    saving,
    busy,
    canStart,
    startUpdate,
    startRevoke,
    shareEntries,
    lastManagerId,
    disposed: () => disposed,
  };
}
