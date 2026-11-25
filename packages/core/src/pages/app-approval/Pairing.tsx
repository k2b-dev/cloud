import { appApproval } from "@k2b/cloud/browser/app-approval";
import { AppPairingConfirmResultSchema, AppPairingInspectionSchema, AppPairingPayloadSchema } from "@k2b/cloud/contracts";
import { qr } from "@k2b/stdlib/qr";
import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Canvas, Dialog, Notice, Text, useToast } from "@k2b/ui/v2";
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
  const toast = useToast();
  const [open, setOpen] = createSignal(true);
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
  const canRestart = () => !needsAuthentication() && (state() === "expired" || state() === "denied" || (state() === "idle" && !!error()));
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
    if (next === "cancelled") close();
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
  const next = () => {
    setStep("pair");
    void start();
  };
  onCleanup(() => {
    disposed = true;
    stop();
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    // The pairing is settled before the dialog closes, so a failing close never leaves it claimable.
    if (disposed) return setOpen(false);
    stop();
    const pending = reference();
    // The saved reference stays until Cloud confirms the cancellation, so reopening the dialog can retry it.
    if (pending) void cancelPending(pending.pairingId, true);
    else forget();
    props.onClose();
    setOpen(false);
  };
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
        toast(t().paired, { status: "ok" });
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
      toast(t().copied, { status: "ok" });
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
      toast(saved && !settled ? t().pairCancelFailed : t().failure, { status: "bad" });
    }
  };
  const confirmIdentity = () => {
    forget();
    const target = new URL(returnTo, window.location.origin);
    target.searchParams.set("pairDevice", props.userId);
    target.searchParams.set("reauthenticate", "1");
    window.location.assign(`/auth/login?${new URLSearchParams({ redirectTo: target.pathname + target.search })}`);
  };
  const qrImage = (value: string) => (
    // k2b-ui gap: no primitive shows a QR code; it is a drawing in a Canvas.
    <Band>
    <Canvas label={t().qr} height={256}>
      <img
        alt={t().qr}
        width="256"
        height="256"
        style={{ display: "block", margin: "0 auto", "max-width": "100%", height: "100%" }}
        src={`data:image/svg+xml,${encodeURIComponent(qr.toSvg(value))}`}
      />
    </Canvas>
    </Band>
  );
  // k2b-ui gap: no polite live status in v2 (Notice speaks only when "bad"), and a dialog takes the height of each step.
  return (
    <Dialog
      title={props.actorId !== props.userId ? t().pairFor({ name: props.name }) : t().pair}
      open={open()}
      dismissible={false}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      foot={
        <Show
          when={step() !== "install"}
          fallback={
            <>
              <Button onClick={next}>{t().alreadyInstalled}</Button>
              <Button variant="primary" onClick={next}>
                {t().next}
              </Button>
            </>
          }
        >
          <Show when={!checkingIdentity() && canRestart()}>
            <Button variant="primary" busy={busy()} onClick={() => void start()}>
              {t().tryAgain}
            </Button>
          </Show>
          <Show when={!checkingIdentity() && canCancelResume()}>
            <Button onClick={close}>{t().cancel}</Button>
          </Show>
          <Show when={!checkingIdentity() && needsAuthentication()}>
            <Button variant="primary" onClick={confirmIdentity}>
              {t().reauthenticate}
            </Button>
          </Show>
          <Show when={!checkingIdentity() && !needsAuthentication() && canConfirm()}>
            <Button variant="primary" busy={busy()} onClick={() => void change(true)}>
              {t().confirm}
            </Button>
          </Show>
        </Show>
      }
    >
      <Show
        when={step() !== "install"}
        fallback={
          <>
            <Text muted type="meta">
              {t().step({ number: 1 })}
            </Text>
            <Text weight="strong">{t().installStep}</Text>
            <Text muted>{t().installStepHint}</Text>
            <InstallLink origin={props.appOrigin} />
          </>
        }
      >
        <Show when={step() === "pair"}>
          <Text muted type="meta">
            {t().step({ number: 2 })}
          </Text>
          <Text weight="strong">{t().pairStep}</Text>
        </Show>
        <Show when={!checkingIdentity()} fallback={<Text muted>{t().checkingIdentity}</Text>}>
          <Show when={props.actorId !== props.userId && !needsAuthentication()}>
            <Notice tone="warn">{t().assistedWarning}</Notice>
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
            <Notice tone="warn" icon="shield-lock">
              {props.actorId !== props.userId ? t().confirmAdminIdentity : t().confirmPairingIdentity}
            </Notice>
          </Show>
          <Show when={retrying()}>
            <Text muted>{t().retrying}</Text>
          </Show>
          <Show when={state() === "expired"}>
            <Text muted>{t().expired}</Text>
          </Show>
          <Show when={state() === "done"}>
            <Notice tone="note" icon="circle-check">
              {t().done}
            </Notice>
          </Show>
          <Show when={state() === "denied"}>
            <Notice tone="warn">{t().pairDenied}</Notice>
          </Show>
          <Show when={state() === "waiting" && !needsAuthentication()}>
            <Show
              when={link()}
              fallback={
                <Show when={!inspection()?.comparison}>
                  <Text muted>{t().resumed}</Text>
                </Show>
              }
            >
              {(value) => (
                <>
                  <Text muted>{t().instructions}</Text>
                  {qrImage(value())}
                  <Bar
                    end={
                      <Button icon="copy" onClick={copy}>
                        {t().copy}
                      </Button>
                    }
                  />
                </>
              )}
            </Show>
            <Show when={canConfirm()}>
              <Text>{t().confirmHint({ name: inspection()?.name ?? "" })}</Text>
              <Text muted>{t().comparison}</Text>
              {/* k2b-ui gap: no primitive shows a short code to compare at a glance; it is drawn in a Canvas. */}
              <Band>
              <Canvas label={t().comparison} height={72}>
                <span
                  style={{
                    display: "grid",
                    "place-items": "center",
                    height: "100%",
                    "font-family": "var(--k2-font-mono, ui-monospace, monospace)",
                    "font-size": "40px",
                    "letter-spacing": "0.2em",
                    "font-variant-numeric": "tabular-nums",
                  }}
                >
                  {inspection()?.comparison}
                </span>
              </Canvas>
              </Band>
            </Show>
            <Show when={awaitingApproval()}>
              <Text weight="strong">{t().approvalTitle}</Text>
              <Text>{t().pairApprovalHint({ name: inspection()?.name ?? "" })}</Text>
              <Text muted>{t().pairApprovalHelp}</Text>
            </Show>
          </Show>
        </Show>
      </Show>
    </Dialog>
  );
}
