import { Button, toast } from "@k2b/ui";
import { createSignal, Show, untrack } from "solid-js";
import { api } from "../lib/api";
import type { NoteRecord } from "../lib/model";
import { navigate } from "../router";
import { app, t } from "../state";
import { Icon } from "../ui/common";
import { openSheet } from "../ui/sheet";

/**
 * Removes a note. A shared one goes first on the server; offline or on failure the note stays
 * visible as "Löschen ausstehend" and finishes when the browser is online again.
 */
export async function deleteNote(record: NoteRecord, alsoShared: boolean) {
  const store = app.store();
  if (!store) return;
  if (alsoShared && record.share?.kind === "own") {
    if (!record.pendingDelete) await store.update(record.id, { pendingDelete: true });
    try {
      await api.deletePad(record.share.editId);
    } catch {
      toast(t().deletePending, { iconClass: "ti ti-cloud-off" });
      return;
    }
  }
  await store.remove(record.id);
}

let finishing = false;
/** Pending deletions retry whenever the page starts or the browser comes back online; one run at a time. */
export async function finishPendingDeletes() {
  if (finishing) return;
  finishing = true;
  try {
    for (const record of untrack(app.records)) if (record.pendingDelete) await deleteNote(record, true);
  } finally {
    finishing = false;
  }
}

function DeleteBody(props: { record: NoteRecord; close: (deleted: boolean) => void }) {
  const shared = props.record.share?.kind === "own";
  const [alsoShared, setAlsoShared] = createSignal(shared);
  const [busy, setBusy] = createSignal(false);
  return (
    <div class="n-dialog">
      <h2>{t().deleteTitle({ title: props.record.meta.title || t().untitled })}</h2>
      <p class="n-lead">{t().deleteLead}</p>
      <Show when={shared}>
        <label class="n-check">
          <input type="checkbox" checked={alsoShared()} onChange={(event) => setAlsoShared(event.currentTarget.checked)} />
          <span>{t().deleteShared}</span>
        </label>
      </Show>
      <div class="n-dialog-acts">
        <Button variant="ghost" onClick={() => props.close(false)}>
          {t().cancel}
        </Button>
        <Button
          variant="danger"
          loading={busy()}
          onClick={async () => {
            setBusy(true);
            await deleteNote(props.record, alsoShared());
            props.close(true);
          }}
        >
          <Icon name="ti-trash" />
          {t().deleteAction}
        </Button>
      </div>
    </div>
  );
}

export async function openDelete(record: NoteRecord) {
  const deleted = await openSheet<boolean>((close) => <DeleteBody record={record} close={close} />);
  if (deleted) navigate("/", { replace: true });
}
