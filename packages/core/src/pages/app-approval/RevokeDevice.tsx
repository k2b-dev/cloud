import { AppDeviceRemovalStatusSchema, AppDeviceRevokeResultSchema } from "@k2b/cloud/contracts";
import { useLocale } from "@k2b/ui";
import { Button, Check, Dialog, Icon, Text, useToast } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { z } from "zod";
import { ApprovalError, approvalApi, approvalRequestOptions, checked, parsed, pollApproval } from "./client";
import ApprovalFeedback from "./Feedback";
import { appApprovalMessages } from "./messages";

/** A revocation waiting for approval, kept for this tab so a reload continues it. */
export const RevokeRequestSchema = z
  .object({
    changeId: z.string().uuid(),
    deviceId: z.string().uuid(),
    name: z.string(),
    endSessions: z.boolean(),
    expiresAt: z.string().datetime(),
    /** The dialog that saved it; a closed dialog leaves a newer dialog's request alone. */
    owner: z.string().uuid().optional(),
  })
  .strict();
export type RevokeRequest = z.infer<typeof RevokeRequestSchema>;
/** Without `changeId`, a send whose answer was lost: Cloud may hold a request that this session can still find. */
export const SavedRevokeSchema = RevokeRequestSchema.partial({ changeId: true });
export type SavedRevoke = z.infer<typeof SavedRevokeSchema>;
export const revokeStorageKey = (userId: string) => `cloud.app-device-revoke:${userId}`;
/** This session's newest removal request for the device, read without sending anything again. */
export const findRemoval = async (saved: Omit<SavedRevoke, "changeId" | "expiresAt">): Promise<RevokeRequest | undefined> => {
  try {
    const status = await parsed(
      await approvalApi.manage["device-changes"].status.$post({ json: { deviceId: saved.deviceId } }, approvalRequestOptions()),
      AppDeviceRemovalStatusSchema,
    );
    // Cloud's own choice: the last attempted one may never have reached it.
    return status.state === "pending"
      ? { ...saved, changeId: status.changeId, endSessions: status.endSessions, expiresAt: status.expiresAt }
      : undefined;
  } catch (cause) {
    if (cause instanceof ApprovalError && cause.status === 404) return undefined;
    throw cause;
  }
};

/** `gone`: Cloud no longer keeps the request (a minute after it ended), so its result is unknown. */
type Phase = "ask" | "waiting" | "approved" | "denied" | "expired" | "gone" | "error";

/**
 * Asks the account's paired devices to approve revoking one of them, then follows the request in a v2 dialog that a
 * press outside does not close.
 */
