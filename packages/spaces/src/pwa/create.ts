import type { CreateItem, ItemTemplateDraft, SpaceItem } from "@/contracts";
import { readResponseError } from "../frontend/lib/response";

/** A task on its way to the server; the same request key repeats the same create without a second task. */
export type Outgoing = {
  key: string;
  spaceShortId: string;
  statusId: string;
  title: string;
  body: CreateItem & { requestKey: string };
  /**
   * `saving` while the request runs; `unconfirmed` when no answer came, so the same request may go again; `refused`
   * when the server said no and a retry would not change it; `created` once the server kept it.
   */
  state: "saving" | "unconfirmed" | "refused" | "created";
  reason?: string;
  created?: SpaceItem;
};

export type CreateOutcome =
  | { kind: "created"; item: SpaceItem }
  | { kind: "unconfirmed" }
  | { kind: "refused"; reason: string };

/**
 * Sends one create. No answer, a failed connection or a server error leaves the outcome open: the task may exist, so
 * only the same request key may try again. Any other refusal is final and says why in the server's words.
 */
export async function sendCreate(spaceShortId: string, body: CreateItem & { requestKey: string }, refused: string): Promise<CreateOutcome> {
  const response = await fetch(`/api/spaces/${encodeURIComponent(spaceShortId)}/items`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);
  if (!response || response.status >= 500 || response.status === 429) return { kind: "unconfirmed" };
  if (response.ok) return { kind: "created", item: (await response.json()) as SpaceItem };
  if (response.status === 403) return { kind: "refused", reason: refused };
  return { kind: "refused", reason: await readResponseError(response, refused) };
}

/** A template's filled task for today, as the web's form starts from it; null when it cannot be read. */
export async function readTemplateDraft(spaceShortId: string, templateId: string, timeZone: string): Promise<ItemTemplateDraft | null> {
  const query = new URLSearchParams({ timeZone });
  const response = await fetch(
    `/api/spaces/${encodeURIComponent(spaceShortId)}/templates/${encodeURIComponent(templateId)}/draft?${query}`,
    { headers: { accept: "application/json" } },
  ).catch(() => null);
  return response?.ok ? ((await response.json()) as ItemTemplateDraft) : null;
}
