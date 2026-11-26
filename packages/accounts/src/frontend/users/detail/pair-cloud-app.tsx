import { apiClient } from "@k2b/cloud/clients/core";
import { PWA_LIMITS, PwaPairingStartResultSchema, PwaPairingStatusSchema, pairingLink } from "@k2b/cloud/contracts";
import { qr } from "@k2b/stdlib/qr";
import { useLocale } from "@k2b/ui";
import { Button, Canvas, Dialog, Facts, Field, Input, Notice, Prose, Text } from "@k2b/ui/v2";
import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { z } from "zod";
import { accountsMessages } from "../../messages";

const api = apiClient.auth.pwa.v1;
const Resume = z.object({ id: z.string().uuid(), expiresAt: z.string().datetime() });
type Pairing = z.infer<typeof Resume> & { link?: string; claimUntil?: string };
type Status = z.infer<typeof PwaPairingStatusSchema>;
type Step = "starting" | "link" | "code" | "waiting" | "done" | "rejected" | "expired" | "locked" | "reauthenticate" | "error";
const RUNNING: readonly Step[] = ["link", "code", "waiting"];

class PairingError extends Error {
  constructor(
    readonly code: string,
    readonly attemptsLeft?: number,
  ) {
    super(code);
  }
}
const checked = async <T extends Pick<Response, "ok" | "json">>(response: T) => {
  if (response.ok) return response;
  const error = await response.json().catch(() => null);
  const parsed = z.object({ code: z.string(), attemptsLeft: z.number().optional() }).safeParse(error);
  throw new PairingError(parsed.success ? parsed.data.code : "UNAVAILABLE", parsed.success ? parsed.data.attemptsLeft : undefined);
};

/**
 * Pairing the Cloud app on another person's phone, for an administrator: a link as QR code, the code the phone then
 * shows, and the person's own confirmation on the phone. The pairing's ID (never its secret) stays in the tab, so a
 * reload resumes it; closing ends it. `?pairCloudApp=1` (the way back from signing in again) opens it. Call it while
 * the page renders; put `dialog()` once into the page and call `start()` from its button.
 */
