import { PWA_LIMITS, PWA_SCOPE, PwaClaimResultSchema, PwaCompleteResultSchema, parsePairingLink } from "@k2b/cloud/contracts";
import { clipboard } from "@k2b/stdlib/solid";
import {
  Button,
  createInstallPrompt,
  dialogCore,
  type InstallationPlatform,
  InstallGuide,
  type InstallPrompt,
  PanelDialog,
  QrScanner,
  type QrScannerError,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { shellMessages } from "../../messages";
import { isStandalone, type PhoneAnswer, phoneAuth, phonePlatform, watchPairingLink } from "../phone";

export type WelcomeProps = {
  /** How the person got here: a new phone, a signed-out one, or an expired code. */
  state: "new" | "ended" | "expired";
  cloud: string;
  /** The app icon of the installation. */
  icon: string;
  /** The app's absolute address, which a browser inside another app copies and Samsung Internet opens in Chrome. */
  url: string;
  /** The platform as the server read it from the user agent, so the installation steps render with the page. */
  platform: InstallationPlatform;
};

type Waiting = { code: string; account: string };
type ScanResult = { link: string } | { error: QrScannerError };

const PASTE_FIELD = "pwa-pairing-link";

/** The server's view until the browser's own installation state takes over after mount. */
const renderedPrompt = (platform: InstallationPlatform): InstallPrompt => ({
  platform,
  installed: () => false,
  canPrompt: () => false,
  busy: () => false,
  requested: () => false,
  failed: () => false,
  install: async () => {},
});

/** "482913" reads as "482 913". */
const groupedCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/**
 * The welcome page of a phone without an app session. Installed, it pairs: scan the code or paste the link from the
 * web, then show the code the person types on the web, and finish once they did. In the browser, it explains how to
 * install the app. CSS picks the block, so the layout does not depend on JavaScript.
 */
export default function Welcome(props: WelcomeProps) {
  const locale = useLocale();
  const t = () => shellMessages.resolve([locale()]).t;
  const [text, setText] = createSignal("");
  const [message, setMessage] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [confirmation, setConfirmation] = createSignal<{ account: string; administrator: string; token: string }>();
  const [rejected, setRejected] = createSignal(false);
  const [waiting, setWaiting] = createSignal<Waiting>();
  /** A pairing link opened in the browser, kept in memory to copy into the installed app. */
  const [link, setLink] = createSignal<string>();
  const [install, setInstall] = createSignal(renderedPrompt(props.platform));
  const copy = clipboard.createWriter({ write: (value: string) => navigator.clipboard.writeText(value) });
  /** A browser inside another app: the installation guide copies the link itself. */
  const embedded = () => install().platform === "in-app" || install().platform === "apple-in-app";

  const failure = (answer: PhoneAnswer): string => {
    if (answer.status === 0) return t().offline;
    switch (answer.code) {
      case "EXPIRED":
        return t().expired;
      case "ALREADY_USED":
        return t().alreadyUsed;
      case "INVALID_REQUEST":
        return t().invalidLink;
      case "ALREADY_PAIRED":
        return t().alreadyPaired;
      case "ACCOUNT_MISMATCH":
        return t().accountMismatch({ cloud: props.cloud });
      case "LIMIT_REACHED":
        return t().limitReached;
      case "UNAVAILABLE":
        return t().unreachable({ cloud: props.cloud });
      default:
        return t().failed;
    }
  };

  // Pairing requests go out one after another. A completion answered "expired" deletes the pairing cookie, so it must
  // never arrive after a claim that has just set a new one.
  let queue: Promise<unknown> = Promise.resolve();
  const inOrder = (send: () => Promise<PhoneAnswer>): Promise<PhoneAnswer> => {
    const answer = queue.then(send);
    queue = answer;
    return answer;
  };

  // ── Waiting for the person to type the code on the web ──────────────
  let polling = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopPolling = () => {
    polling = false;
    clearTimeout(timer);
  };
  const schedule = () => {
    clearTimeout(timer);
    if (polling) timer = setTimeout(() => void poll(), PWA_LIMITS.pollSeconds * 1000);
  };
  const poll = async () => {
    if (!polling || inFlight || document.visibilityState !== "visible") return;
    inFlight = true;
    const answer = await inOrder(phoneAuth.complete);
    inFlight = false;
    if (!polling) return;
    if (readCompletion(answer)) return;
    if (answer.status === 410) return location.replace(`${PWA_SCOPE}?pwa=expired`);
    if (answer.code === "ACCOUNT_BLOCKED") return location.replace(`${PWA_SCOPE}?pwa=blocked`);
    if (["ALREADY_PAIRED", "ACCOUNT_MISMATCH", "LIMIT_REACHED"].includes(answer.code ?? "")) {
      stopPolling();
      setMessage(failure(answer));
      return;
    }
    // 202, Cloud unreachable or busy: ask again later.
    schedule();
  };
  const readCompletion = (answer: PhoneAnswer): boolean => {
    const parsed = PwaCompleteResultSchema.safeParse(answer.body);
    if (!parsed.success) return false;
    if (parsed.data.state === "paired") {
      location.replace(PWA_SCOPE);
      return true;
    }
    if (parsed.data.state === "rejected") {
      stopPolling();
      setConfirmation(undefined);
      setWaiting(undefined);
      setRejected(true);
      return true;
    }
    if (parsed.data.state === "confirmation_required") {
      stopPolling();
      setMessage(undefined);
      setConfirmation({
        account: parsed.data.account.name,
        administrator: parsed.data.administrator.name,
        token: parsed.data.confirmationToken,
      });
      queueMicrotask(() => document.getElementById("pwa-device-confirmation")?.focus());
      return true;
    }
    return false;
  };
  const decide = async (decision: "confirm" | "reject") => {
    const current = confirmation();
    if (!current || busy()) return;
    setBusy(true);
    setMessage(undefined);
    const answer = await inOrder(() => phoneAuth.decide(current.token, decision));
    if (answer.status === 204) {
      if (decision === "reject") {
        setConfirmation(undefined);
        setWaiting(undefined);
        setRejected(true);
      } else {
        const completed = await inOrder(phoneAuth.complete);
        if (!readCompletion(completed)) {
          setConfirmation(undefined);
          setMessage(failure(completed));
          polling = true;
          schedule();
        }
      }
    } else if (answer.code === "FORBIDDEN" || answer.code === "CONFLICT") {
      // The pairing changed since this prompt: a newer prompt replaced its token, the administrator cancelled, or
      // another window decided. Its current state decides; a fresh prompt needs its own decision.
      const completed = await inOrder(phoneAuth.complete);
      if (!readCompletion(completed)) {
        setConfirmation(undefined);
        setWaiting(undefined);
        setMessage(failure(completed));
      }
    } else if (answer.status !== 0 && answer.status < 500) {
      // Expired or no longer allowed: this pairing cannot finish, so the person starts again with a new code.
      setConfirmation(undefined);
      setWaiting(undefined);
      setMessage(failure(answer));
    } else setMessage(failure(answer));
    setBusy(false);
  };
  const wait = (value: Waiting) => {
    setMessage(undefined);
    setWaiting(value);
    polling = true;
    schedule();
  };
  const useAnotherCode = () => {
    stopPolling();
    setWaiting(undefined);
    setConfirmation(undefined);
    setRejected(false);
    setMessage(undefined);
  };

  // ── Pairing ─────────────────────────────────────────────────────────
  const claim = async (value: string): Promise<void> => {
    const parsed = parsePairingLink(value, location.origin);
    if (!parsed.ok) {
      setMessage(
        parsed.reason === "other-cloud" ? t().otherCloudLink : parsed.reason === "cloud-login" ? t().cloudLoginLink : t().invalidLink,
      );
      return;
    }
    stopPolling();
    setConfirmation(undefined);
    setRejected(false);
    setBusy(true);
    setMessage(undefined);
    const answer = await inOrder(() => phoneAuth.claim(parsed.secret, phonePlatform()));
    setBusy(false);
    const claimed = answer.status === 200 ? PwaClaimResultSchema.safeParse(answer.body) : undefined;
    if (claimed?.success) {
      setText("");
      wait({ code: claimed.data.code, account: claimed.data.account.name });
    } else setMessage(failure(answer));
  };

  const scan = async () => {
    const result = await dialogCore.open<ScanResult>(
      (close) => (
        <PanelDialog>
          <PanelDialog.Header title={t().scanCode} close={() => close()} closeLabel={t().closeScanner} />
          <PanelDialog.Body>
            <QrScanner
              instructions={t().scanInstructions}
              onResult={(value) => {
                if (!parsePairingLink(value, location.origin).ok) return false;
                close({ link: value });
                return true;
              }}
              onStop={() => close()}
              onError={(reason) => close({ error: reason })}
            />
          </PanelDialog.Body>
        </PanelDialog>
      ),
      // Back closes the scanner and stops the camera instead of leaving the page.
      { panelClassName: "k2b-dialog k2b-dialog--full", contentClassName: "k2b-dialog__viewport", ariaLabel: t().scanCode, history: true },
    );
    if (!result) return;
    if ("link" in result) return void claim(result.link);
    const messages = t();
    setMessage(
      {
        denied: messages.cameraDenied,
        "no-camera": messages.cameraMissing,
        "in-use": messages.cameraInUse,
        unavailable: messages.cameraUnavailable,
      }[result.error],
    );
    document.getElementById(PASTE_FIELD)?.focus();
  };

  onMount(() => {
    const standalone = isStandalone();
    let linked = false;
    // Read the fragment first: the link must leave the address before anything else runs.
    onCleanup(
      watchPairingLink((value) => {
        if (!standalone) return setLink(value);
        linked = true;
        void claim(value);
      }),
    );
    const prompt = createInstallPrompt();
    setInstall(prompt);
    const visible = () => {
      if (document.visibilityState === "visible" && polling) {
        clearTimeout(timer);
        void poll();
      }
    };
    document.addEventListener("visibilitychange", visible);
    onCleanup(() => {
      stopPolling();
      document.removeEventListener("visibilitychange", visible);
    });
    // A pairing may still be running after the app was closed. A link that opened the app starts a new one instead.
    if (!standalone || linked) return;
    void (async () => {
      const answer = await inOrder(phoneAuth.complete);
      if (readCompletion(answer)) return;
      const pending = answer.status === 202 ? PwaCompleteResultSchema.safeParse(answer.body) : undefined;
      if (pending?.success && pending.data.state === "waiting" && !waiting() && !busy()) {
        wait({ code: pending.data.code, account: pending.data.account.name });
      }
    })();
  });

  const status = () => (
    <Show when={message()}>
      <p class="pwa-welcome__message" role="alert">
        {message()}
      </p>
    </Show>
  );

  const pairingContent = () => (
    <Show
      when={waiting()}
      fallback={
        <div class="pwa-welcome__block">
          <h2>{t().connect({ cloud: props.cloud })}</h2>
          <p class="pwa-welcome__lead">{props.state === "ended" ? t().ended : props.state === "expired" ? t().expired : t().connectLead}</p>
          <Button class="pwa-welcome__primary" disabled={busy()} onClick={() => void scan()}>
            <i class="ti ti-qrcode" aria-hidden="true" />
            {t().scanCode}
          </Button>
          <form
            class="pwa-welcome__paste"
            onSubmit={(event) => {
              event.preventDefault();
              if (text().trim()) void claim(text());
            }}
          >
            <TextInput
              id={PASTE_FIELD}
              icon="ti ti-link"
              label={t().pasteLink}
              value={text}
              onValueChange={(value) => {
                setText(value);
                setMessage(undefined);
              }}
              maxLength={PWA_LIMITS.bodyBytes}
              autocomplete="off"
              spellcheck={false}
              disabled={busy()}
            />
            <Button type="submit" variant="secondary" loading={busy()} disabled={!text().trim()}>
              {t().continue}
            </Button>
          </form>
          {status()}
          <p class="pwa-welcome__hint">{t().pairingHint}</p>
        </div>
      }
    >
      {(pending) => (
        <div class="pwa-welcome__block">
          <h2>{t().connectingAs({ cloud: props.cloud, account: pending().account })}</h2>
          <output class="pwa-welcome__code" aria-label={t().codeLabel}>
            {groupedCode(pending().code)}
          </output>
          <p class="pwa-welcome__lead">{t().enterCode}</p>
          {status()}
          <Button variant="secondary" onClick={useAnotherCode}>
            {t().useAnotherCode}
          </Button>
        </div>
      )}
    </Show>
  );

  return (
    <div class="pwa-welcome">
      <img class="pwa-welcome__icon" src={props.icon} alt="" width="72" height="72" />
      <div class="pwa-standalone-only">
        <Show
          when={confirmation()}
          fallback={
            <Show when={rejected()} fallback={pairingContent()}>
              <div class="pwa-welcome__block">
                <p role="status">{t().adminRejected}</p>
                <Button variant="secondary" onClick={useAnotherCode}>
                  {t().useAnotherCode}
                </Button>
              </div>
            </Show>
          }
        >
          {(current) => (
            <div class="pwa-welcome__block" aria-labelledby="pwa-device-confirmation">
              <h2 id="pwa-device-confirmation" tabindex="-1">
                {t().adminConfirmTitle({ name: current().account })}
              </h2>
              <p class="pwa-welcome__lead">{t().adminConfirmBody({ name: current().administrator })}</p>
              {status()}
              <Button loading={busy()} onClick={() => void decide("confirm")}>
                {t().adminConfirm}
              </Button>
              <Button variant="secondary" disabled={busy()} onClick={() => void decide("reject")}>
                {t().adminReject}
              </Button>
            </div>
          )}
        </Show>
      </div>
      <div class="pwa-browser-only">
        <div class="pwa-welcome__block">
          <h2>{t().install}</h2>
          <p class="pwa-welcome__lead">{t().installLead({ cloud: props.cloud })}</p>
          <Show when={!embedded() && link()}>
            {(value) => (
              <>
                <p>{t().installFirst}</p>
                <Button variant="secondary" onClick={() => void copy.copy(value())}>
                  <i class={copy.wasCopied() ? "ti ti-check" : "ti ti-copy"} aria-hidden="true" />
                  {copy.wasCopied() ? t().linkCopied : t().copyLink}
                </Button>
                <Show when={copy.error()}>
                  <p role="alert">{t().copyFailed}</p>
                </Show>
              </>
            )}
          </Show>
          <Show
            when={props.platform !== "generic" && props.platform !== "apple-desktop"}
            fallback={
              <>
                <Show when={props.platform === "apple-desktop"}>
                  <div class="pwa-coarse-only">
                    <InstallGuide appName={props.cloud} install={renderedPrompt("apple-mobile")} url={link() ?? props.url} />
                  </div>
                </Show>
                <p class={props.platform === "apple-desktop" ? "pwa-fine-only" : undefined}>{t().phonesOnly({ cloud: props.cloud })}</p>
              </>
            }
          >
            {/* Inside another app, the guide's one copy action takes the pairing link along to Safari or Chrome. If
                copying fails, the guide shows the link to copy by hand: the app around the page already opened it, and
                it pairs only once the code it yields is typed on the web. */}
            <InstallGuide appName={props.cloud} install={install()} url={link() ?? props.url} />
          </Show>
          <p class="pwa-welcome__hint">{t().alreadyInstalled}</p>
        </div>
      </div>
    </div>
  );
}
