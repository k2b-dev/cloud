import type { GeoIpAdminDatabase, GeoIpAdminStatus, GeoIpKind } from "@k2b/cloud/contracts";
import { files } from "@k2b/stdlib/browser";
import { announce, useLocale } from "@k2b/ui";
import { Chip, Dialog, Row, Section, Text, type TwoActions } from "@k2b/ui/v2";
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { signInLocationMessages } from "../settings/_components/sign-in-location-messages";

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
  /** The source after the reset: another administrator's upload may already have replaced it. */
  | { kind: "reset"; type: GeoIpKind; source: GeoIpAdminDatabase["source"] }
  /** After a write without a clear answer, the block reads what is active before it allows another change. */
  | { kind: "reconciling" }
  | { kind: "unknown-outcome" };

type Phase<K extends SignInLocationPhase["kind"]> = Extract<SignInLocationPhase, { kind: K }>;
const isPhase = <K extends SignInLocationPhase["kind"]>(value: SignInLocationPhase, kind: K): value is Phase<K> => value.kind === kind;

const API_CODES = [
  "geoip_request_too_large",
  "geoip_too_large",
  "geoip_invalid",
  "geoip_unsupported_type",
  "geoip_empty",
  "geoip_upload_busy",
] as const;
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

/**
 * The unpacked size Cloud stores for this file: its own size, or the size trailer of a gzip file (exact below 4 GiB
 * for one gzip member). Null when the browser cannot read the file.
 */
const unpackedSize = async (file: File): Promise<number | null> => {
  try {
    const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    if (head[0] !== 0x1f || head[1] !== 0x8b) return file.size;
    if (file.size < 18) return null;
    return new DataView(await file.slice(file.size - 4).arrayBuffer()).getUint32(0, true);
  } catch {
    return null;
  }
};

const formatBytes = (bytes: number, locale: string) =>
  `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(bytes / 1024 / 1024)} MiB`;

