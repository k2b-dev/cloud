import type { GeoIpAdminDatabase, GeoIpAdminStatus, GeoIpKind } from "@k2b/cloud/contracts";
import { announce, Button, prompts, SettingsSection, Tooltip, useLocale } from "@k2b/ui";
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
  | "interrupted"
  | "failed";

/** One fixed status line under the list; every transient state replaces its text in place. */
export type SignInLocationPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "load-error" }
  | { kind: "uploading"; name: string; percent: number }
  | { kind: "checking"; name: string }
  | { kind: "upload-error"; code: ErrorCode; file: File }
  | { kind: "uploaded"; type: GeoIpKind }
  | { kind: "resetting"; type: GeoIpKind }
  | { kind: "reset-error"; type: GeoIpKind }
  | { kind: "reset"; type: GeoIpKind; bundled: boolean };

type Phase<K extends SignInLocationPhase["kind"]> = Extract<SignInLocationPhase, { kind: K }>;
const isPhase = <K extends SignInLocationPhase["kind"]>(value: SignInLocationPhase, kind: K): value is Phase<K> => value.kind === kind;

const API_CODES = ["geoip_too_large", "geoip_invalid", "geoip_unsupported_type", "geoip_empty", "geoip_upload_busy"] as const;
const isApiCode = (value: string): value is (typeof API_CODES)[number] => API_CODES.some((code) => code === value);

