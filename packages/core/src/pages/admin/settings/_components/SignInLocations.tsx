import type { GeoIpAdminDatabase, GeoIpAdminStatus, GeoIpKind } from "@k2b/cloud/contracts";
import { announce, Button, InlineGuidance, prompts, SettingsSection, Tooltip, useLocale } from "@k2b/ui";
import { createSignal, For, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { signInLocationMessages } from "./sign-in-location-messages";

const API = "/api/admin/core/geoip";

type ErrorCode =
  | "geoip_too_large"
  | "geoip_request_too_large"
  | "geoip_invalid"
  | "geoip_unsupported_type"
  | "geoip_empty"
  | "geoip_upload_busy"
  | "not_allowed"
  | "refused";

/** One fixed status line under the list; every transient state replaces its text in place. */
export type SignInLocationPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "load-error" }
  | { kind: "uploading"; percent: number }
  | { kind: "checking" }
  | { kind: "upload-error"; code: ErrorCode; file: File }
  | { kind: "uploaded"; type: GeoIpKind }
  | { kind: "resetting"; type: GeoIpKind }
  | { kind: "reset-error"; type: GeoIpKind; code?: "not_allowed" | "refused" }
  | { kind: "reset"; type: GeoIpKind; bundled: boolean }
  /** After a write without a clear answer, the block reads what is active before it allows another change. */
  | { kind: "reconciling" }
  | { kind: "unknown-outcome" };

type Phase<K extends SignInLocationPhase["kind"]> = Extract<SignInLocationPhase, { kind: K }>;
const isPhase = <K extends SignInLocationPhase["kind"]>(value: SignInLocationPhase, kind: K): value is Phase<K> => value.kind === kind;

const API_CODES = ["geoip_too_large", "geoip_invalid", "geoip_unsupported_type", "geoip_empty", "geoip_upload_busy"] as const;
const isApiCode = (value: string): value is (typeof API_CODES)[number] => API_CODES.some((code) => code === value);

/** A definite refusal changed nothing; anything else (lost answer, server error) leaves the outcome open. */
const errorCode = (status: number, body: unknown): ErrorCode | "ambiguous" => {
  const code = typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : "";
  if (isApiCode(code)) return code;
  // A 413 without Cloud's code comes from the platform request cap or a proxy in front of Cloud.
  if (status === 413) return "geoip_request_too_large";
  // An expired session or a removed admin role: nothing was saved, and signing in again is the way out.
  if (status === 401 || status === 403) return "not_allowed";
  // Any other client error is a definite refusal; a timeout (408, 499) or server error may hide a commit.
  if (status >= 400 && status < 500 && status !== 408 && status !== 499) return "refused";
  return "ambiguous";
};

const isStatus = (value: unknown): value is GeoIpAdminStatus =>
  typeof value === "object" && value !== null && "databases" in value && Array.isArray(value.databases) && value.databases.length === 2;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const formatBytes = (bytes: number, locale: string) =>
  `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(bytes / 1024 / 1024)} MiB`;

