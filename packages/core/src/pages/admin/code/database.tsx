import { codePageMessages } from "@k2b/cloud/ssr/code-page/messages";
import { type Action, Dialog, useLocale, useToast } from "@k2b/ui/v2";
import { createSignal } from "solid-js";

/** The export of one automation's database, the same address every Code page uses. */
export const databaseExportHref = (codeId: string) => `/api/code/authoring/database/${codeId}/export`;

/**
 * "Delete now" for an unused database: the confirmation carries the exact incarnation and unused period the server
 * showed, so a newer database is never deleted by an older page. Done or unclear, the deed becomes "Reload", since only
 * the next read says what happened.
 */
export function createDatabaseDelete(codeId: string, unused: { namespace: string; since: string }) {
  const locale = useLocale();
  const t = () => codePageMessages.resolve([locale()]).t;
  const toast = useToast();
  const [state, setState] = createSignal<"idle" | "busy" | "done" | "failed">("idle");
  const remove = async () => {
    if (state() !== "idle") return;
    // k2b-ui gap: a destructive question asks with a red button once #4275 lands (danger: true).
    if (!(await Dialog.confirm({ title: t().databaseDelete, description: t().databaseDeleteConfirm, confirm: t().databaseDelete }))) return;
    setState("busy");
    try {
      const response = await fetch("/api/code/authoring/database/delete", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ codeId, namespace: unused.namespace, since: unused.since }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("delete_refused");
      setState("done");
      toast(t().databaseDeleting, { status: "ok" });
    } catch {
      setState("failed");
      toast(t().databaseDeleteFailed, { status: "bad" });
    }
  };
  const settled = () => state() === "done" || state() === "failed";
  return {
    state,
    action: (): Action => ({
      label: settled() ? t().databaseReload : t().databaseDelete,
      icon: settled() ? "refresh" : "trash",
      disabled: state() === "busy",
      onClick: () => (settled() ? window.location.reload() : void remove()),
    }),
  };
}
