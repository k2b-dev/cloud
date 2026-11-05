import { pwaDrafts } from "@k2b/cloud/browser/pwa-drafts";
import { apiClient } from "@/api/client";
import type { CreateItem, ItemTemplateDraft, SpaceAssignableUser, SpaceItem } from "@/contracts";
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

export type CreateOutcome = { kind: "created"; item: SpaceItem } | { kind: "unconfirmed" } | { kind: "refused"; reason: string };

/**
 * Sends one create through the app's API client, which renews an expired app session and repeats the request. No
 * answer, a failed connection, an answer that breaks off, or a server error leaves the outcome open: the task may
 * exist, so only the same request key may try again. Any other refusal is final and says why in the server's words.
 */
export async function sendCreate(spaceShortId: string, body: CreateItem & { requestKey: string }, refused: string): Promise<CreateOutcome> {
  try {
    const response = await apiClient[":id"].items.$post({ param: { id: spaceShortId }, json: body });
    // A busy or failing server may have kept the task; only the same request may go again.
    const status: number = response.status;
    if (status >= 500 || status === 429) return { kind: "unconfirmed" };
    if (response.ok) return { kind: "created", item: (await response.json()) as SpaceItem };
    if (response.status === 403) return { kind: "refused", reason: refused };
    return { kind: "refused", reason: await readResponseError(response, refused) };
  } catch {
    return { kind: "unconfirmed" };
  }
}

/** A template's filled task for today, as the web's form starts from it; null when it cannot be read. */
export async function readTemplateDraft(spaceShortId: string, templateId: string, timeZone: string): Promise<ItemTemplateDraft | null> {
  try {
    const response = await apiClient[":id"].templates[":templateId"].draft.$get({
      param: { id: spaceShortId, templateId },
      query: { timeZone },
    });
    return response.ok ? ((await response.json()) as ItemTemplateDraft) : null;
  } catch {
    return null;
  }
}

/** Everyone a Space may assign whose name matches `search`, up to 20; null when they cannot be read. */
export async function readAssignable(spaceShortId: string, search: string): Promise<SpaceAssignableUser[] | null> {
  try {
    const response = await apiClient[":id"]["assignable-users"].$get({ param: { id: spaceShortId }, query: search ? { search } : {} });
    return response.ok ? ((await response.json()) as SpaceAssignableUser[]) : null;
  } catch {
    return null;
  }
}

/**
 * Tasks not yet confirmed stay on the device for this account, with their request key, so a reload or a restarted
 * app offers the same request again instead of losing the text or adding the task twice.
 */
const OUTBOX = "spaces.quick-add.outbox";
export const outbox = {
  read(accountId: string): Outgoing[] {
    try {
      const entries = JSON.parse(pwaDrafts.read(accountId, OUTBOX) ?? "[]") as Outgoing[];
      return Array.isArray(entries) ? entries.map((entry) => ({ ...entry, state: "unconfirmed" as const })) : [];
    } catch {
      return [];
    }
  },
  write(accountId: string, entries: readonly Outgoing[]) {
    const open = entries.filter((entry) => entry.state === "saving" || entry.state === "unconfirmed");
    if (open.length) pwaDrafts.write(accountId, OUTBOX, JSON.stringify(open.map(({ created: _, reason: __, ...entry }) => entry)));
    else pwaDrafts.remove(accountId, OUTBOX);
  },
};