export default function SignInLocations(props: {
  initial: GeoIpAdminStatus | null;
  /** Test seam: the starting phase, for render tests of transient states. */
  initialPhase?: SignInLocationPhase;
}): JSX.Element {
  const locale = useLocale();
  const t = () => signInLocationMessages.resolve([locale()]).t;
  const [status, setStatus] = createSignal<GeoIpAdminStatus | null>(props.initial);
  const [phase, setPhase] = createSignal<SignInLocationPhase>(
    props.initialPhase ?? (props.initial ? { kind: "idle" } : { kind: "load-error" }),
  );
  // SSR and the first client frame both render as online; the browser corrects it after hydration.
  const [online, setOnline] = createSignal(true);
  let input: HTMLInputElement | undefined;
  let request: XMLHttpRequest | undefined;

  onMount(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    onCleanup(() => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
      request?.abort();
    });
  });

  const date = (value: string) => new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
  const typeName = (type: GeoIpKind) => (type === "city" ? t().city : t().asn);
  const current = <K extends SignInLocationPhase["kind"]>(kind: K): Phase<K> | false => {
    const value = phase();
    return isPhase(value, kind) ? value : false;
  };
  const busy = () => ["loading", "uploading", "checking", "resetting", "reconciling"].includes(phase().kind);
  const actionsDisabled = () => busy() || !online() || !status();
  const anyStale = () => status()?.databases.some((database) => database.stale) ?? false;
  const maxBytes = () => formatBytes(status()?.limits.maxDatabaseBytes ?? 192 * 1024 * 1024, locale());

  const load = async () => {
    setPhase({ kind: "loading" });
    try {
      const response = await fetch(API, { credentials: "same-origin", headers: { accept: "application/json" } });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !isStatus(body)) throw new Error("status");
      setStatus(body);
      setPhase({ kind: "idle" });
    } catch {
      setPhase({ kind: "load-error" });
    }
  };

  /** Reads the active databases after a write whose outcome is unknown; null when Cloud cannot be reached. */
  const reconcile = async (): Promise<GeoIpAdminStatus | null> => {
    setPhase({ kind: "reconciling" });
    try {
      const response = await fetch(API, { credentials: "same-origin", headers: { accept: "application/json" } });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !isStatus(body)) return null;
      setStatus(body);
      return body;
    } catch {
      return null;
    }
  };

  const unknownOutcome = () => {
    setPhase({ kind: "unknown-outcome" });
    announce(t().unknownOutcome, { politeness: "assertive" });
  };

  /**
   * A lost answer or a server error leaves the upload's outcome open. A changed checksum proves it landed; an
   * unchanged one leaves the outcome unclear unless the request was cancelled.
   */
  const settleUpload = async (before: GeoIpAdminStatus | null, cancelled = false) => {
    const after = await reconcile();
    if (!after) return unknownOutcome();
    const changed = after.databases.find(
      (database, index) => database.upload?.sha256 !== before?.databases[index]?.upload?.sha256 && database.source === "uploaded",
    );
    if (changed) {
      setPhase({ kind: "uploaded", type: changed.kind });
      announce(changed.kind === "city" ? t().uploadedCity : t().uploadedAsn);
      return;
    }
    // After cancellation, an unchanged list is enough: the server does not commit after the abort.
    if (cancelled) return void setPhase({ kind: "idle" });
    unknownOutcome();
  };

  const upload = (file: File) => {
    const before = status();
    setPhase({ kind: "uploading", percent: 0 });
    const xhr = new XMLHttpRequest();
    request = xhr;
    xhr.open("PUT", API);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("accept", "application/json");
    xhr.upload.onprogress = (event) => {
      if (request !== xhr || !event.lengthComputable) return;
      const percent = Math.min(100, Math.floor((event.loaded / Math.max(1, event.total)) * 100));
      setPhase(percent >= 100 ? { kind: "checking" } : { kind: "uploading", percent });
    };
    xhr.upload.onload = () => {
      if (request === xhr) setPhase({ kind: "checking" });
    };
    xhr.onload = () => {
      if (request !== xhr) return;
      request = undefined;
      const body = parseJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300 && isStatus(body) && "kind" in body && (body.kind === "city" || body.kind === "asn")) {
        setStatus(body);
        setPhase({ kind: "uploaded", type: body.kind });
        announce(body.kind === "city" ? t().uploadedCity : t().uploadedAsn);
        return;
      }
      const code = errorCode(xhr.status, body);
      if (code === "ambiguous") return void settleUpload(before);
      setPhase({ kind: "upload-error", code, file });
      announce(errorText(code), { politeness: "assertive" });
    };
    xhr.onerror = () => {
      if (request !== xhr) return;
      request = undefined;
      void settleUpload(before);
    };
    xhr.send(file);
  };

  const cancel = () => {
    const before = status();
    const current = request;
    request = undefined;
    current?.abort();
    void settleUpload(before, true);
  };

  const choose = () => {
    if (!input) return;
    input.value = "";
    input.click();
  };

  const reset = async (database: GeoIpAdminDatabase) => {
    const type = typeName(database.kind);
    const confirmed = await prompts.confirm(database.bundled ? t().resetBody : t().resetBodyNoSnapshot, {
      title: t().resetTitle({ type }),
      icon: "ti ti-restore",
      variant: "danger",
      confirmText: t().reset,
    });
    if (!confirmed) return;
    setPhase({ kind: "resetting", type: database.kind });
    const done = (next: GeoIpAdminStatus) => {
      const bundled = next.databases.find((entry) => entry.kind === database.kind)?.source === "bundled";
      setPhase({ kind: "reset", type: database.kind, bundled });
      announce(bundled ? t().resetDoneBundled({ type }) : t().resetDoneEmpty({ type }));
    };
    let refusal: "not_allowed" | "refused" | undefined;
    try {
      const response = await fetch(`${API}/${database.kind}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isStatus(body)) {
        setStatus(body);
        return done(body);
      }
      // A client error is a definite refusal; a gateway or server error may hide a committed delete.
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 499)
        refusal = response.status === 401 || response.status === 403 ? "not_allowed" : "refused";
    } catch {}
    if (refusal) {
      setPhase({ kind: "reset-error", type: database.kind, code: refusal });
      announce(refusal === "not_allowed" ? t().notAllowed : t().resetFailed, { politeness: "assertive" });
      return;
    }
    // Only a vanished upload proves the delete landed; an unchanged row may still be deleted by the open request.
    const after = await reconcile();
    if (after && after.databases.find((entry) => entry.kind === database.kind)?.source !== "uploaded") return done(after);
    unknownOutcome();
  };

  const errorText = (code: ErrorCode) =>
    ({
      geoip_too_large: t().tooLarge({ size: maxBytes() }),
      geoip_request_too_large: t().requestTooLarge,
      geoip_invalid: t().invalid,
      geoip_unsupported_type: t().unsupported,
      geoip_empty: t().empty,
      geoip_upload_busy: t().busy,
      not_allowed: t().notAllowed,
      refused: t().refused,
    })[code];

  const sourceLine = (database: GeoIpAdminDatabase) => {
    if (!status()) return phase().kind === "loading" ? t().loadingStatus : t().unknown;
    if (!database.source) return t().none;
    return database.source === "uploaded" ? t().uploaded : t().bundled;
  };

  /** Date first, then the stale hint, then the database type: on a phone the line cuts the type, never the date. */
  const detailLine = (database: GeoIpAdminDatabase): JSX.Element => {
    if (!status()) return "\u00a0";
    if (!database.source || !database.buildDate) return database.kind === "city" ? t().noneCity : t().noneAsn;
    return (
      <>
        {t().asOf({ date: date(database.buildDate) })}
        <Show when={database.stale}>
          {" · "}
          <span class="text-[var(--k2b-warning-text)]" data-geoip-stale="">
            <i class="ti ti-clock-exclamation" aria-hidden="true" /> {t().stale}
          </span>
        </Show>
        <Show when={database.databaseType}>{(type) => ` · ${type()}`}</Show>
      </>
    );
  };
  const detailTitle = (database: GeoIpAdminDatabase) =>
    status() && database.source && database.buildDate
      ? [t().asOf({ date: date(database.buildDate) }), database.stale ? t().stale : null, database.databaseType].filter(Boolean).join(" · ")
      : undefined;

  const placeholderDatabase = (kind: GeoIpKind): GeoIpAdminDatabase => ({
    kind,
    source: null,
    bundled: false,
    databaseType: null,
    buildDate: null,
    stale: false,
    dbIp: false,
    upload: null,
  });
  const databases = () => status()?.databases ?? [placeholderDatabase("city"), placeholderDatabase("asn")];

  return (
    <SettingsSection
      title={t().title}
      subtitle={t().subtitle}
      icon="ti ti-map-pin"
      actions={
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={choose}
          disabled={actionsDisabled()}
          loading={phase().kind === "uploading" || phase().kind === "checking"}
          loadingLabel={t().uploading}
          data-geoip-upload=""
        >
          <i class="ti ti-upload" aria-hidden="true" /> {t().upload}
        </Button>
      }
    >
      <input
        ref={input}
        type="file"
        class="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        accept=".mmdb,.gz,application/gzip,application/octet-stream"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) upload(file);
        }}
      />
      <ul class="flex flex-col gap-4" data-geoip-databases="">
        <For each={databases()}>
          {(database) => (
            <li class="flex min-w-0 items-start gap-3" data-geoip-kind={database.kind}>
              <i
                class={`${database.kind === "city" ? "ti ti-map-pin" : "ti ti-network"} mt-0.5 text-base text-dimmed`}
                aria-hidden="true"
              />
              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-sm font-medium text-primary">{typeName(database.kind)}</span>
                <span class="truncate text-sm text-secondary" data-geoip-source="">
                  {sourceLine(database)}
                </span>
                <span class="truncate text-xs text-dimmed" data-geoip-date="" title={detailTitle(database)}>
                  {detailLine(database)}
                </span>
              </div>
              <Tooltip.Anchor
                content={database.source === "uploaded" ? t().resetLabel({ type: typeName(database.kind) }) : t().resetUnavailable}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void reset(database)}
                  disabled={actionsDisabled() || database.source !== "uploaded"}
                  loading={(current("resetting") || undefined)?.type === database.kind}
                  loadingLabel={t().resetting}
                  aria-label={t().resetLabel({ type: typeName(database.kind) })}
                >
                  <i class="ti ti-restore" aria-hidden="true" /> <span class="max-sm:sr-only">{t().reset}</span>
                </Button>
              </Tooltip.Anchor>
            </li>
          )}
        </For>
      </ul>

      {/* Reserved for the longest message: two lines beside an action, three on a phone. */}
      <div class="flex min-h-10 min-w-0 items-center gap-3 max-sm:min-h-15" data-geoip-status="" role="status">
        <Switch>
          <Match when={!online()}>
            <StatusText icon="ti ti-wifi-off">{t().offline}</StatusText>
          </Match>
          <Match when={current("loading")}>
            <StatusText loading>{t().loadingStatus}</StatusText>
          </Match>
          <Match when={current("load-error")}>
            <StatusText tone="danger" icon="ti ti-alert-triangle">
              {t().loadFailed}
            </StatusText>
            <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
              {t().retry}
            </Button>
          </Match>
          <Match when={current("uploading")}>
            {(upload) => (
              <>
                <StatusText tone="info" icon="ti ti-upload">
                  <span class="tabular-nums">{t().progress({ percent: String(upload().percent) })}</span>
                </StatusText>
                <Button type="button" variant="ghost" size="sm" onClick={cancel}>
                  {t().cancel}
                </Button>
              </>
            )}
          </Match>
          <Match when={current("checking")}>
            <StatusText tone="info" loading>
              {t().checking}
            </StatusText>
          </Match>
          <Match when={current("upload-error")}>
            {(failure) => (
              <>
                <StatusText tone="danger" icon="ti ti-alert-triangle">
                  {errorText(failure().code)}
                </StatusText>
                {/* A file problem is fixed with another file, through the Upload action above; only a busy server gets the same file again. */}
                <Show when={failure().code === "geoip_upload_busy"}>
                  <Button type="button" variant="secondary" size="sm" onClick={() => upload(failure().file)}>
                    {t().retry}
                  </Button>
                </Show>
              </>
            )}
          </Match>
          <Match when={current("uploaded")}>
            {(done) => (
              <StatusText tone="success" icon="ti ti-circle-check">
                {done().type === "city" ? t().uploadedCity : t().uploadedAsn}
              </StatusText>
            )}
          </Match>
          <Match when={current("reconciling")}>
            <StatusText loading>{t().reconciling}</StatusText>
          </Match>
          <Match when={current("unknown-outcome")}>
            <StatusText tone="danger" icon="ti ti-alert-triangle">
              {t().unknownOutcome}
            </StatusText>
            <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
              {t().loadStatus}
            </Button>
          </Match>
          <Match when={current("resetting")}>
            <StatusText loading>{t().resetting}</StatusText>
          </Match>
          <Match when={current("reset-error")}>
            {(failure) => (
              <>
                <StatusText tone="danger" icon="ti ti-alert-triangle">
                  {failure().code === "not_allowed" ? t().notAllowed : t().resetFailed}
                </StatusText>
                <Show when={failure().code !== "not_allowed"}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const database = status()?.databases.find((entry) => entry.kind === failure().type);
                      if (database) void reset(database);
                    }}
                  >
                    {t().retry}
                  </Button>
                </Show>
              </>
            )}
          </Match>
          <Match when={current("reset")}>
            {(done) => (
              <StatusText tone="success" icon="ti ti-circle-check">
                {done().bundled
                  ? t().resetDoneBundled({ type: typeName(done().type) })
                  : t().resetDoneEmpty({ type: typeName(done().type) })}
              </StatusText>
            )}
          </Match>
          <Match when={true}>
            <StatusText icon={anyStale() ? "ti ti-clock-exclamation" : "ti ti-info-circle"}>
              {anyStale() ? t().staleAdvice : t().formatHint({ size: maxBytes() })}
            </StatusText>
          </Match>
        </Switch>
      </div>

      <Show when={status()?.attribution}>
        {(attribution) => (
          <p class="text-xs text-dimmed" data-geoip-attribution="">
            {t().attribution}{" "}
            <a class="underline underline-offset-2 hover:text-primary" href={attribution().url} target="_blank" rel="noopener">
              {attribution().text}
            </a>{" "}
            (
            <a class="underline underline-offset-2 hover:text-primary" href={attribution().licenseUrl} target="_blank" rel="noopener">
              {attribution().license}
            </a>
            )
          </p>
        )}
      </Show>
    </SettingsSection>
  );
}

function StatusText(props: { icon?: string; tone?: "info" | "success" | "danger"; loading?: boolean; children: JSX.Element }) {
  return (
    <InlineGuidance class="flex-1" tone={props.tone} icon={props.icon} loading={props.loading}>
      <span class="line-clamp-2 max-sm:line-clamp-3">{props.children}</span>
    </InlineGuidance>
  );
}
