import { apiClient } from "@k2b/cloud/clients/core";
import {
  PWA_LIMITS,
  PwaDeviceListSchema,
  type PwaDeviceView,
  PwaPairingStartResultSchema,
  PwaPairingStatusSchema,
  pairingLink,
} from "@k2b/cloud/contracts";
import { type DateContext, dates } from "@k2b/stdlib";
import { qr } from "@k2b/stdlib/qr";
import { announce, useLocale } from "@k2b/ui";
import { confirm as ask, Bar, Button, Canvas, Dialog, Empty, Field, Icon, Input, Row, Section, Text, useToast } from "@k2b/ui/v2";
import { createEffect, createMemo, createSignal, For, type JSX, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { z } from "zod";
import { ApprovalError, approvalRequestOptions, checked, parsed, pollApproval } from "../app-approval/client";
import { autocomplete } from "../auth/autocomplete";
import { useAccountMessages } from "./AccountWorkspace";

const pwaApi = apiClient.auth.pwa.v1;
const ResumeSchema = z.object({ id: z.string().uuid(), expiresAt: z.string().datetime() });
type Status = z.infer<typeof PwaPairingStatusSchema>;
type Waiting = { kind: "waiting"; id: string; expiresAt: string; link: string | null; claimUntil: string | null; status: Status | null };
type Pairing =
  | { kind: "starting" }
  | Waiting
  | { kind: "done"; name: string }
  | { kind: "expired" | "locked" | "cancelled" | "reauthenticate" }
  | { kind: "error"; code: string };

const icon = (platform: PwaDeviceView["platform"]) =>
  platform === "ios" ? "brand-apple" : platform === "android" ? "brand-android" : "device-mobile";

/**
 * The paired phones on `/me/app` and the pairing dialog. SSR renders the list; pairing needs the browser. Closing the
 * dialog cancels an open pairing. `pair` opens it from the page head; `dialog` must stand once in the screen.
 */
export const useAppDevices = (props: { userId: string; initial: PwaDeviceView[]; dateConfig: DateContext; summary: string }) => {
  const locale = useLocale();
  const t = useAccountMessages();
  const toast = useToast();
  const [dialogOpen, setDialogOpen] = createSignal(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  const [devices, setDevices] = createSignal(props.initial);
  const [pairing, setPairing] = createSignal<Pairing>({ kind: "starting" });
  const [code, setCode] = createSignal("");
  const [wrongCode, setWrongCode] = createSignal<number>();
  const [busy, setBusy] = createSignal(false);
  const [removing, setRemoving] = createSignal<string>();
  const [now, setNow] = createSignal(Date.now());
  // A phone or tablet can install the app itself. Decided when the dialog opens, so its body never swaps after the
  // first paint.
  const [touch, setTouch] = createSignal(false);
  const storageKey = `cloud.pwa-pairing:${props.userId}`;
  let stop = () => {};
  let stopCompletion = () => {};
  let codeInput: HTMLInputElement | HTMLTextAreaElement | undefined;
  let disposed = false;
  // Counts closed dialogs: an answer that arrives after its dialog closed changes nothing.
  let generation = 0;

  const remember = (value: z.infer<typeof ResumeSchema> | null) => {
    try {
      if (value) window.sessionStorage.setItem(storageKey, JSON.stringify(value));
      else window.sessionStorage.removeItem(storageKey);
    } catch {}
  };
  const finish = (next: Exclude<Pairing, { kind: "starting" } | Waiting>) => {
    stop();
    remember(null);
    setCode("");
    setWrongCode(undefined);
    setPairing(next);
  };
  const fail = (cause: unknown) => {
    if (cause instanceof ApprovalError && cause.code === "REAUTHENTICATE") return finish({ kind: "reauthenticate" });
    if (cause instanceof ApprovalError && (cause.code === "EXPIRED" || cause.code === "NOT_FOUND")) return finish({ kind: "expired" });
    finish({ kind: "error", code: cause instanceof ApprovalError ? cause.code : "UNKNOWN" });
  };

  const reload = async () => {
    try {
      const list = await parsed(await pwaApi.devices.$get(undefined, approvalRequestOptions()), PwaDeviceListSchema);
      if (!disposed) setDevices(list.items);
    } catch {}
  };

  /**
   * After the code is confirmed the phone still has to complete: only then does its device exist.
   * Keep reading the pairing until then, also after the dialog closed, so the list shows the new phone without a reload.
   */
  const awaitCompletion = (id: string, expiresAt: string, name: string) => {
    finish({ kind: "done", name });
    stopCompletion();
    stopCompletion = pollApproval(
      async (signal) => {
        if (Date.parse(expiresAt) <= Date.now()) {
          void reload();
          return false;
        }
        const status = await parsed(
          await pwaApi.pairings[":id"].$get({ param: { id } }, approvalRequestOptions(signal)),
          PwaPairingStatusSchema,
        );
        if (signal.aborted || disposed) return false;
        if (status.state === "confirmed") return true;
        void reload();
        return false;
      },
      (cause) => {
        if (cause instanceof ApprovalError && cause.status < 500 && cause.status !== 429) {
          void reload();
          return false;
        }
        return true;
      },
      PWA_LIMITS.pollSeconds,
    );
  };

  /**
   * Reads at once and then without a gap: the server holds a pending read until the phone claims the link, so the
   * dialog moves on to the code as soon as the phone scanned it.
   */
  const watch = (id: string, expiresAt: string) => {
    stop();
    stop = pollApproval(
      async (signal) => {
        if (Date.parse(expiresAt) <= Date.now()) {
          finish({ kind: "expired" });
          return false;
        }
        const status = await parsed(
          await pwaApi.pairings[":id"].$get({ param: { id } }, approvalRequestOptions(signal)),
          PwaPairingStatusSchema,
        );
        if (signal.aborted || disposed) return false;
        const name = status.device?.name ?? "";
        if (status.state === "completed") {
          finish({ kind: "done", name });
          void reload();
          return false;
        }
        if (status.state === "confirmed") {
          awaitCompletion(id, expiresAt, name);
          return false;
        }
        if (status.state === "cancelled") {
          finish({ kind: status.attemptsLeft === 0 ? "locked" : "cancelled" });
          return false;
        }
        setPairing((current) => (current.kind === "waiting" && current.id === id ? { ...current, status } : current));
        return true;
      },
      (cause) => {
        // Server and network failures keep polling; answers about the pairing end it.
        if (cause instanceof ApprovalError && cause.status < 500 && cause.status !== 429) {
          fail(cause);
          return false;
        }
        return true;
      },
      PWA_LIMITS.pollSeconds,
      { immediate: true },
    );
  };

  const start = async () => {
    if (busy()) return;
    const run = generation;
    setBusy(true);
    setCode("");
    setWrongCode(undefined);
    setPairing({ kind: "starting" });
    try {
      const result = await parsed(await pwaApi.pairings.$post(undefined, approvalRequestOptions()), PwaPairingStartResultSchema);
      if (disposed || run !== generation) {
        // The dialog closed while the pairing started: nobody can enter its code.
        void cancelPending(result.id);
        return;
      }
      remember({ id: result.id, expiresAt: result.expiresAt });
      setPairing({
        kind: "waiting",
        id: result.id,
        expiresAt: result.expiresAt,
        link: pairingLink(window.location.origin, result.secret),
        claimUntil: result.claimUntil,
        status: null,
      });
      watch(result.id, result.expiresAt);
    } catch (cause) {
      if (!disposed && run === generation) fail(cause);
    } finally {
      if (!disposed && run === generation) setBusy(false);
    }
  };

  const confirm = async () => {
    const current = pairing();
    if (current.kind !== "waiting" || busy() || code().length !== 6) return;
    const run = generation;
    setBusy(true);
    try {
      await checked(
        await pwaApi.pairings[":id"].confirm.$post({ param: { id: current.id }, json: { code: code() } }, approvalRequestOptions()),
      );
      if (!disposed && run === generation) awaitCompletion(current.id, current.expiresAt, current.status?.device?.name ?? "");
    } catch (cause) {
      if (disposed || run !== generation) return;
      if (cause instanceof ApprovalError && cause.code === "WRONG_CODE") {
        const left = Math.max(0, (current.status?.attemptsLeft ?? PWA_LIMITS.confirmAttempts) - 1);
        setCode("");
        setWrongCode(left);
        setPairing({ ...current, status: current.status ? { ...current.status, attemptsLeft: left } : null });
        codeInput?.focus();
      } else if (cause instanceof ApprovalError && cause.code === "EXPIRED" && cause.attemptsLeft === 0) {
        // The last wrong code cancels the pairing on the server, which says so; any other end is an expiry.
        finish({ kind: "locked" });
      } else if (!(cause instanceof ApprovalError) || cause.status >= 500 || cause.status === 429) {
        // No answer about the code: the pairing stays open, so the same code can be sent again.
        toast(t().pwaFailedToast, { status: "bad" });
      } else fail(cause);
    } finally {
      if (!disposed && run === generation) setBusy(false);
    }
  };

  const cancelPending = async (id: string) => {
    try {
      await checked(await pwaApi.pairings[":id"].cancel.$post({ param: { id } }, approvalRequestOptions()));
    } catch (cause) {
      // Already over on the server: nothing left to cancel.
      if (!(cause instanceof ApprovalError && (cause.code === "EXPIRED" || cause.code === "NOT_FOUND")) && !disposed)
        toast(t().pwaFailedToast, { status: "bad" });
    }
  };

  const copy = async () => {
    const current = pairing();
    if (current.kind !== "waiting" || !current.link) return;
    try {
      await navigator.clipboard.writeText(current.link);
      toast(t().pwaLinkCopied, { status: "ok" });
    } catch {
      toast(t().pwaCopyFailed, { status: "bad" });
    }
  };

  const remove = async (device: PwaDeviceView) => {
    if (removing()) return;
    const accepted = await ask({
      title: t().pwaRemoveTitle,
      description: t().pwaRemoveConfirm({ name: device.name }),
      confirm: t().pwaRemove,
    });
    if (!accepted || disposed) return;
    setRemoving(device.id);
    try {
      await checked(await pwaApi.devices[":id"].$delete({ param: { id: device.id } }, approvalRequestOptions()));
      if (disposed) return;
      setDevices((items) => items.filter((item) => item.id !== device.id));
      toast(t().pwaRemoved, { status: "ok" });
    } catch {
      if (!disposed) toast(t().pwaFailedToast, { status: "bad" });
    } finally {
      if (!disposed) setRemoving(undefined);
    }
  };

  const reauthenticate = () => {
    remember(null);
    const target = new URL("/me/app", window.location.origin);
    target.searchParams.set("pair", "1");
    target.searchParams.set("reauthenticate", "1");
    window.location.assign(`/auth/login?${new URLSearchParams({ redirectTo: target.pathname + target.search })}`);
  };

  /** Only a code on its way to the server holds the dialog open; everything else may be cancelled. */
  const confirming = () => busy() && step() === "code";
  const closed = () => {
    clearInterval(timer);
    setDialogOpen(false);
    // Leaving the page keeps the pairing, so a reload of this tab resumes it.
    if (disposed) return;
    generation += 1;
    const current = pairing();
    // Closing is cancelling: an open pairing must not stay claimable.
    stop();
    remember(null);
    if (current.kind === "waiting") void cancelPending(current.id);
    setCode("");
    setWrongCode(undefined);
    setBusy(false);
    setPairing({ kind: "starting" });
  };
  const requestClose = () => {
    if (dialogOpen() && !confirming()) closed();
  };

  /** Opens the dialog; `resume` continues a pairing this tab started before a reload. */
  const open = (resume?: z.infer<typeof ResumeSchema>) => {
    if (dialogOpen() || disposed) return;
    setTouch(!window.matchMedia("(pointer: fine)").matches);
    setNow(Date.now());
    timer = setInterval(() => setNow(Date.now()), 1000);
    setDialogOpen(true);
    if (resume) {
      setPairing({ kind: "waiting", id: resume.id, expiresAt: resume.expiresAt, link: null, claimUntil: null, status: null });
      watch(resume.id, resume.expiresAt);
    } else void start();
  };

  onMount(() => {
    const url = new URL(window.location.href);
    const requested = url.searchParams.get("pair") === "1";
    if (requested) {
      url.searchParams.delete("pair");
      url.searchParams.delete("reauthenticate");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
    try {
      const saved = ResumeSchema.safeParse(JSON.parse(window.sessionStorage.getItem(storageKey) || "null"));
      if (saved.success && Date.parse(saved.data.expiresAt) > Date.now()) return open(saved.data);
      remember(null);
    } catch {
      remember(null);
    }
    if (requested) open();
  });
  onCleanup(() => {
    disposed = true;
    stop();
    stopCompletion();
    clearInterval(timer);
  });

  const remaining = (until: string) => {
    // Clamped, so a server clock slightly ahead never shows more than the link's lifetime.
    const seconds = Math.min(PWA_LIMITS.linkClaimSeconds, Math.max(0, Math.ceil((Date.parse(until) - now()) / 1000)));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const day = (value: string) => {
    const context = { ...props.dateConfig, locale: locale() };
    if (dates.isToday(new Date(value), context)) return t().pwaToday;
    if (dates.isToday(new Date(Date.parse(value) + 86_400_000), context)) return t().pwaYesterday;
    return dates.formatDate(value, context);
  };
  const waiting = () => {
    const current = pairing();
    return current.kind === "waiting" ? current : null;
  };
  /** One name per screen of the dialog; the body changes only when it changes. */
  const step = createMemo(() => {
    const current = pairing();
    if (current.kind !== "waiting") return current.kind;
    if (current.status?.state === "claimed") return "code";
    return current.link ? "link" : "resumed";
  });
  const errorText = (code: string) =>
    code === "LIMIT_REACHED" ? t().pwaLimit : code === "UNAVAILABLE" ? t().pwaUnavailable : t().pwaFailed;
  const outcome = (): { icon: string; tone: "ok" | "warn" | "bad"; text: string } | null => {
    const current = pairing();
    if (current.kind === "done") return { icon: "circle-check", tone: "ok", text: t().pwaPairedTitle({ name: current.name }) };
    if (current.kind === "expired") return { icon: "clock-x", tone: "warn", text: t().pwaExpired };
    if (current.kind === "locked") return { icon: "lock", tone: "warn", text: t().pwaTooManyTries };
    if (current.kind === "cancelled") return { icon: "circle-x", tone: "warn", text: t().pwaCancelled };
    if (current.kind === "reauthenticate") return { icon: "shield-lock", tone: "warn", text: t().pwaReauthenticateHint };
    if (current.kind === "error") return { icon: "alert-circle", tone: "bad", text: errorText(current.code) };
    return null;
  };

  // Each screen of the dialog tells screen readers what changed; the code screen puts the focus in the field.
  createEffect(
    on(step, (current, previous) => {
      if (!dialogOpen() || current === previous) return;
      const result = outcome();
      if (current === "code") announce(t().pwaClaimed({ name: waiting()?.status?.device?.name ?? "" }));
      else if (current === "link") announce(t().pwaScanOrCopy);
      else if (result) announce(current === "done" ? `${result.text} ${t().pwaPaired}` : result.text);
      if (current === "code") queueMicrotask(() => codeInput?.focus());
    }),
  );

  const dialog = (): JSX.Element => (
    // k2b-ui gap: a dialog takes the height of each step (v1 kept one fixed height), and there is no code input of six
    // digits (PinInput); the code is a plain field that keeps digits only.
    <Dialog
      title={t().pwaPair}
      open={dialogOpen()}
      dismissible={false}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
      foot={
        <Switch>
          <Match when={step() === "starting" || step() === "resumed"}>
            <Button variant="ghost" onClick={requestClose}>
              {t().pwaCancel}
            </Button>
          </Match>
          <Match when={step() === "link"}>
            <Button variant="ghost" onClick={requestClose}>
              {t().pwaCancel}
            </Button>
            <Button variant="primary" icon="copy" onClick={() => void copy()}>
              {t().pwaCopyLink}
            </Button>
          </Match>
          <Match when={step() === "code"}>
            <Button variant="ghost" onClick={requestClose} disabled={confirming()}>
              {t().pwaCancel}
            </Button>
            <Button variant="primary" busy={busy()} disabled={code().length !== 6} onClick={() => void confirm()}>
              {t().pwaConfirm}
            </Button>
          </Match>
          <Match when={step() === "done"}>
            <Button variant="primary" onClick={requestClose}>
              {t().pwaDone}
            </Button>
          </Match>
          <Match when={step() === "reauthenticate"}>
            <Button variant="ghost" onClick={requestClose}>
              {t().pwaClose}
            </Button>
            <Button variant="primary" onClick={reauthenticate}>
              {t().pwaReauthenticate}
            </Button>
          </Match>
          <Match when={outcome()}>
            <Button variant="ghost" onClick={requestClose}>
              {t().pwaClose}
            </Button>
            <Button variant="primary" busy={busy()} onClick={() => void start()}>
              {t().pwaStartAgain}
            </Button>
          </Match>
        </Switch>
      }
    >
      <Switch>
        <Match when={step() === "starting"}>
          <Text muted>{t().pwaPreparing}</Text>
        </Match>
        <Match when={step() === "link" && waiting()}>
          {(current) => (
            <>
              <Text>{t().pwaScanOrCopy}</Text>
              {/* Every screen shows the code: a touch screen is as often a tablet or a laptop as the phone to pair. */}
              <Show when={current().link}>
                {(link) => (
                  // k2b-ui gap: no primitive shows a QR code; it is a drawing in a Canvas.
                  <Canvas label={t().pwaQrLabel} height={224}>
                    <img
                      alt={t().pwaQrLabel}
                      width="224"
                      height="224"
                      style={{
                        display: "block",
                        margin: "0 auto",
                        height: "100%",
                        background: "#fff",
                        padding: "8px",
                        "box-sizing": "border-box",
                      }}
                      src={`data:image/svg+xml,${encodeURIComponent(qr.toSvg(link()))}`}
                    />
                  </Canvas>
                )}
              </Show>
              <Show when={current().claimUntil}>{(until) => <Text muted>{t().pwaLinkValid({ time: remaining(until()) })}</Text>}</Show>
              <Show when={touch()} fallback={<Text muted>{t().pwaNoAppYet}</Text>}>
                <Text muted>{t().pwaNoAppOnPhone}</Text>
                <Bar
                  end={
                    <Button icon="download" href="/pwa/">
                      {t().pwaInstall}
                    </Button>
                  }
                />
              </Show>
            </>
          )}
        </Match>
        <Match when={step() === "resumed"}>
          <Text muted>{t().pwaResumed}</Text>
        </Match>
        <Match when={step() === "code"}>
          <Text>{t().pwaClaimed({ name: waiting()?.status?.device?.name ?? "" })}</Text>
          <Field
            name="code"
            label={t().pwaCode}
            error={wrongCode() === undefined ? undefined : t().pwaWrongCode({ count: wrongCode() ?? 0 })}
            required
          >
            <Input
              value={code()}
              placeholder="000000"
              disabled={busy()}
              ref={(element) => {
                codeInput = element;
                autocomplete("one-time-code")(element);
              }}
              onInput={(value) => {
                const digits = value.replace(/\D/g, "").slice(0, 6);
                setCode(digits);
                if (digits) setWrongCode(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.isComposing) void confirm();
              }}
            />
          </Field>
        </Match>
        <Match when={outcome()}>
          {(result) => (
            <>
              <Text weight={step() === "done" ? "strong" : undefined}>
                <Icon name={result().icon} tone={result().tone} /> {result().text}
              </Text>
              <Show when={step() === "done"}>
                <Text muted>{t().pwaPaired}</Text>
              </Show>
            </>
          )}
        </Match>
      </Switch>
    </Dialog>
  );

  const section = (): JSX.Element => (
    <Section
      icon="device-mobile"
      title={t().pwaPhones}
      count={devices().length}
      summary={props.summary}
      actions={[{ label: t().pwaPair, icon: "plus", onClick: () => open() }]}
    >
      <Show
        when={devices().length}
        fallback={
          <Empty icon="device-mobile" text={t().pwaNoPhones} action={{ label: t().pwaPair, icon: "plus", onClick: () => open() }} />
        }
      >
        <For each={devices()}>
          {(device) => (
            <Row
              icon={icon(device.platform)}
              lines={[device.name, `${device.current ? `${t().pwaThisPhone} · ` : ""}${t().pwaLastUsed({ when: day(device.lastUsedAt) })}`]}
              end={
                <Button
                  variant="ghost"
                  icon="trash"
                  label={t().pwaRemoveDevice({ name: device.name })}
                  busy={removing() === device.id}
                  disabled={Boolean(removing()) && removing() !== device.id}
                  onClick={() => void remove(device)}
                />
              }
            />
          )}
        </For>
      </Show>
    </Section>
  );

  return { section, dialog, pair: () => open() };
};
