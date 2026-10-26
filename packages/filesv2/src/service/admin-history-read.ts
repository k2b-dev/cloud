import { audit } from "@k2b/cloud/services";
import { sql } from "bun";
import { finishActivity, insertActivity } from "../data/activity";
import type { ActivityReaderDependencies } from "./activity-reader";

/** One scope record per request/page, independent of the number of projected rows or sides. */
export const recordAdminHistoryRead: ActivityReaderDependencies["recordAdminRead"] = async (call, bases, config, readScope, budget) => {
  const base = bases[0];
  if (!base) return;
  const bindingIds = bases.map((binding) => binding.id);
  const scope = { ...readScope, bindingIds };
  const actor = call.actor.kind === "user" ? call.actor.user : call.actor.delegatedUser;
  budget.check();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('statement_timeout',${String(budget.remainingMs())},true)`;
    budget.check();
    const id = await insertActivity(
      call,
      {
        action: "admin.read",
        serverUrl: config.url,
        root: base.root,
        baseId: base.id,
        directory: true,
        name: base.identity_name,
        pathBefore: base.path,
        detail: { operation: "history", scope },
      },
      tx,
    );
    budget.check();
    await finishActivity(tx, id, "done", async () => {
      await audit.record(
        {
          action: "filesv2.admin.read",
          outcome: "allowed",
          actor: actor ? { userId: actor.id, uid: actor.uid } : undefined,
          target: { type: "filesv2.history", id: base.id, label: base.path },
          requestId: call.requestId,
          metadata: { operation: "history", bindingIds, scope, historyId: id },
        },
        tx,
      );
      budget.check();
    });
  });
};
