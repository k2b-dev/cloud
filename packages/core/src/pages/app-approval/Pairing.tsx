import { appApproval } from "@k2b/cloud/browser/app-approval";
import { AppPairingConfirmResultSchema, AppPairingInspectionSchema, AppPairingPayloadSchema } from "@k2b/cloud/contracts";
import { qr } from "@k2b/stdlib/qr";
import { Button, dialogCore, NoticeCard, PanelDialog, Placeholder, panelDialogOptions, toast, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { z } from "zod";
import { ApprovalError, approvalApi, approvalRequestOptions, checked, parsed, pollApproval } from "./client";
import ApprovalFeedback from "./Feedback";
import { InstallLink } from "./InstallApp";
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
  /** Show how to install the sign-in app before a new pairing starts. */
  install?: boolean;
  onClose: () => void;
}) {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  const [reference, setReference] = createSignal<z.infer<typeof ResumeSchema>>();
  const [link, setLink] = createSignal("");
  const [inspection, setInspection] = createSignal<z.infer<typeof AppPairingInspectionSchema>>();
  const [state, setState] = createSignal<"idle" | "waiting" | "done" | "denied" | "expired" | "cancelled">("idle");
  const [busy, setBusy] = createSignal(false);
  const [checkingIdentity, setCheckingIdentity] = createSignal(true);
  // Unset when the dialog has no install step. A new pairing starts only after it,
  // so installing the app does not use up the pairing link's five minutes.
  const [step, setStep] = createSignal<"install" | "pair">();
  const [error, setError] = createSignal<unknown>();
  const needsAuthentication = () => {
    const cause = error();
    return cause instanceof ApprovalError && (cause.code === "REAUTHENTICATE" || cause.status === 401);
  };
  const [retrying, setRetrying] = createSignal(false);
  // The code was confirmed while the account already had a paired device: one of them approves the pairing.
  const awaitingApproval = () => state() === "waiting" && !needsAuthentication() && inspection()?.approval?.state === "pending";
  const canCancelResume = () =>
    state() === "waiting" && !needsAuthentication() && ((!link() && !inspection()?.comparison) || awaitingApproval());
  const canConfirm = () =>
    state() === "waiting" &&
    !needsAuthentication() &&
    inspection()?.state === "claimed" &&
    !!inspection()?.comparison &&
    !inspection()?.approval;
  const storageKey = `cloud.app-pairing:${props.actorId}:${props.userId}`;
  const returnTo = props.returnTo;
  let stop = () => {};
  let disposed = false;
  /** With a pairing ID, only that pairing's saved reference goes; a newer one stays for a reload. */
  const forget = (pairingId?: string) => {
    try {
      if (pairingId !== undefined) {
        const saved = ResumeSchema.safeParse(JSON.parse(window.sessionStorage.getItem(storageKey) || "null"));
        if (!saved.success || saved.data.pairingId !== pairingId) return;
      }
      window.sessionStorage.removeItem(storageKey);
    } catch {}
  };
  const finish = (next: "done" | "denied" | "expired" | "cancelled") => {
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
  /** `stale`: the saved reference is past its deadline, which Cloud may have extended; ask at once, else start over. */
  const wait = (started: z.infer<typeof ResumeSchema>, stale = false) => {
    let ref = started;
    stop();
    setReference(ref);
    setState("waiting");
    stop = pollApproval(
      async (signal) => {
        // Cloud says when a pairing ended: a lost confirmation answer may have extended it for a paired device, and a
        // decided request still answers approved or denied for a minute. A gone pairing answers 404, read as expired.
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
          finish(data.approval?.state === "denied" ? "denied" : "cancelled");
          return false;
        }
        if (data.approval?.state === "expired") {
          finish("expired");
          return false;
        }
        // Also a status read can be the first to learn of the approval request, after a lost confirmation answer:
        // the saved reference follows its deadline, so a reload resumes the pairing.
        const approvalUntil = data.approval?.state === "pending" ? Date.parse(data.approval.expiresAt) : 0;
        if (approvalUntil > Date.parse(ref.expiresAt)) {
          ref = { ...ref, expiresAt: new Date(approvalUntil).toISOString() };
          setReference(ref);
          try {
            window.sessionStorage.setItem(storageKey, JSON.stringify(ref));
          } catch {}
        }
        setInspection(data);
        if (data.state === "claimed") setLink("");
        return true;
      },
      (cause) => {
        if (cause instanceof ApprovalError && cause.status < 500 && cause.status !== 429) {
          if (cause.status === 404 && stale && !inspection()) {
            stop();
            forget();
            setReference(undefined);
            setState("idle");
            begin();
          } else if (cause.status === 404) finish("expired");
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
      5,
      { immediate: stale },
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
          // The saved reference stays until Cloud confirms the cancellation, so reopening the dialog can retry it.
          if (pending) void cancelPending(pending.pairingId, true);
          else forget();
          props.onClose();
        }
      });
    try {
      const saved = ResumeSchema.safeParse(JSON.parse(window.sessionStorage.getItem(storageKey) || "null"));
      if (saved.success) {
        setCheckingIdentity(false);
        wait(saved.data, Date.parse(saved.data.expiresAt) <= Date.now());
      } else {
        forget();
        begin();
      }
    } catch {
      forget();
      begin();
    }
  });
  const begin = () => {
    if (props.install) setStep("install");
    else void start();
  };
  let pairHeading: HTMLHeadingElement | undefined;
  const next = () => {
    setStep("pair");
    pairHeading?.focus();
    void start();
  };
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
      if (confirm && code) {
        const result = await parsed(
          await approvalApi.manage.pairings.confirm.$post(
            { json: { pairingId: ref.pairingId, comparison: code } },
            approvalRequestOptions(),
          ),
          AppPairingConfirmResultSchema,
        );
        if (disposed) return;
        const approval = result.approval;
        if (approval) {
          // Nothing is paired yet: follow the request until a paired device decides it, also after a reload.
          const next = { ...ref, expiresAt: new Date(Math.max(Date.parse(ref.expiresAt), Date.parse(approval.expiresAt))).toISOString() };
          try {
            window.sessionStorage.setItem(storageKey, JSON.stringify(next));
          } catch {}
          setInspection((previous) => (previous ? { ...previous, approval } : previous));
          wait(next);
          return;
        }
        finish("done");
        toast.success(t().paired);
        return;
      }
      await checked(await approvalApi.manage.pairings.cancel.$post({ json: { pairingId: ref.pairingId } }, approvalRequestOptions()));
      if (!disposed) finish("cancelled");
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
  const cancelPending = async (pairingId: string, saved = false) => {
    try {
      await checked(await approvalApi.manage.pairings.cancel.$post({ json: { pairingId } }, approvalRequestOptions()));
      if (saved) forget(pairingId);
    } catch (cause) {
      // A pairing that Cloud already finished or no longer knows has nothing left to cancel.
      const settled = cause instanceof ApprovalError && cause.status < 500 && cause.status !== 429;
      if (saved && settled) forget(pairingId);
      toast.error(saved && !settled ? t().pairCancelFailed : t().failure);
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
  const installStep = () => (
    <>
      <PanelDialog.Body>
        <div class="flex flex-col gap-4">
          <h3 class="flex flex-col gap-0.5 text-sm font-semibold">
            <span class="text-xs font-normal text-dimmed">{t().step({ number: 1 })}</span>
            {t().installStep}
          </h3>
          <p class="text-sm text-dimmed">{t().installStepHint}</p>
          <InstallLink origin={props.appOrigin} />
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={next}>
            {t().alreadyInstalled}
          </Button>
          <Button onClick={next}>{t().next}</Button>
        </div>
      </PanelDialog.Footer>
    </>
  );
  const pairingStep = (close: () => void) => (
    <>
      <PanelDialog.Body>
        <Show when={step() === "pair"}>
          <h3 ref={pairHeading} tabIndex={-1} class="mb-4 flex flex-col gap-0.5 text-sm font-semibold focus:outline-none">
            <span class="text-xs font-normal text-dimmed">{t().step({ number: 2 })}</span>
            {t().pairStep}
          </h3>
        </Show>
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
            <Show when={state() === "denied"}>
              <NoticeCard tone="warning">
                <p role="status">{t().pairDenied}</p>
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
              {/* The code and the wait for a paired device share one place, so confirming moves nothing. */}
              <Show when={canConfirm() || awaitingApproval()}>
                <div class="grid">
                  <div
                    class="flex flex-col [grid-area:1/1]"
                    classList={{ invisible: !canConfirm() }}
                    aria-hidden={canConfirm() ? undefined : true}
                    inert={canConfirm() ? undefined : true}
                  >
                    <p class="text-sm">{t().confirmHint({ name: inspection()?.name ?? "" })}</p>
                    <div class="py-4 text-center" role="status">
                      <p class="text-sm">{t().comparison}</p>
                      <p class="mt-2 text-3xl sm:text-5xl font-mono tabular-nums tracking-widest">{inspection()?.comparison}</p>
                    </div>
                  </div>
                  <div
                    class="flex flex-col gap-2 [grid-area:1/1]"
                    classList={{ invisible: !awaitingApproval() }}
                    aria-hidden={awaitingApproval() ? undefined : true}
                    role="status"
                  >
                    <h3 class="text-sm font-semibold">{t().approvalTitle}</h3>
                    <p class="text-sm">{t().pairApprovalHint({ name: inspection()?.name ?? "" })}</p>
                    <p class="text-sm text-dimmed">{t().pairApprovalHelp}</p>
                  </div>
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
    </>
  );
  const content = (close: () => void) => (
    <PanelDialog>
      <PanelDialog.Header
        title={t().pair}
        subtitle={props.actorId !== props.userId ? props.name : undefined}
        icon="ti ti-device-mobile"
        close={close}
      />
      <Show when={step() !== "install"} fallback={installStep()}>
        {pairingStep(close)}
      </Show>
    </PanelDialog>
  );
  return null;
}