export function createCloudAppPairing(props: {
  userId: string;
  name: string;
  administrator: string;
  blocked: boolean;
  paired: () => void;
}) {
  const locale = useLocale();
  const t = () => accountsMessages.resolve([locale()]).t;
  const storageKey = `cloud.admin-pwa-pairing:${props.userId}`;
  const [open, setOpen] = createSignal(false);
  const [step, setStep] = createSignal<Step>("starting");
  const [pairing, setPairing] = createSignal<Pairing>();
  const [status, setStatus] = createSignal<Status>();
  const [wrongCode, setWrongCode] = createSignal<string>();
  const [code, setCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [connectionError, setConnectionError] = createSignal<string>();
  const [now, setNow] = createSignal(Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let active = false;
  // the list shows a new device after the dialog closed, so the page does not change under the open dialog
  let succeeded = false;
  let codeInput: HTMLInputElement | HTMLTextAreaElement | undefined;
  const running = () => Boolean(pairing()) && RUNNING.includes(step());

  const remember = (value: Pairing | null) => {
    try {
      if (value) window.sessionStorage.setItem(storageKey, JSON.stringify({ id: value.id, expiresAt: value.expiresAt }));
      else window.sessionStorage.removeItem(storageKey);
    } catch {
      /* The dialog also works without tab storage. */
    }
  };
  const stop = () => {
    clearTimeout(timer);
    controller?.abort();
  };
  const finish = (value: Step) => {
    stop();
    setStep(value);
    remember(null);
  };
  const fail = (cause: unknown) => {
    if (cause instanceof PairingError) {
      if (cause.code === "REAUTHENTICATE") return finish("reauthenticate");
      if (cause.code === "EXPIRED" || cause.code === "NOT_FOUND") return finish(cause.attemptsLeft === 0 ? "locked" : "expired");
      if (cause.code === "ACCOUNT_BLOCKED") {
        setError(t().cloudAppBlocked({ name: props.name }));
        return finish("error");
      }
      if (cause.code === "LIMIT_REACHED") {
        setError(t().cloudAppLimit);
        return finish("error");
      }
      if (cause.code === "FORBIDDEN") {
        setError(t().cloudAppReauthenticate);
        return finish("reauthenticate");
      }
    }
    setError(cause instanceof PairingError && cause.code === "UNAVAILABLE" ? t().cloudAppUnavailable : t().cloudAppFailed);
  };
  const poll = async () => {
    const current = pairing();
    if (!active || !current) return;
    if (Date.parse(current.expiresAt) <= Date.now()) return finish("expired");
    const request = new AbortController();
    controller = request;
    try {
      const response = await checked(await api.pairings[":id"].$get({ param: { id: current.id } }, { init: { signal: request.signal } }));
      const state = PwaPairingStatusSchema.parse(await response.json());
      if (!active || request.signal.aborted) return;
      setStatus(state);
      setConnectionError(undefined);
      if (state.state === "completed") {
        succeeded = true;
        return finish("done");
      }
      if (state.state === "rejected") return finish("rejected");
      if (state.state === "cancelled") return finish(state.attemptsLeft === 0 ? "locked" : "expired");
      const next =
        state.state === "claimed" ? "code" : state.state === "awaiting_device" || state.state === "confirmed" ? "waiting" : "link";
      if (next === "code" && step() !== "code") queueMicrotask(() => codeInput?.focus());
      setStep(next);
    } catch (cause) {
      if (active && !request.signal.aborted) {
        if (cause instanceof PairingError && !["UNAVAILABLE", "INVALID_REQUEST"].includes(cause.code)) fail(cause);
        else setConnectionError(t().cloudAppFailed);
      }
    }
    // the phone moves on its own: ask again while the pairing runs and the dialog is open
    if (active && !request.signal.aborted && RUNNING.includes(step())) timer = setTimeout(() => void poll(), PWA_LIMITS.pollSeconds * 1000);
  };
  const begin = async () => {
    stop();
    setCode("");
    setWrongCode(undefined);
    setStep("starting");
    setError(undefined);
    setConnectionError(undefined);
    setBusy(true);
    try {
      const result = PwaPairingStartResultSchema.parse(
        await (await checked(await api.users[":userId"].pairings.$post({ param: { userId: props.userId } }))).json(),
      );
      if (!active) {
        await api.pairings[":id"].cancel.$post({ param: { id: result.id } }).catch(() => null);
        return;
      }
      const current = { ...result, link: pairingLink(location.origin, result.secret) };
      setPairing(current);
      remember(current);
      setStep("link");
      void poll();
    } catch (cause) {
      if (active) {
        fail(cause);
        if (step() === "starting") setStep("error");
      }
    } finally {
      if (active) setBusy(false);
    }
  };
  const confirm = async () => {
    const current = pairing();
    if (!current || busy() || code().length !== 6) return;
    stop();
    setBusy(true);
    setError(undefined);
    try {
      await checked(await api.pairings[":id"].confirm.$post({ param: { id: current.id }, json: { code: code() } }));
      if (active) {
        setStep("waiting");
        void poll();
      }
    } catch (cause) {
      if (!active) return;
      if (cause instanceof PairingError && cause.code === "WRONG_CODE") {
        setCode("");
        setWrongCode(t().cloudAppWrongCode({ count: cause.attemptsLeft ?? 0 }));
        codeInput?.focus();
      } else if (cause instanceof PairingError && !["UNAVAILABLE", "INVALID_REQUEST"].includes(cause.code)) fail(cause);
      else setConnectionError(t().cloudAppFailed);
      if (["code", "waiting"].includes(step())) void poll();
    } finally {
      if (active) setBusy(false);
    }
  };
  const show = (resume?: Pairing) => {
    if (open() || props.blocked) return;
    active = true;
    succeeded = false;
    setPairing(undefined);
    setStatus(undefined);
    setOpen(true);
    if (resume) {
      setPairing(resume);
      setStep("link");
      void poll();
    } else void begin();
  };
  /** Closing a running pairing cancels it on the server first; a failed cancel keeps the dialog and says so. */
  const close = async () => {
    if (busy()) return;
    const current = pairing();
    if (current && running()) {
      stop();
      setBusy(true);
      try {
        await checked(await api.pairings[":id"].cancel.$post({ param: { id: current.id } }));
      } catch (cause) {
        fail(cause);
        setBusy(false);
        void poll();
        return;
      }
      setBusy(false);
    }
    remember(null);
    active = false;
    stop();
    setOpen(false);
    if (succeeded) props.paired();
  };
  const remaining = () => {
    const until = step() === "link" ? (pairing()?.claimUntil ?? pairing()?.expiresAt) : pairing()?.expiresAt;
    const seconds = Math.max(0, Math.ceil((Date.parse(until ?? "") - now()) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const signInHref = () => {
    const url = new URL(location.href);
    url.searchParams.set("pairCloudApp", "1");
    return `/auth/login?${new URLSearchParams({ redirectTo: url.pathname + url.search, credential: "legacy" })}`;
  };

  onMount(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(clock));
    if (props.blocked) return;
    const url = new URL(location.href);
    const requested = url.searchParams.get("pairCloudApp") === "1";
    if (requested) {
      url.searchParams.delete("pairCloudApp");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    }
    try {
      const saved = Resume.safeParse(JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null"));
      if (saved.success && Date.parse(saved.data.expiresAt) > Date.now()) return show(saved.data);
      remember(null);
    } catch {
      remember(null);
    }
    if (requested) show();
  });
  onCleanup(() => {
    active = false;
    stop();
  });

  const dialog = () => (
    <Dialog
      title={t().cloudAppPairTitle({ name: props.name })}
      open={open()}
      onOpenChange={(next) => {
        if (!next) void close();
      }}
      foot={
        <>
          {/* While a pairing runs, closing ends it. */}
          <Button disabled={busy()} onClick={() => void close()}>
            {running() ? t().cloudAppCancel : t().close}
          </Button>
          <Show when={step() === "code"}>
            <Button variant="primary" busy={busy()} disabled={code().length !== 6} onClick={() => void confirm()}>
              {t().cloudAppConfirm}
            </Button>
          </Show>
          <Show when={step() === "reauthenticate"}>
            <Button variant="primary" href={signInHref()}>
              {t().cloudAppSignIn}
            </Button>
          </Show>
          <Show when={["expired", "locked", "rejected", "error"].includes(step())}>
            <Button variant="primary" busy={busy()} onClick={() => void begin()}>
              {t().cloudAppAgain}
            </Button>
          </Show>
        </>
      }
    >
      <Switch>
        <Match when={step() === "starting"}>
          <Text>{t().cloudAppPreparing}</Text>
        </Match>
        <Match when={step() === "link" || step() === "code"}>
          <Text>{t().cloudAppPairWarning({ name: props.name })}</Text>
          <Prose
            markdown={[t().cloudAppPairStepOne, t().cloudAppPairStepTwo, t().cloudAppPairStepThree]
              .map((line, index) => `${index + 1}. ${line}`)
              .join("\n")}
          />
          <Show when={step() === "link"}>
            <Show when={pairing()?.link} fallback={<Text>{t().cloudAppResumed}</Text>}>
              {(link) => (
                <>
                  <Canvas label={t().cloudAppPair} height={240}>
                    <img
                      alt={t().cloudAppPair}
                      src={`data:image/svg+xml,${encodeURIComponent(qr.toSvg(link()))}`}
                      style={{ display: "block", height: "224px", width: "224px", margin: "8px auto", background: "#fff" }}
                    />
                  </Canvas>
                  <Facts items={[{ label: t().cloudAppCopy, value: link(), copy: link(), mono: true }]} />
                </>
              )}
            </Show>
          </Show>
          <Show when={step() === "code"}>
            <Field name="code" label={t().cloudAppCode} error={wrongCode()} required>
              {/* k2b-ui gap: v2 has no one-time code input (v1 PinInput); a text field takes the six digits. */}
              <Input
                ref={(element) => {
                  codeInput = element;
                }}
                value={code()}
                disabled={busy()}
                onInput={(value) => {
                  setCode(value.replace(/\D/g, "").slice(0, 6));
                  if (value) setWrongCode(undefined);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.isComposing) void confirm();
                }}
              />
            </Field>
          </Show>
        </Match>
        <Match when={step() === "waiting"}>
          <Text>{t().cloudAppWaiting({ name: props.name })}</Text>
          {/* What the person sees now, so the administrator can tell them what to tap. Only the person decides. */}
          <Notice
            tone="note"
            icon="device-mobile"
            title={t().cloudAppDeviceQuestion({ name: props.name })}
            meta={t().cloudAppDevicePreview}
          >
            {t().cloudAppDeviceHint({ administrator: props.administrator })}
          </Notice>
        </Match>
        <Match when={step() === "done"}>
          <Text weight="medium">{t().cloudAppSuccess({ name: status()?.device?.name ?? "" })}</Text>
          <Text muted>{t().cloudAppSuccessHint({ name: props.name })}</Text>
        </Match>
        <Match when={step() === "rejected"}>
          <Text>{t().cloudAppRejected({ name: props.name })}</Text>
        </Match>
        <Match when={step() === "expired"}>
          <Text>{t().cloudAppExpired}</Text>
        </Match>
        <Match when={step() === "locked"}>
          <Text>{t().cloudAppLocked}</Text>
        </Match>
        <Match when={step() === "reauthenticate"}>
          <Text>{t().cloudAppReauthenticate}</Text>
        </Match>
      </Switch>
      <Show when={running()}>
        <Text type="meta" muted>
          {t().cloudAppValid({ time: remaining() })}
        </Text>
      </Show>
      <Show when={connectionError() ?? error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
    </Dialog>
  );

  return { start: () => show(), dialog };
}
