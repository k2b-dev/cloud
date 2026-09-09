import { qr } from "@k2b/stdlib/qr";
import { Button, dialogCore, NoticeCard, PanelDialog, panelDialogOptions, Placeholder, toast, useLocale } from "@k2b/ui";
import { appApproval } from "@k2b/cloud/browser/app-approval";
import { AppPairingInspectionSchema, AppPairingPayloadSchema } from "@k2b/cloud/contracts";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { z } from "zod";
import { ApprovalError, approvalApi, approvalRequestOptions, checked, parsed, pollApproval } from "./client";
import ApprovalFeedback from "./Feedback";
import { appApprovalMessages } from "./messages";

const ResumeSchema = z.object({
  pairingId: z.string().uuid(),
  expiresAt: z.string().datetime(),
});
export default function Pairing(props: {
  userId: string;
  actorId: string;
  name: string;
  appOrigin: string;
  returnTo: string;
  onClose: () => void;
}) {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  const [reference, setReference] = createSignal<z.infer<typeof ResumeSchema>>();
  const [link, setLink] = createSignal("");
  const [inspection, setInspection] = createSignal<z.infer<typeof AppPairingInspectionSchema>>();
  const [state, setState] = createSignal<"idle" | "waiting" | "done" | "expired" | "cancelled">("idle");
  const [busy, setBusy] = createSignal(false);
  const [checkingIdentity, setCheckingIdentity] = createSignal(true);
  const [error, setError] = createSignal<unknown>();
  const needsAuthentication = () => {
    const cause = error();
    return cause instanceof ApprovalError && (cause.code === "REAUTHENTICATE" || cause.status === 401);
  };
  const [retrying, setRetrying] = createSignal(false);
  const canCancelResume = () => state() === "waiting" && !needsAuthentication() && !link() && !inspection()?.comparison;
  const canConfirm = () =>
    state() === "waiting" && !needsAuthentication() && inspection()?.state === "claimed" && !!inspection()?.comparison;
  const storageKey = `cloud.app-pairing:${props.actorId}:${props.userId}`;
  const returnTo = props.returnTo;
  let stop = () => {};
  let disposed = false;
  const forget = () => {
    try {
      window.sessionStorage.removeItem(storageKey);
    } catch {}
  };
  const finish = (next: "done" | "expired" | "cancelled") => {
    stop();
    forget();
    setLink("");
    setInspection(undefined);
    setReference(undefined);
    setRetrying(false);
    setError(undefined);
    setState(next);
    if (next === "cancelled") closeDialog?.();
  };
  const wait = (ref: z.infer<typeof ResumeSchema>) => {
    stop();
    setReference(ref);
    setState("waiting");
    stop = pollApproval(
      async (signal) => {
        if (Date.parse(ref.expiresAt) <= Date.now()) {
          finish("expired");
          return false;
        }
        const data = await parsed(
          await approvalApi.manage.pairings.status.$post({ json: { pairingId: ref.pairingId } }, approvalRequestOptions(signal)),
          AppPairingInspectionSchema,
        );
        if (signal.aborted) return false;
        if (data.userId !== props.userId) throw new ApprovalError("FORBIDDEN", 403);
        setRetrying(false);
        if (data.state === "confirmed") {
          finish("done");
          return false;
        }
        if (data.state === "cancelled") {
          finish("cancelled");
          return false;
        }
        setInspection(data);
        if (data.state === "claimed") setLink("");
        return true;
      },
      (cause) => {
        if (cause instanceof ApprovalError && cause.status < 500 && cause.status !== 429) {
          if (cause.status === 404) finish("expired");
          else {
            setInspection(undefined);
            setLink("");
            setError(cause);
          }
          return false;
        }
        setRetrying(true);
        return true;
      },
    );
  };
  onMount(() => {
    void dialogCore
      .open<void>(
        (close) => {
          closeDialog = close;
          return content(close);
        },
        { ...panelDialogOptions, panelClassName: `${panelDialogOptions.panelClassName} app-pairing-dialog` },
      )
      .then(() => {
        if (!disposed) {
          stop();
          const pending = reference();
          forget();
          if (pending) void cancelPending(pending.pairingId);
          props.onClose();
        }
      });
    try {
      const saved = ResumeSchema.safeParse(JSON.parse(window.sessionStorage.getItem(storageKey) || "null"));
      if (saved.success && Date.parse(saved.data.expiresAt) > Date.now()) {
        setCheckingIdentity(false);
        wait(saved.data);
      } else {
        forget();
        void start();
      }
    } catch {
      forget();
      void start();
    }
  });
  onCleanup(() => {
    disposed = true;
    stop();
    closeDialog?.();
  });
  const start = async () => {
    if (busy()) return;
    setBusy(true);
    setCheckingIdentity(true);
    const startedAt = performance.now();
    setError(undefined);
    try {
      const payload = await parsed(
        await approvalApi.manage.pairings.start.$post({ json: { userId: props.userId } }, approvalRequestOptions()),
        AppPairingPayloadSchema,
      );
      if (disposed) {
        void cancelPending(payload.pairingId);
        return;
      }
      const ref = {
        pairingId: payload.pairingId,
        expiresAt: payload.expiresAt,
      };
      setLink(appApproval.createPairingLink(props.appOrigin, payload));
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify(ref));
      } catch {}
      wait(ref);
    } catch (cause) {
      if (!disposed) setError(cause);
    } finally {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, 150 - (performance.now() - startedAt))));
      if (!disposed) {
        setCheckingIdentity(false);
        setBusy(false);
      }
    }
  };
  const change = async (confirm: boolean) => {
    const ref = reference();
    const code = inspection()?.comparison;
    if (!ref || busy() || (confirm && !code)) return;
    if (Date.parse(ref.expiresAt) <= Date.now()) {
      finish("expired");
      return;
    }
    setBusy(true);
    setError(undefined);
    stop();
    try {
      await checked(
        confirm && code
          ? await approvalApi.manage.pairings.confirm.$post(
              { json: { pairingId: ref.pairingId, comparison: code } },
              approvalRequestOptions(),
            )
          : await approvalApi.manage.pairings.cancel.$post({ json: { pairingId: ref.pairingId } }, approvalRequestOptions()),
      );
      if (!disposed) {
        finish(confirm ? "done" : "cancelled");
        if (confirm) toast.success(t().paired);
      }
    } catch (cause) {
      if (!disposed) {
        setError(cause);
        setInspection(undefined);
        setLink("");
        wait(ref);
      }
    } finally {
      if (!disposed) setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link());
      toast.success(t().copied);
    } catch {
      setError(new Error());
    }
  };
  const cancelPending = async (pairingId: string) => {
    try {
      await checked(await approvalApi.manage.pairings.cancel.$post({ json: { pairingId } }, approvalRequestOptions()));
    } catch {
      toast.error(t().failure);
    }
  };
  let closeDialog: (() => void) | undefined;
  const confirmIdentity = () => {
    forget();
    const target = new URL(returnTo, window.location.origin);
    target.searchParams.set("pairDevice", props.userId);
    target.searchParams.set("reauthenticate", "1");
    window.location.assign(`/auth/login?${new URLSearchParams({ redirectTo: target.pathname + target.search, credential: "legacy" })}`);
  };
  const content = (close: () => void) => (
    <PanelDialog>
      <PanelDialog.Header title={t().pair} subtitle={props.actorId !== props.userId ? props.name : undefined} icon="ti ti-device-mobile" close={close} />
      <PanelDialog.Body>
        <Show when={!checkingIdentity()} fallback={<Placeholder state="loading" title={t().checkingIdentity} />}>
          <div class="flex flex-col gap-4">
            <Show when={props.actorId !== props.userId && !needsAuthentication()}>
              <NoticeCard tone="warning">{t().assistedWarning}</NoticeCard>
            </Show>
            <Show
              when={needsAuthentication()}
              fallback={
                <ApprovalFeedback
                  error={error()}
                  beforeReauthenticate={forget}
                  returnTo={`${returnTo}${returnTo.includes("?") ? "&" : "?"}pairDevice=${props.userId}`}
                />
              }
            >
              <NoticeCard tone="warning">
                <p role="status">{props.actorId !== props.userId ? t().confirmAdminIdentity : t().confirmPairingIdentity}</p>
              </NoticeCard>
            </Show>
            <Show when={retrying()}>
              <NoticeCard tone="info">{t().retrying}</NoticeCard>
            </Show>
            <Show when={state() === "expired"}>
              <p class="text-sm text-dimmed" role="status">
                {t().expired}
              </p>
            </Show>
            <Show when={state() === "done"}>
              <NoticeCard tone="success">
                <p role="status">{t().done}</p>
              </NoticeCard>
            </Show>
            <Show when={state() === "waiting" && !needsAuthentication()}>
              <Show
                when={link()}
                fallback={
                  <Show when={!inspection()?.comparison}>
                    <p class="text-sm text-dimmed">{t().resumed}</p>
                  </Show>
                }
              >
                <p class="text-sm text-dimmed">{t().instructions}</p>
                <img class="w-64 max-w-full self-center" alt={t().qr} src={`data:image/svg+xml,${encodeURIComponent(qr.toSvg(link()))}`} />
                <div class="flex flex-wrap justify-center gap-2">
                  <Button variant="secondary" onClick={copy}>
                    {t().copy}
                  </Button>
                </div>
              </Show>
              <Show when={canConfirm()}>
                <p class="text-sm">{t().confirmHint({ name: inspection()?.name ?? "" })}</p>
                <div class="py-4 text-center" role="status">
                  <p class="text-sm">{t().comparison}</p>
                  <p class="mt-2 text-3xl sm:text-5xl font-mono tabular-nums tracking-widest">{inspection()?.comparison}</p>
                </div>
              </Show>
            </Show>
          </div>
        </Show>
      </PanelDialog.Body>
      <Show when={!checkingIdentity() && (needsAuthentication() || canConfirm() || canCancelResume())}>
        <PanelDialog.Footer>
          <div class="flex w-full justify-end">
            <Show when={canCancelResume()}>
              <Button variant="danger" onClick={close}>
                {t().cancel}
              </Button>
            </Show>
            <Show when={needsAuthentication() || canConfirm()}>
              <Show
                when={needsAuthentication()}
                fallback={
                  <Button loading={busy()} onClick={() => change(true)}>
                    {t().confirm}
                  </Button>
                }
              >
                <Button onClick={confirmIdentity}>{t().reauthenticate}</Button>
              </Show>
            </Show>
          </div>
        </PanelDialog.Footer>
      </Show>
    </PanelDialog>
  );
  return null;
}
