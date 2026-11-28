import { useLocale } from "@k2b/ui";
import { Button, Chip, Dialog, Field, Input, Row, useToast } from "@k2b/ui/v2";
import { createSignal, onCleanup } from "solid-js";
import type { PulseBase, PulseBaseNav } from "../../contracts";
import { jsonFetch } from "../http";
import { usePulseMessages } from "../use-messages";
import { baseStoreMessages } from "../workspace/base-store-messages";
import { installPeriodicRefresh } from "../workspace/periodic-refresh";
import { useScreenMessages } from "./messages";

/**
 * A base admin follows a running deletion here, since the base is no place any more, and resumes a failed one. Once
 * the deletion finished the row says so and leads back to Pulse.
 */
export function DeletingBase(props: { base: PulseBaseNav }) {
  const locale = useLocale();
  const t = () => baseStoreMessages.resolve([locale()]).t;
  const pulse = usePulseMessages();
  const toast = useToast();
  const [name, setName] = createSignal(props.base.name);
  const [storeFailed, setStoreFailed] = createSignal(props.base.state === "deletion-failed");
  // Gone once the deletion finished; the row stays in place until a reload.
  const [deleted, setDeleted] = createSignal(false);
  const [retrying, setRetrying] = createSignal(false);
  const failed = () => !deleted() && storeFailed();
  const take = (base: PulseBase) => {
    setName(base.name);
    setStoreFailed(base.store.state === "failed");
  };
  const followed = installPeriodicRefresh({
    active: () => !deleted() && !failed() && !retrying(),
    refresh: async () => {
      const gone = new Error("PULSE_BASE_GONE");
      const next = await jsonFetch<PulseBase>(`/api/pulse/bases/${props.base.id}`, undefined, t().retryFailed, (status) =>
        status === 404 || status === 403 ? gone : new Error(t().retryFailed),
      ).catch((error: unknown) => {
        if (error !== gone) throw error;
        setDeleted(true);
        return null;
      });
      if (next) take(next);
    },
  });
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const retry = async () => {
    if (!failed()) return followed.retry();
    setRetrying(true);
    try {
      take(
        await jsonFetch<PulseBase>(
          `/api/pulse/bases/${props.base.id}/retry`,
          { method: "POST", signal: controller.signal },
          t().retryFailed,
        ),
      );
      toast(t().retryStarted, { status: "ok" });
    } catch {
      if (!controller.signal.aborted) toast(t().retryFailed, { status: "bad" });
    } finally {
      setRetrying(false);
    }
  };
  const state = () => (deleted() ? t().stateDeleted : failed() ? t().stateFailed : t().stateDeleting);
  const text = () => (deleted() ? t().deletedText : failed() ? t().failedDelete : followed.failed() ? t().staleText : t().deletingText);
  return (
    <Row
      // a failed deletion in red, a running one in amber, a finished one in green: colour, symbol and word
      mark={
        failed()
          ? { icon: "alert-circle", color: "#dc2626" }
          : deleted()
            ? { icon: "check", color: "#059669" }
            : { icon: "trash", color: "#d97706" }
      }
      lines={[name(), text()]}
      // a running deletion says so in its line; a failed or finished one has its word
      meta={failed() || deleted() ? <Chip status={failed() ? "bad" : "ok"}>{state()}</Chip> : undefined}
      // retrying is offered where it can help: a failed deletion, or a follow-up that stopped answering; once the
      // base is gone the way leads back to Pulse
      action={
        deleted()
          ? { label: pulse().backToPulse, icon: "arrow-left", href: "/app/pulse" }
          : failed() || followed.failed() || retrying()
            ? { label: t().retry, icon: "refresh", disabled: retrying(), onClick: () => void retry() }
            : undefined
      }
    />
  );
}

/** The few words a new base needs; the base opens once it exists. */
export function NewBaseDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (base: PulseBase) => void }) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [tried, setTried] = createSignal(false);
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const close = (open: boolean) => {
    if (busy()) return;
    props.onOpenChange(open);
    if (!open) {
      setName("");
      setDescription("");
      setError(null);
      setTried(false);
    }
  };
  const create = async (event?: Event) => {
    event?.preventDefault();
    setTried(true);
    if (!name().trim() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const base = await jsonFetch<PulseBase>(
        "/api/pulse/bases",
        {
          method: "POST",
          body: JSON.stringify({ name: name().trim(), description: description().trim() || null }),
          signal: controller.signal,
        },
        t().createBaseFailed,
      );
      setBusy(false);
      close(false);
      props.onCreated(base);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t().createBaseFailed);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t().createBasePrompt}
      open={props.open}
      onOpenChange={close}
      foot={
        <>
          <Button onClick={() => close(false)} disabled={busy()}>
            {words().cancel}
          </Button>
          <Button variant="primary" icon="plus" busy={busy()} onClick={() => void create()}>
            {t().create}
          </Button>
        </>
      }
    >
      <Field name="name" label={t().name} required error={tried() && !name().trim() ? words().required : (error() ?? undefined)}>
        <Input
          value={name()}
          placeholder="Operations"
          onInput={setName}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) void create(event);
          }}
        />
      </Field>
      <Field name="description" label={t().description} optional={words().optional}>
        <Input multiline value={description()} onInput={setDescription} />
      </Field>
    </Dialog>
  );
}