export default function RevokeDevice(props: {
  userId: string;
  device: { id: string; name: string };
  resume?: RevokeRequest;
  onClose: (revoked: boolean) => void;
}) {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  const toast = useToast();
  const [open, setOpen] = createSignal(true);
  const [phase, setPhase] = createSignal<Phase>(props.resume ? "waiting" : "ask");
  const [endSessions, setEndSessions] = createSignal(props.resume?.endSessions ?? true);
  const [request, setRequest] = createSignal(props.resume);
  const [busy, setBusy] = createSignal(false);
  // Only an approved request with the choice ends the sign-ins this device approved.
  const [sessionsEnded, setSessionsEnded] = createSignal(false);
  const [error, setError] = createSignal<unknown>();
  const [retrying, setRetrying] = createSignal(false);
  const [online, setOnline] = createSignal(typeof navigator === "undefined" ? true : navigator.onLine);
  const key = revokeStorageKey(props.userId);
  // Read once: the dialog keeps working after its parent stopped showing it, while a late answer is withdrawn.
  const device = { id: props.device.id, name: props.device.name };
  const owner = crypto.randomUUID();
  let stop = () => {};
  let disposed = false;
  let dismissed = false;
  // The last send failed without a definite answer: Cloud may have created the request anyway.
  let unsure = false;
  /** Saves this dialog's request; `undefined` clears only a record of this device, or of `changeId` when given, so a
   * late answer of an earlier dialog never drops the request of a newer one. */
  const remember = (value: SavedRevoke | undefined, changeId?: string) => {
    try {
      if (value) {
        window.sessionStorage.setItem(key, JSON.stringify({ ...value, owner }));
        return;
      }
      const saved = stored();
      if (!saved || (ours() && saved.deviceId === device.id && (!changeId || !saved.changeId || saved.changeId === changeId)))
        window.sessionStorage.removeItem(key);
    } catch {}
  };
  const stored = () => {
    try {
      const saved = SavedRevokeSchema.safeParse(JSON.parse(window.sessionStorage.getItem(key) || "null"));
      return saved.success ? saved.data : undefined;
    } catch {
      return undefined;
    }
  };
  /** No newer dialog has saved a request since this one did. */
  const ours = () => {
    const saved = stored();
    return !saved?.owner || saved.owner === owner;
  };
  const finish = (next: Exclude<Phase, "ask" | "waiting" | "error">) => {
    stop();
    remember(undefined);
    setRetrying(false);
    setPhase(next);
  };
  const follow = (value: RevokeRequest) => {
    stop();
    setRequest(value);
    setPhase("waiting");
    stop = pollApproval(
      // Cloud decides expiry: after a decision it still answers approved or denied for a minute, then 404.
      async (signal) => {
        const status = await parsed(
          await approvalApi.manage["device-changes"].status.$post({ json: { changeId: value.changeId } }, approvalRequestOptions(signal)),
          AppDeviceRemovalStatusSchema,
        );
        if (signal.aborted) return false;
        setRetrying(false);
        if (status.state === "pending") return true;
        setSessionsEnded(status.state === "approved" && value.endSessions);
        finish(status.state === "approved" ? "approved" : status.state === "denied" ? "denied" : "expired");
        return false;
      },
      (cause) => {
        // Gone or no longer this session's: the request cannot be approved any more. Cloud keeps a decided request
        // for a minute only, so a 404 does not say whether it was approved.
        if (cause instanceof ApprovalError && cause.status < 500 && cause.status !== 429) {
          finish(cause.status === 404 ? "gone" : "expired");
          return false;
        }
        setRetrying(true);
        return true;
      },
      5,
      { immediate: Boolean(props.resume) && value === props.resume },
    );
  };
  const submit = async () => {
    if (busy() || !online()) return;
    setBusy(true);
    setError(undefined);
    // Saved before sending: if the page goes away meanwhile, a reload finds what Cloud may have created.
    remember({
      deviceId: device.id,
      name: device.name,
      endSessions: endSessions(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    try {
      const result = await parsed(
        await approvalApi.manage.devices.update.$post(
          { json: { operation: "revoke", deviceId: device.id, endSessions: endSessions() } },
          approvalRequestOptions(),
        ),
        AppDeviceRevokeResultSchema,
      );
      if (disposed || dismissed) {
        // Closed while the request was on its way: withdraw it, so nothing is revoked after the person left.
        // Saved first: if withdrawing fails, a reload still shows the request.
        // A newer dialog for the same device follows this request only when Cloud gave it the same one: with the same
        // choice Cloud answers with the open request, with another it replaces it. Any other request is withdrawn,
        // and the record is only taken over while no newer dialog saved one.
        const newer = stored();
        const followed =
          !ours() &&
          newer?.deviceId === device.id &&
          (newer.changeId === undefined
            ? newer.endSessions === endSessions()
            : result.state === "pending" && newer.changeId === result.changeId);
        if (result.state === "pending" && !followed) {
          if (ours())
            remember({
              changeId: result.changeId,
              deviceId: device.id,
              name: device.name,
              endSessions: endSessions(),
              expiresAt: result.expiresAt,
            });
          void cancelPending(result.changeId);
        } else if (result.state === "revoked") remember(undefined);
        return;
      }
      unsure = false;
      if (result.state === "revoked") {
        // Revoked meanwhile, for example by an administrator: no request ended the sign-ins it approved.
        setSessionsEnded(false);
        finish("approved");
        return;
      }
      const value = {
        changeId: result.changeId,
        deviceId: device.id,
        name: device.name,
        endSessions: endSessions(),
        expiresAt: result.expiresAt,
      };
      remember(value);
      follow(value);
    } catch (cause) {
      // Without a definite answer Cloud may hold the request; keep enough to find it again, also after a reload.
      // An earlier unsure send stays unsure until a definite answer names its request.
      unsure ||= !(cause instanceof ApprovalError) || cause.status >= 500;
      if (!unsure) remember(undefined);
      // A newer dialog may have saved its own request since this one closed; that one is left alone.
      if (unsure && !(dismissed && !ours()))
        remember({
          deviceId: device.id,
          name: device.name,
          endSessions: endSessions(),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        });
      // Closed while the send was on its way: withdraw whatever Cloud may have created.
      if (unsure && (disposed || dismissed)) void withdrawUnsure();
      if (!disposed) {
        setError(cause);
        setPhase("error");
      }
    } finally {
      if (!disposed) setBusy(false);
    }
  };
  /** Finds a request whose answer was lost and withdraws it; until that worked, a reload looks again. */
  const withdrawUnsure = async () => {
    if (!ours()) return;
    try {
      const found = await findRemoval({ deviceId: device.id, name: device.name, endSessions: endSessions() });
      if (!ours()) return;
      // Nothing found does not prove nothing will be: a send still held up in Cloud may commit later. The record
      // stays until it expires, so a reload looks again.
      if (!found) return;
      remember(found);
      await cancelPending(found.changeId);
    } catch {
      toast(t().cancelFailed, { status: "bad" });
    }
  };
  /** Forgets the saved request only once Cloud withdrew it; otherwise a reload of the page continues it. */
  const cancelPending = async (changeId: string) => {
    try {
      await checked(await approvalApi.manage["device-changes"].cancel.$post({ json: { changeId } }, approvalRequestOptions()));
      remember(undefined, changeId);
    } catch (cause) {
      // Already decided or expired: nothing is left to withdraw.
      if (cause instanceof ApprovalError && (cause.status === 404 || cause.status === 409)) remember(undefined, changeId);
      else toast(t().cancelFailed, { status: "bad" });
    }
  };
  const connection = () => setOnline(navigator.onLine);
  onMount(() => {
    window.addEventListener("online", connection);
    window.addEventListener("offline", connection);
    const resumed = props.resume;
    if (resumed) {
      remember(resumed);
      follow(resumed);
    }
  });
  onCleanup(() => {
    disposed = true;
    stop();
    window.removeEventListener("online", connection);
    window.removeEventListener("offline", connection);
  });
  const close = () => {
    if (dismissed) return;
    setOpen(false);
    dismissed = true;
    if (disposed) return;
    stop();
    // Closing while the request waits withdraws it, so nothing is revoked after the person left.
    const waiting = phase() === "waiting" ? request() : undefined;
    if (waiting) void cancelPending(waiting.changeId);
    else if (unsure) void withdrawUnsure();
    // A send still on its way keeps its record: its answer, or a reload, reconciles it.
    else if (!busy()) remember(undefined);
    props.onClose(phase() === "approved");
  };
  const name = () => device.name;
  // k2b-ui gap: no polite live status in v2 (Notice speaks only when "bad"); the phase texts change without being
  // announced, and the dialog takes the height of each phase.
  return (
    <Dialog
      title={t().revokeDeviceNamed({ name: name() })}
      open={open()}
      dismissible={false}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      foot={
        <>
          <Show when={phase() === "ask"}>
            <Button variant="ghost" disabled={busy()} onClick={close}>
              {t().cancelWait}
            </Button>
            <Button variant="primary" icon="device-mobile-off" busy={busy()} disabled={!online()} onClick={() => void submit()}>
              {t().revoke}
            </Button>
          </Show>
          <Show when={phase() === "waiting"}>
            <Button onClick={close}>{t().cancelRequest}</Button>
          </Show>
          <Show when={phase() === "denied" || phase() === "expired" || phase() === "gone" || phase() === "error"}>
            <Button variant="ghost" onClick={close}>
              {t().close}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setError(undefined);
                setPhase("ask");
              }}
            >
              {t().tryAgain}
            </Button>
          </Show>
          <Show when={phase() === "approved"}>
            <Button variant="primary" onClick={close}>
              {t().close}
            </Button>
          </Show>
        </>
      }
    >
      <Show when={phase() === "ask"}>
        <Text>{online() ? t().revokeIntro : t().revokeOffline}</Text>
        <Check label={t().endSessions} checked={endSessions()} onChange={setEndSessions} disabled={busy()} />
        <Text muted type="meta">
          {t().endSessionsHint}
        </Text>
      </Show>
      <Show when={phase() === "waiting"}>
        <Text weight="strong">{t().approvalTitle}</Text>
        <Text>{t().revokeApprovalHint({ name: name() })}</Text>
        <Text muted>{t().revokeApprovalHelp}</Text>
        <Show when={retrying()}>
          <Text muted>{t().retrying}</Text>
        </Show>
      </Show>
      <Show when={phase() === "approved"}>
        <Text>
          <Icon name="check" tone="ok" /> {t().revokeDone({ name: name() })}
        </Text>
        <Show when={sessionsEnded()}>
          <Text muted>{t().revokeDoneSessions}</Text>
        </Show>
      </Show>
      <Show when={phase() === "denied"}>
        <Text>
          <Icon name="x" /> {t().revokeDenied({ name: name() })}
        </Text>
      </Show>
      <Show when={phase() === "expired"}>
        <Text>
          <Icon name="clock" /> {t().revokeExpired({ name: name() })}
        </Text>
      </Show>
      <Show when={phase() === "gone"}>
        <Text>
          <Icon name="help-circle" /> {t().revokeGone({ name: name() })}
        </Text>
      </Show>
      <Show when={phase() === "error"}>
        <ApprovalFeedback error={error()} returnTo="/me/security" />
      </Show>
    </Dialog>
  );
}
