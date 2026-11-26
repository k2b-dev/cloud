import { useLocale } from "@k2b/ui";
import { Button, Check, Dialog, Field, Input, Notice } from "@k2b/ui/v2";
import { createEffect, createSignal, on, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { ColumnSpec } from "../../../contracts";
import { toolbarMessages } from "../toolbar/messages";
import { errorMessage } from "../utils/api-helpers";
import { recordsScreenMessages } from "./screen-messages";

/** What a new view is made of: its table, its GQL source and the columns it shows. */
export type ViewDraft = { tableId: string; source: string; ui?: { columns?: ColumnSpec[] } };

/**
 * Saves a view of its own, private or shared with everyone who can write to the table: what a table shows now
 * (search, filters, sort, computed columns) or a query. `draft` makes the view's source when the person saves (it
 * throws with the reason a source cannot be one); `onSaved` gets the new view.
 */
export default function SaveViewDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: () => ViewDraft | Promise<ViewDraft>;
  onSaved: (view: { id: string; tableId: string }) => void;
  canShare: boolean;
}) {
  const locale = useLocale();
  const t = () => toolbarMessages.resolve([locale()]).t;
  const words = () => recordsScreenMessages.resolve([locale()]).t;
  const [name, setName] = createSignal("");
  const [shared, setShared] = createSignal(false);
  const [submitted, setSubmitted] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setName("");
        setShared(false);
        setSubmitted(false);
        setError(null);
      },
    ),
  );
  const save = async () => {
    setSubmitted(true);
    if (!name().trim() || saving()) return;
    setSaving(true);
    setError(null);
    try {
      const draft = await props.draft();
      const response = await apiClient.views["by-table"][":tableId"].$post({
        param: { tableId: draft.tableId },
        json: { name: name().trim(), source: draft.source, ...(draft.ui ? { ui: draft.ui } : {}), shared: props.canShare && shared() },
      });
      if (!response.ok) throw new Error(await errorMessage(response, t().saveViewFailed));
      const view = await response.json();
      props.onOpenChange(false);
      props.onSaved({ id: view.id, tableId: view.tableId });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().saveViewFailed);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title={t().saveView}
      open={props.open}
      onOpenChange={(open) => !saving() && props.onOpenChange(open)}
      foot={
        <>
          <Button onClick={() => props.onOpenChange(false)} disabled={saving()}>
            {words().cancel}
          </Button>
          <Button variant="primary" icon="bookmark-plus" busy={saving()} onClick={() => void save()}>
            {words().save}
          </Button>
        </>
      }
    >
      <Show when={error()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
      <Field label={t().name} name="name" required error={submitted() && !name().trim() ? words().nameRequired : undefined}>
        <Input
          value={name()}
          onInput={setName}
          placeholder={t().openTasksExample}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) void save();
          }}
        />
      </Field>
      <Check
        label={props.canShare ? t().shareView : t().shareRequiresWrite}
        checked={shared()}
        disabled={!props.canShare}
        onChange={setShared}
      />
    </Dialog>
  );
}
