import { dates } from "@k2b/stdlib";
import { Section, useLocale } from "@k2b/ui";
import { createMemo, type JSX, Show } from "solid-js";
import type { CodeReadModelRow, CodeRunReadModel } from "../../contracts/code-read-model";
import type { CodePageData, CodePageRun, CodePageTarget, CodePageVersion } from "./data";
import { type CodePageMessages, codePageMessages } from "./messages";
import { codeTargetLabel, codeTargetName } from "./targets";

/** Query parameters on this page's path; an empty value is left out. */
export const withQuery = (href: string, params: Record<string, string | undefined>): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const text = query.toString();
  return text ? `${href}?${text}` : href;
};

/** Personal Code runs as its person; it has no place that it acts for. */
export const personal = (data: CodePageData) => data.owner.kind === "person";

const sameDay = (a: Date, b: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(a) ===
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(b);

/** One context per page: messages, dates and the target names the page shows, all from the server's clock. */
export function usePageText(data: () => CodePageData) {
  const locale = useLocale();
  const t = createMemo(() => codePageMessages.resolve([locale()]).t);
  const context = () => ({ ...data().dates, locale: locale() });
  const timeZone = () => data().dates.timeZone ?? "UTC";
  const now = () => new Date(data().dates.now);
  const date = (iso: string) => dates.formatDate(iso, context());
  const when = (iso: string) => dates.formatDateTimeRelative(iso, { ...context(), base: data().dates.now });
  const time = (iso: string) => dates.formatTime(iso, context());
  const today = (iso: string) => sameDay(new Date(iso), now(), timeZone());
  const rtf = () => new Intl.RelativeTimeFormat(locale(), { numeric: "auto", style: "short" });
  const word = (key: "today") => (locale().startsWith("de") ? { today: "heute" } : { today: "today" })[key];
  /** "28.10." or "10/28": a day this year, short. */
  const day = (iso: string) =>
    new Intl.DateTimeFormat(locale(), { timeZone: timeZone(), day: "2-digit", month: "2-digit" }).format(new Date(iso));
  /** "Mon., 16.11., 07:00": a day this week or later, with weekday and time. */
  const dayTime = (iso: string) =>
    `${new Intl.DateTimeFormat(locale(), { timeZone: timeZone(), weekday: "short" }).format(new Date(iso))}, ${day(iso)}, ${time(iso)}`;
  /**
   * A moment as people say it: "in 11 min", "4 min ago", "3 hr ago", "today, 13:45", else the day with its time. The
   * page's clock is the server's, so the server and the first browser render agree.
   */
  const moment = (iso: string) => {
    const diff = new Date(iso).getTime() - now().getTime();
    const minutes = Math.round(diff / 60_000);
    if (Math.abs(minutes) < 60) return rtf().format(minutes, "minute");
    if (diff < 0 && minutes > -12 * 60) return rtf().format(Math.round(minutes / 60), "hour");
    if (today(iso)) return `${word("today")}, ${time(iso)}`;
    return dayTime(iso);
  };
  /** "today, 13:58" or "28.10.", for lists of versions and secrets. */
  const short = (iso: string) => (today(iso) ? `${word("today")}, ${time(iso)}` : day(iso));
  const targetName = (target: CodePageTarget): string => codeTargetName(target, data().owner.title);
  const targetLabel = (target: CodePageTarget): string => codeTargetLabel(target, data().owner.title, t());
  /** The service account a place's Code runs as; personal Code has none. */
  const account = () => (data().owner.kind === "resource" ? t().accountName({ name: data().owner.title }) : null);
  /** The name of the panel that writes Code with the person, for "Change with …" and model text. */
  const editorName = () => data().editor?.label ?? "Gustav";
  return { t, locale, date, when, time, moment, short, today, day, targetName, targetLabel, account, editorName };
}
export type PageText = ReturnType<typeof usePageText>;

/** First letter upper case, for a sentence that starts with a schedule such as "every 15 minutes". */
export const sentence = (text: string, locale: string) => (text ? text.charAt(0).toLocaleUpperCase(locale) + text.slice(1) : text);

/** The read models write "Action · Target"; the page sets the action as the title and the place below it. */
export const splitRow = (text: string): { head: string; rest: string | null } => {
  const at = text.indexOf(" · ");
  return at < 0 ? { head: text, rest: null } : { head: text.slice(0, at), rest: text.slice(at + 3) };
};

/** A Tabler icon from a catalog name such as `tabler:layout-kanban`, or a class that is already one. */
export const iconClass = (icon: string | undefined, fallback: string) => {
  if (!icon) return fallback;
  if (icon.startsWith("ti ")) return icon;
  const name = icon.replace(/^tabler:/, "").replace(/[^a-z0-9-]/g, "");
  return name ? `ti ti-${name}` : fallback;
};

export type Tone = "ok" | "danger" | "warn" | "ai" | "muted";
/** A status is a sign and a word, never colour alone (3d). */
export function Status(props: { tone: Tone; icon: string; label: string; reserve?: readonly string[]; class?: string }) {
  return (
    <span class={`cloud-code__st ${props.class ?? ""}`} data-tone={props.tone}>
      <i class={props.icon} aria-hidden="true" />
      <Show when={props.reserve?.length} fallback={<span>{props.label}</span>}>
        {/* Every word this place can show reserves its width, so the text beside it never moves. */}
        <span class="cloud-code__st-reserve">
          <span>{props.label}</span>
          {props.reserve!.map((label) => (
            <span aria-hidden="true">{label}</span>
          ))}
        </span>
      </Show>
    </span>
  );
}

/** One topic of the page: an island with its title, a quiet count and at most one action. */
export function Island(props: {
  title: JSX.Element;
  meta?: JSX.Element;
  actions?: JSX.Element;
  children: JSX.Element;
  class?: string;
  state?: "ready" | "loading" | "error";
  errorMessage?: string;
  onRetry?: () => void;
  loadingRows?: number;
}) {
  return (
    <Section
      frame="line"
      size="md"
      level={2}
      class={`cloud-code__island ${props.class ?? ""}`}
      title={props.title}
      meta={props.meta}
      actions={props.actions}
      state={props.state}
      errorMessage={props.errorMessage}
      onRetry={props.onRetry}
      loadingRows={props.loadingRows}
    >
      {props.children}
    </Section>
  );
}

/** A row of an island: tile, title, one quiet line, and a right column; lines between rows, no inner boxes. */
export function Row(props: {
  icon?: string;
  tile?: "app" | "clock" | "event" | "key" | "page" | "web" | "data" | "neutral";
  title: JSX.Element;
  after?: JSX.Element;
  sub?: JSX.Element;
  extra?: JSX.Element;
  trail?: JSX.Element;
  href?: string;
  current?: boolean;
}) {
  const body = () => (
    <>
      <Show when={props.icon}>
        {(icon) => (
          <span class="cloud-code__tile k2b-icon-tile" data-tile={props.tile ?? "neutral"} aria-hidden="true">
            <i class={icon()} />
          </span>
        )}
      </Show>
      <span class="cloud-code__row-text">
        <span class="cloud-code__row-title">
          {props.title}
          <Show when={props.after}> {props.after}</Show>
        </span>
        <Show when={props.sub}>
          <span class="cloud-code__row-sub">{props.sub}</span>
        </Show>
        {props.extra}
      </span>
      <Show when={props.trail}>
        <span class="cloud-code__row-trail">{props.trail}</span>
      </Show>
    </>
  );
  return (
    <li class="cloud-code__row" data-current={props.current ? "true" : undefined}>
      <Show when={props.href} fallback={<div class="cloud-code__row-main">{body()}</div>}>
        {(href) => (
          <a class="cloud-code__row-main" href={href()} aria-current={props.current ? "true" : undefined}>
            {body()}
          </a>
        )}
      </Show>
    </li>
  );
}

/** A quiet sentence with a leading sign, such as a hint below a list. */
export function Quiet(props: { icon: string; children: JSX.Element; class?: string }) {
  return (
    <p class={`cloud-code__quiet ${props.class ?? ""}`}>
      <i class={props.icon} aria-hidden="true" />
      <span>{props.children}</span>
    </p>
  );
}

/** Model text from Gustav: the plum mark says who wrote it and that Cloud did not check it. */
export function ModelMark(props: { label: string }) {
  return (
    <span class="cloud-code__ai-mark" data-k2b-primary="ai">
      <i class="ti ti-sparkles" aria-hidden="true" />
      {props.label}
    </span>
  );
}

/** Run outcome as the strip and the lists show it. */
export const runStatus = (
  state: CodePageRun["state"] | CodeRunReadModel["state"],
  t: CodePageMessages,
): { tone: Tone; icon: string; label: string } =>
  state === "succeeded"
    ? { tone: "ok", icon: "ti ti-circle-check", label: t.statusSucceeded }
    : state === "failed" || state === "cancelled"
      ? { tone: "danger", icon: "ti ti-alert-circle", label: t.statusFailed }
      : state === "skipped"
        ? { tone: "muted", icon: "ti ti-player-skip-forward", label: t.statusSkipped }
        : state === "running"
          ? { tone: "ai", icon: "ti ti-loader-2 cloud-code__spin", label: t.statusRunning }
          : { tone: "muted", icon: "ti ti-clock", label: t.statusQueued };
export const runStatusWords = (t: CodePageMessages) => [t.statusSucceeded, t.statusFailed, t.statusSkipped, t.statusRunning];

/** A version's state in one word (3d), from its receipt and whether a newer one runs. */
export const versionStatus = (
  version: CodePageVersion,
  active: CodePageVersion | null,
  t: CodePageMessages,
): { tone: Tone; icon: string; label: string } => {
  if (version.active) return { tone: "ok", icon: "ti ti-circle-check", label: t.vOn };
  switch (version.status) {
    case "pending":
      return { tone: "warn", icon: "ti ti-hourglass", label: t.vWaiting };
    case "changes_requested":
      return { tone: "warn", icon: "ti ti-message-2", label: t.vChanges };
    case "rejected":
      return { tone: "muted", icon: "ti ti-circle-x", label: t.vRejected };
    case "withdrawn":
    case "cancelled":
      return { tone: "muted", icon: "ti ti-arrow-back-up", label: t.vWithdrawn };
    case "expired":
      return { tone: "muted", icon: "ti ti-clock-off", label: t.vExpired };
    case "superseded":
      return { tone: "muted", icon: "ti ti-history", label: t.vReplaced };
    default:
      // Approved or ready: newer than the running version it waits to be switched on; older, a newer one replaced it.
      return active && version.number < active.number
        ? { tone: "muted", icon: "ti ti-history", label: t.vReplaced }
        : { tone: "ai", icon: "ti ti-circle-dashed", label: t.vReady };
  }
};
export const versionStatusWords = (t: CodePageMessages) => [
  t.vOn,
  t.vReady,
  t.vWaiting,
  t.vChanges,
  t.vRejected,
  t.vWithdrawn,
  t.vReplaced,
];

/**
 * The steps of "What happened", in the order the run's read model lists them. The model gives no state per row, so the
 * signs stay neutral and the run's status says how it ended.
 */
export function Happened(props: { rows: readonly CodeReadModelRow[]; label: string }) {
  return (
    <ol class="cloud-code__steps" aria-label={props.label}>
      {props.rows.map((row) => (
        <li>
          <span class="cloud-code__step-sign" aria-hidden="true">
            <i class={iconClass(row.icon, "ti ti-point")} />
          </span>
          <span class="cloud-code__step-text">
            <Show when={row.href} fallback={row.text}>
              {(href) => <a href={href()}>{row.text}</a>}
            </Show>
            <Show when={row.note}>
              <span class="cloud-code__step-note">{row.note}</span>
            </Show>
          </span>
        </li>
      ))}
    </ol>
  );
}