export default function SignInLocations(props: {
  initial: GeoIpAdminStatus | null;
  /** The signed-in administrator: only an upload by them can prove that their own unclear upload landed. */
  actorId: string;
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
  let request: XMLHttpRequest | undefined;
  /** The unpacked size of the file in flight, to recognise this upload after a lost answer. */
  let requestSize: Promise<number | null> = Promise.resolve(null);

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
   * A lost answer or a server error leaves the upload's outcome open. A new upload by this administrator with this
   * file's unpacked size proves it landed: every saved upload gets a new upload time, so a file with the same
   * checksum counts too, and the size tells it apart from this administrator's upload of another file elsewhere.
   * Anything else leaves the outcome unclear unless the request was cancelled.
   */
  const settleUpload = async (before: GeoIpAdminStatus | null, size: Promise<number | null>, cancelled = false) => {
    const [after, expected] = await Promise.all([reconcile(), size]);
    if (!after) return unknownOutcome();
    const changed = after.databases.find((database, index) => {
      const previous = before?.databases[index]?.upload;
      return (
        database.source === "uploaded" &&
        (database.upload?.sha256 !== previous?.sha256 || database.upload?.uploadedAt !== previous?.uploadedAt) &&
        database.upload?.uploadedBy?.id === props.actorId &&
        database.upload?.size === expected
      );
    });
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
    const size = unpackedSize(file);
    requestSize = size;
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
      if (code === "ambiguous") return void settleUpload(before, size);
      setPhase({ kind: "upload-error", code, file });
      announce(errorText(code), { politeness: "assertive" });
    };
    xhr.onerror = () => {
      if (request !== xhr) return;
      request = undefined;
      void settleUpload(before, size);
    };
    xhr.send(file);
  };

  const cancel = () => {
    const before = status();
    const current = request;
    request = undefined;
    current?.abort();
    void settleUpload(before, requestSize, true);
  };

  const choose = async () => {
    // A cancelled picker answers with an error and changes nothing.
    const file = await files.showFileDialog({ accept: ".mmdb,.gz,application/gzip,application/octet-stream" }).catch(() => null);
    if (file) upload(file);
  };

  const reset = async (database: GeoIpAdminDatabase) => {
    const type = typeName(database.kind);
    const confirmed = await Dialog.confirm({
      title: t().resetTitle({ type }),
      description: database.bundled ? t().resetBody : t().resetBodyNoSnapshot,
      confirm: t().reset,
    });
    if (!confirmed) return;
    setPhase({ kind: "resetting", type: database.kind });
    const done = (next: GeoIpAdminStatus) => {
      const source = next.databases.find((entry) => entry.kind === database.kind)?.source ?? null;
      setPhase({ kind: "reset", type: database.kind, source });
      announce(resetText(database.kind, source));
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

  const resetText = (kind: GeoIpKind, source: GeoIpAdminDatabase["source"]) => {
    const type = typeName(kind);
    if (source === "uploaded") return t().resetDoneReplaced({ type });
    return source === "bundled" ? t().resetDoneBundled({ type }) : t().resetDoneEmpty({ type });
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
  /** Date first, then the database type: on a phone the line cuts the type, never the date. */
  const detailLine = (database: GeoIpAdminDatabase) => {
    if (!status()) return " ";
    if (!database.source || !database.buildDate) return database.kind === "city" ? t().noneCity : t().noneAsn;
    return [t().asOf({ date: date(database.buildDate) }), database.databaseType].filter(Boolean).join(" · ");
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

  /** The one line under the databases: what is going on now, in the tone of its outcome. */
  const line = (): { text: string; tone?: "ok" | "bad" | "warn" } => {
    const value = phase();
    if (!online()) return { text: t().offline, tone: "warn" };
    switch (value.kind) {
      case "loading":
        return { text: t().loadingStatus };
      case "load-error":
        return { text: t().loadFailed, tone: "bad" };
      case "uploading":
        return { text: t().progress({ percent: String(value.percent) }) };
      case "checking":
        return { text: t().checking };
      case "upload-error":
        return { text: errorText(value.code), tone: "bad" };
      case "uploaded":
        return { text: value.type === "city" ? t().uploadedCity : t().uploadedAsn, tone: "ok" };
      case "reconciling":
        return { text: t().reconciling };
      case "unknown-outcome":
        return { text: t().unknownOutcome, tone: "bad" };
      case "resetting":
        return { text: t().resetting };
      case "reset-error":
        return { text: value.code === "not_allowed" ? t().notAllowed : t().resetFailed, tone: "bad" };
      case "reset":
        return { text: resetText(value.type, value.source), tone: "ok" };
      default:
        return anyStale() ? { text: t().staleAdvice, tone: "warn" } : { text: t().formatHint({ size: maxBytes() }) };
    }
  };
  /**
   * The section's two deeds: "Upload file", and beside it the way out of the state now: cancel an upload, load again,
   * send the same file again to a busy server, retry a reset, or sign in again. The route policy sends an expired
   * session to sign-in and back here.
   */
  const actions = (): TwoActions => {
    const main = { label: t().upload, icon: "upload", onClick: () => void choose(), disabled: actionsDisabled() };
    const value = phase();
    const signIn = { label: t().signInAgain, icon: "login", onClick: () => location.reload() };
    if (value.kind === "uploading") return [main, { label: t().cancel, icon: "x", onClick: cancel }];
    if (value.kind === "load-error" || value.kind === "unknown-outcome")
      return [main, { label: value.kind === "load-error" ? t().retry : t().loadStatus, icon: "refresh", onClick: () => void load() }];
    if (value.kind === "upload-error" && value.code === "not_allowed") return [main, signIn];
    if (value.kind === "upload-error" && value.code === "geoip_upload_busy")
      return [main, { label: t().retry, icon: "refresh", onClick: () => upload(value.file) }];
    if (value.kind === "reset-error") {
      if (value.code === "not_allowed") return [main, signIn];
      const database = status()?.databases.find((entry) => entry.kind === value.type);
      return [main, { label: t().retry, icon: "refresh", onClick: () => database && void reset(database) }];
    }
    return [main];
  };

  return (
    <Section icon="map-pin" title={t().title} summary={t().subtitle} actions={actions()}>
      <For each={databases()}>
        {(database) => (
          <Row
            lines={[typeName(database.kind), sourceLine(database), detailLine(database)]}
            icon={database.kind === "city" ? "map-pin" : "network"}
            marks={database.stale ? <Chip status="warn">{t().stale}</Chip> : undefined}
            action={{
              label: t().reset,
              icon: "restore",
              onClick: () => void reset(database),
              disabled: actionsDisabled() || database.source !== "uploaded",
            }}
          />
        )}
      </For>
      <Text type="meta" tone={line().tone} muted={!line().tone}>
        {line().text}
      </Text>
      <Show when={status()?.attribution}>
        {(attribution) => (
          <Text type="meta" muted href={attribution().url}>
            {`${t().attribution} ${attribution().text} (${attribution().license})`}
          </Text>
        )}
      </Show>
    </Section>
  );
}