const errorCode = (status: number, body: unknown): ErrorCode => {
  const code = typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : "";
  if (isApiCode(code)) return code;
  // A 413 without Cloud's code comes from the platform request cap or a proxy in front of Cloud.
  if (status === 413) return "geoip_request_too_large";
  if (status === 0 || status === 499 || status === 502 || status === 504) return "interrupted";
  return "failed";
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
  const busy = () => ["loading", "uploading", "checking", "resetting"].includes(phase().kind);
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

  const upload = (file: File) => {
    setPhase({ kind: "uploading", name: file.name, percent: 0 });
    const xhr = new XMLHttpRequest();
    request = xhr;
    xhr.open("PUT", API);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("accept", "application/json");
    xhr.upload.onprogress = (event) => {
      if (request !== xhr || !event.lengthComputable) return;
      const percent = Math.min(100, Math.floor((event.loaded / Math.max(1, event.total)) * 100));
      setPhase(percent >= 100 ? { kind: "checking", name: file.name } : { kind: "uploading", name: file.name, percent });
    };
    xhr.upload.onload = () => {
      if (request === xhr) setPhase({ kind: "checking", name: file.name });
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
      setPhase({ kind: "upload-error", code, file });
      announce(errorText(code), { politeness: "assertive" });
    };
    xhr.onerror = () => {
      if (request !== xhr) return;
      request = undefined;
      setPhase({ kind: "upload-error", code: "interrupted", file });
      announce(t().interrupted, { politeness: "assertive" });
    };
    xhr.send(file);
  };

  const cancel = () => {
    const current = request;
    request = undefined;
    current?.abort();
    setPhase({ kind: "idle" });
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
    try {
      const response = await fetch(`${API}/${database.kind}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !isStatus(body)) throw new Error("reset");
      setStatus(body);
      const bundled = body.databases.find((entry) => entry.kind === database.kind)?.source === "bundled";
      setPhase({ kind: "reset", type: database.kind, bundled });
      announce(bundled ? t().resetDoneBundled({ type }) : t().resetDoneEmpty({ type }));
    } catch {
      setPhase({ kind: "reset-error", type: database.kind });
      announce(t().resetFailed, { politeness: "assertive" });
    }
  };

  const errorText = (code: ErrorCode) =>
    ({
      geoip_too_large: t().tooLarge({ size: maxBytes() }),
      geoip_request_too_large: t().requestTooLarge,
      geoip_invalid: t().invalid,
      geoip_unsupported_type: t().unsupported,
      geoip_empty: t().empty,
      geoip_upload_busy: t().busy,
      interrupted: t().interrupted,
      failed: t().failed,
    })[code];

  /** The file itself is the problem: offer another file instead of sending the same one again. */
  const fileProblem = (code: ErrorCode) =>
    code === "geoip_too_large" ||
    code === "geoip_request_too_large" ||
    code === "geoip_invalid" ||
    code === "geoip_unsupported_type" ||
    code === "geoip_empty";

  const sourceLine = (database: GeoIpAdminDatabase) => {
    if (!database.source) return t().none;
    const source = database.source === "uploaded" ? t().uploaded : t().bundled;
    return database.databaseType ? `${source} · ${database.databaseType}` : source;
  };

  const dateLine = (database: GeoIpAdminDatabase): JSX.Element => {
    if (!database.source || !database.buildDate) return database.kind === "city" ? t().noneCity : t().noneAsn;
    return (
      <>
        {t().asOf({ date: date(database.buildDate) })}
        <Show when={database.stale}>
          {" · "}
          <span class="text-warning" data-geoip-stale="">
            <i class="ti ti-clock-exclamation" aria-hidden="true" /> {t().stale}
          </span>
        </Show>
      </>
    );
  };

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
                <span class="text-sm break-words text-secondary" data-geoip-source="">
                  {status() ? sourceLine(database) : phase().kind === "loading" ? t().loadingStatus : t().unknown}
                </span>
                <span class="text-xs text-dimmed" data-geoip-date="">
                  {phase().kind === "loading" && !status() ? " " : dateLine(database)}
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

      <div class="flex min-h-10 min-w-0 items-center gap-3 text-sm" data-geoip-status="" role="status">
        <Switch>
          <Match when={!online()}>
            <StatusText icon="ti ti-wifi-off" tone="text-secondary">
              {t().offline}
            </StatusText>
          </Match>
          <Match when={phase().kind === "loading"}>
            <StatusText icon="ti ti-loader-2 animate-spin" tone="text-secondary">
              {t().loadingStatus}
            </StatusText>
          </Match>
          <Match when={phase().kind === "load-error"}>
            <StatusText icon="ti ti-alert-triangle" tone="text-danger">
              {t().loadFailed}
            </StatusText>
            <Button type="button" variant="secondary" size="sm" onClick={() => void load()}>
              {t().retry}
            </Button>
          </Match>
          <Match when={current("uploading")}>
            {(current) => (
              <>
                <StatusText icon="ti ti-upload" tone="text-primary">
                  <span class="tabular-nums">{t().progress({ name: current().name, percent: String(current().percent) })}</span>
                </StatusText>
                <Button type="button" variant="ghost" size="sm" onClick={cancel}>
                  {t().cancel}
                </Button>
              </>
            )}
          </Match>
          <Match when={current("checking")}>
            {(current) => (
              <StatusText icon="ti ti-loader-2 animate-spin" tone="text-primary">
                {t().checking({ name: current().name })}
              </StatusText>
            )}
          </Match>
          <Match when={current("upload-error")}>
            {(current) => (
              <>
                <StatusText icon="ti ti-alert-triangle" tone="text-danger">
                  {errorText(current().code)}
                </StatusText>
                <Show
                  when={fileProblem(current().code)}
                  fallback={
                    <Button type="button" variant="secondary" size="sm" onClick={() => upload(current().file)}>
                      {t().retry}
                    </Button>
                  }
                >
                  <Button type="button" variant="secondary" size="sm" onClick={choose}>
                    {t().chooseAnother}
                  </Button>
                </Show>
              </>
            )}
          </Match>
          <Match when={current("uploaded")}>
            {(current) => (
              <StatusText icon="ti ti-circle-check" tone="text-success">
                {current().type === "city" ? t().uploadedCity : t().uploadedAsn}
              </StatusText>
            )}
          </Match>
          <Match when={phase().kind === "resetting"}>
            <StatusText icon="ti ti-loader-2 animate-spin" tone="text-secondary">
              {t().resetting}
            </StatusText>
          </Match>
          <Match when={current("reset-error")}>
            {(current) => (
              <>
                <StatusText icon="ti ti-alert-triangle" tone="text-danger">
                  {t().resetFailed}
                </StatusText>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    const database = status()?.databases.find((entry) => entry.kind === current().type);
                    if (database) void reset(database);
                  }}
                >
                  {t().retry}
                </Button>
              </>
            )}
          </Match>
          <Match when={current("reset")}>
            {(current) => (
              <StatusText icon="ti ti-circle-check" tone="text-success">
                {current().bundled
                  ? t().resetDoneBundled({ type: typeName(current().type) })
                  : t().resetDoneEmpty({ type: typeName(current().type) })}
              </StatusText>
            )}
          </Match>
          <Match when={true}>
            <StatusText icon={anyStale() ? "ti ti-clock-exclamation" : "ti ti-info-circle"} tone="text-dimmed">
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

function StatusText(props: { icon: string; tone: string; children: JSX.Element }) {
  return (
    <span class={`flex min-w-0 flex-1 items-start gap-2 ${props.tone}`}>
      <i class={`${props.icon} mt-0.5 shrink-0`} aria-hidden="true" />
      <span class="min-w-0 line-clamp-2">{props.children}</span>
    </span>
  );
}
