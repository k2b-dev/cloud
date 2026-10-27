import type { AccessSubject } from "@k2b/cloud/server";
import { toPgTextArray } from "@k2b/cloud/services";
import { principalLabel } from "@k2b/cloud/shared";
import type { sql } from "bun";
import type { z } from "zod";
import { messages, subjectPrincipal } from "./access";
import { REACTION_PEOPLE, type ReactionsSchema } from "./contracts";
import { deletedPeople } from "./former-accounts";

type Group = z.infer<typeof ReactionsSchema>["items"][number];
/** One grouped query for the bounded message page; at most 50 groups and 10 names per message. */
export const reactionGroups = async (db: typeof sql, messageIds: string[], subject: AccessSubject, locale?: string) => {
  const groups = new Map<string, Group[]>();
  if (!messageIds.length) return groups;
  const self = subjectPrincipal(subject);
  const rows = await db<
    {
      message: string;
      emoji: string;
      count: number;
      own: boolean;
      people: { type: "user" | "service_account"; id: string; name: string }[];
    }[]
  >`WITH ranked AS (
    SELECT m.short_id AS message, r.*,
      row_number() OVER (PARTITION BY r.message_id, r.emoji ORDER BY r.position DESC) AS newest
    FROM chat.message_reactions r JOIN chat.messages m ON m.id = r.message_id
    WHERE m.short_id = ANY(${toPgTextArray(messageIds)}::text[])
  ) SELECT message, emoji, count(*)::int AS count,
    bool_or(principal_type = ${self.type} AND principal_id = ${self.id}::uuid) AS own,
    jsonb_agg(jsonb_build_object('type', principal_type, 'id', principal_id, 'name', display_name)
      ORDER BY position DESC) FILTER (WHERE newest <= ${REACTION_PEOPLE}) AS people
    FROM ranked GROUP BY message, emoji ORDER BY min(position)`;
  // People whose account was deleted are named like deleted authors; their reaction still counts.
  const absent = await Promise.all(
    (["user", "service_account"] as const).map((type) =>
      deletedPeople(
        db,
        rows.flatMap((row) => row.people.filter((person) => person.type === type).map((person) => person.id)),
        type,
      ),
    ),
  );
  const deleted = new Set(absent.flatMap((ids) => [...ids]));
  const former = messages({ locale }).formerAccount;
  for (const row of rows) {
    const items = groups.get(row.message) ?? [];
    items.push({
      emoji: row.emoji,
      count: row.count,
      own: row.own,
      people: row.people.map((person) =>
        principalLabel(
          {
            principal:
              person.type === "user" ? { type: "user", userId: person.id } : { type: "service_account", serviceAccountId: person.id },
            displayName: deleted.has(person.id) ? former : person.name,
          },
          locale,
        ),
      ),
    });
    groups.set(row.message, items);
  }
  return groups;
};
