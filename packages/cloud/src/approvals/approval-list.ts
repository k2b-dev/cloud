import { createMemo, createSignal, onMount } from "solid-js";
import { refreshAppBadges } from "../browser/app-badges";
import { coreClient } from "../clients/core";
import type { ApprovalDraftResult } from "../contracts/approvals";
import {
  type ApprovalDecisionInput,
  type ApprovalListQuery,
  type ApprovalPage,
  ApprovalPageSchema,
  type PendingApproval,
} from "../contracts/approvals";
import { editApprovalDraft } from "./draft";

/** How a decided request ends in this list. It stays in place as a receipt until the next load. */
export type ApprovalOutcome = "approved" | "rejected" | "elsewhere" | "gone";

/** Why the last answer to one request did not apply. */
export type ApprovalFailure = true | "reauthenticate" | "busy";

/** Keep SSR and the first client render identical: the page has no reader zone of its own yet. */
export const READER_TIME_ZONE = "UTC";

export type ApprovalListInput = {
  app?: string;
  link?: string;
  initial?: ApprovalPage;
};

export const approvalCardInput = (item: PendingApproval) => ({
  codeVersion: item.requester.kind === "code_version",
  soleAdminNotice: item.soleAdminNotice,
  sentence: item.sentence,
  action: item.action,
  appName: item.app.name,
  appIcon: item.app.icon,
  review: item.review,
});

/**
 * The state of one list of open approvals: the loaded pages, the decisions made here, and the answers that failed.
 * Both looks of the list (v1 and `ui="v2"`) read the same state, so they load, decide and fail the same way.
 */
export function createApprovalList(
  props: ApprovalListInput,
  confirmRejectAll: (targets: PendingApproval[]) => Promise<boolean | undefined>,
) {
  const query = (cursor?: string): ApprovalListQuery => ({
    ...(props.app ? { app: props.app } : {}),
    ...(props.link ? { link: props.link } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const [page, setPage] = createSignal<ApprovalPage | null>(props.initial ?? null);
  const [items, setItems] = createSignal<PendingApproval[]>(props.initial?.items ?? []);
  const [outcomes, setOutcomes] = createSignal<ReadonlyMap<string, ApprovalOutcome>>(new Map());
  const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = createSignal<ReadonlyMap<string, ApprovalFailure>>(new Map());
  const retryInputs = new Map<string, ApprovalDecisionInput>();
  const [loadError, setLoadError] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  // A failed next page keeps the rows already shown; the error sits next to the button that retries it.
  const [moreError, setMoreError] = createSignal(false);

  const fetchPage = async (cursor?: string): Promise<ApprovalPage> => {
    const response = await coreClient.approvals.$get({ query: query(cursor) });
    if (!response.ok) throw new Error(`Approvals answered ${response.status}`);
    return ApprovalPageSchema.parse(await response.json());
  };
  const reload = async () => {
    setLoadError(false);
    try {
      const next = await fetchPage();
      setPage(next);
      setItems(next.items);
      setOutcomes(new Map());
    } catch {
      setLoadError(true);
    }
  };
  const loadMore = async () => {
    const cursor = page()?.nextCursor;
    if (!cursor || loadingMore()) return;
    setLoadingMore(true);
    try {
      const next = await fetchPage(cursor);
      setMoreError(false);
      const known = new Set(items().map((item) => item.id));
      setItems([...items(), ...next.items.filter((item) => !known.has(item.id))]);
      setPage({ ...next, count: page()?.count ?? next.count });
    } catch {
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  };
  onMount(() => {
    if (!props.initial) void reload();
  });

  const toggle = (set: ReadonlySet<string>, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };
  const clearFailure = (id: string) =>
    setFailed((current) => {
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  // A draft edited here keeps its row: the new review and digest overlay the loaded request.
  const [edited, setEdited] = createSignal<ReadonlyMap<string, ApprovalDraftResult>>(new Map());
  const withEdit = (item: PendingApproval): PendingApproval => {
    const edit = edited().get(item.id);
    return edit ? { ...item, review: edit.review, digest: edit.digest } : item;
  };
  const editDraft = (item: PendingApproval) =>
    item.digest
      ? async (values: Record<string, string>) => {
          const current = edited().get(item.id)?.digest ?? item.digest!;
          const result = await editApprovalDraft(item.id, values, current);
          setEdited((map) => new Map(map).set(item.id, result));
          return true;
        }
      : undefined;
  const decide = async (item: PendingApproval, input: ApprovalDecisionInput): Promise<void> => {
    if (busy().has(item.id) || outcomes().has(item.id)) return;
    retryInputs.delete(item.id);
    setBusy((current) => toggle(current, item.id, true));
    clearFailure(item.id);
    try {
      // The digest names the review on screen, so an answer never approves one the person did not see.
      const digest = edited().get(item.id)?.digest ?? item.digest;
      const response = await coreClient.approvals[":id"].decision.$post({
        param: { id: item.id },
        json: { ...input, ...(digest ? { digest } : {}) },
      });
      const error: unknown = response.ok ? null : await response.json().catch(() => null);
      if (error && typeof error === "object" && "code" in error && error.code === "BUSY") {
        retryInputs.set(item.id, input);
        setFailed((current) => new Map(current).set(item.id, "busy"));
        return;
      }
      const outcome: ApprovalOutcome | null = response.ok
        ? input.approved
          ? "approved"
          : "rejected"
        : response.status === 409
          ? "elsewhere"
          : response.status === 404
            ? "gone"
            : null;
      if (!outcome) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "SELF_APPROVAL" &&
          item.requester.kind === "code_version"
        ) {
          setItems((current) =>
            current.map((entry) => (entry.id === item.id ? { ...entry, canApprove: false, soleAdminNotice: undefined } : entry)),
          );
          return;
        }
        if (error && typeof error === "object" && "code" in error && error.code === "REAUTHENTICATE") {
          setFailed((current) => new Map(current).set(item.id, "reauthenticate"));
          return;
        }
        throw new Error(`Decision answered ${response.status}`);
      }
      setOutcomes((current) => new Map(current).set(item.id, outcome));
      refreshAppBadges();
    } catch {
      setFailed((current) => new Map(current).set(item.id, true));
    } finally {
      setBusy((current) => toggle(current, item.id, false));
    }
  };
  const retry = (item: PendingApproval) => {
    const input = retryInputs.get(item.id);
    if (input) void decide(item, input);
  };

  const open = createMemo(() => items().filter((item) => !outcomes().has(item.id)));
  const openCount = () => Math.max(0, (page()?.count ?? items().length) - outcomes().size);
  const rejectAll = async () => {
    const targets = open();
    if (targets.length === 0) return;
    // One after another: rejecting is cheap, and the list stays readable while the receipts appear.
    if (await confirmRejectAll(targets)) for (const item of targets) await decide(item, { approved: false });
  };
  // Without an app filter, the Core page groups the requests by the app that owns the effect.
  const groups = createMemo(() => {
    const byApp = new Map<string, PendingApproval[]>();
    for (const item of items()) byApp.set(item.app.id, [...(byApp.get(item.app.id) ?? []), item]);
    return [...byApp.values()];
  });

  return {
    page,
    items,
    outcomes,
    busy,
    failed,
    loadError,
    loadingMore,
    moreError,
    reload,
    loadMore,
    withEdit,
    editDraft,
    decide,
    retry,
    reopen: (item: PendingApproval) => clearFailure(item.id),
    open,
    openCount,
    rejectAll,
    groups,
  };
}
