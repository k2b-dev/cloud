import { formatNumber } from "@k2b/cloud/shared";
import { query } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup } from "solid-js";
import { apiClient } from "@/api/client";
import { usePageSwap } from "../lib/page-swap";
import { useAccountsMessages } from "../messages";

type Selection = { userIds: string[]; groupIds: string[] };
type Preview = { targetCount: number; deliverableCount: number; skippedNoEmailCount: number; recipientHash: string };
type PreviewSource = { key: string; selection: Selection; hasAudience: boolean };

const readError = async (res: Pick<Response, "json">, fallback: string) => {
  try {
    const data = await res.json();
    return data.message ?? data.error?.message ?? fallback;
  } catch {
    return fallback;
  }
};

/**
 * The form of a new notification batch: subject, Markdown body, chosen users and groups, and a recipient preview that
 * follows the audience. A preview for an audience that changed meanwhile never shows, the one that runs is aborted when
 * the audience changes or the form closes, and "Create draft" checks a fresh preview first. A created draft opens.
 */
export const useNewBatchForm = () => {
  const { openPage } = usePageSwap();
  const t = useAccountsMessages();
  const locale = useLocale();
  let active = true;
  onCleanup(() => {
    active = false;
  });
  const [subject, setSubject] = createSignal("");
  const [body, setBody] = createSignal("");
  const [userIds, setUserIds] = createSignal<string[]>([]);
  const [groupIds, setGroupIds] = createSignal<string[]>([]);
  const [tried, setTried] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const source = createMemo<PreviewSource>(() => {
    const selection = { userIds: userIds(), groupIds: groupIds() };
    return { key: JSON.stringify(selection), selection, hasAudience: selection.userIds.length > 0 || selection.groupIds.length > 0 };
  });
  const preview = query.create<PreviewSource, { key: string; data: Preview }>({
    source,
    enabled: () => source().hasAudience,
    isSameSource: (left, right) => left.key === right.key,
    load: async (current, { abortSignal }) => {
      const res = await apiClient.notifications.batches.preview.$post(
        { json: { selection: current.selection } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().previewRecipientsFailed));
      return { key: current.key, data: await res.json() };
    },
  });
  /** The preview of the audience as it is now; a preview of an earlier audience is never shown. */
  const current = () => {
    const result = preview.data();
    return result?.key === source().key ? result.data : null;
  };
  const previewing = () => preview.loading() || preview.refreshing();
  const hasAudience = () => source().hasAudience;

  /** The preview in one sentence, or what keeps it from being shown. */
  const previewText = () => {
    if (!hasAudience()) return t().noAudience;
    if (previewing()) return t().resolvingRecipients;
    const failure = preview.error();
    if (failure) return failure.message;
    const data = current();
    if (!data) return t().previewUpdatesAutomatically;
    return t().previewSummary({
      deliverable: formatNumber(data.deliverableCount, { locale: locale() }),
      matched: formatNumber(data.targetCount, { locale: locale() }),
      withoutEmail: formatNumber(data.skippedNoEmailCount, { locale: locale() }),
    });
  };

  /** A preview of the audience as it is when "Create draft" is pressed, or null with the reason shown. */
  const freshPreview = async (key: string): Promise<Preview | null> => {
    await preview.refresh();
    if (!active) return null;
    if (source().key !== key) return fail(t().audienceChanged);
    const failure = preview.error();
    if (failure) return fail(failure.message);
    if (preview.stale()) return fail(t().previewNotConfirmed);
    return current();
  };
  const fail = (message: string) => {
    setError(message);
    return null;
  };

  const create = async () => {
    setTried(true);
    setError(null);
    // the fields say what is missing
    if (!subject().trim() || !body().trim() || !hasAudience()) return null;
    const draft = source();
    setSaving(true);
    try {
      const latest = await freshPreview(draft.key);
      if (!latest) return null;
      if (latest.deliverableCount === 0) return fail(t().noDeliverableAudience);
      const res = await apiClient.notifications.batches.$post({
        json: { subject: subject(), bodyMarkdown: body(), selection: draft.selection },
      });
      if (!res.ok) return fail(await readError(res, t().createNotificationFailed));
      const batch = await res.json();
      void openPage(`/app/accounts/notifications/${batch.id}`);
      return batch.id;
    } catch (failure) {
      return fail(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (active) setSaving(false);
    }
  };

  return {
    subject,
    setSubject,
    body,
    setBody,
    userIds,
    setUserIds,
    groupIds,
    setGroupIds,
    tried,
    saving,
    error,
    hasAudience,
    previewing,
    previewFailed: () => Boolean(preview.error()),
    previewText,
    /** The chosen users and groups as one list of `user:<id>` and `group:<id>`, for the audience lookup. */
    audience: () => [...userIds().map((id) => `user:${id}`), ...groupIds().map((id) => `group:${id}`)],
    setAudience: (values: readonly string[]) => {
      setUserIds(values.filter((value) => value.startsWith("user:")).map((value) => value.slice(5)));
      setGroupIds(values.filter((value) => value.startsWith("group:")).map((value) => value.slice(6)));
    },
    refreshPreview: () => void preview.refresh(),
    create,
  };
};

export type NewBatchForm = ReturnType<typeof useNewBatchForm>;
