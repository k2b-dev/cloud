import { MaintenanceProblemSchema, type MaintenanceStatus } from "../contracts/maintenance";
import { cloudCliLanguage } from "./locale";

/**
 * Sentences `cld` prints for maintenance mode, shared by `cld admin maintenance` and the cld request path,
 * so a script sees the same words whichever command met the maintenance answer.
 */

/** sysexits EX_TEMPFAIL: the Cloud answered "try again later"; scripts can wait and retry. */
export const MAINTENANCE_EXIT_CODE = 75;

const ORANGE = "\u001b[38;5;208m";
const RESET = "\u001b[39m";

/** Colour only for a terminal that wants it; the words carry the meaning without colour. */
export const cliColorEnabled = (stream: { isTTY?: boolean } = process.stdout): boolean =>
  !process.env.NO_COLOR && (!!process.env.FORCE_COLOR || (!!stream.isTTY && process.env.TERM !== "dumb"));

/** „Wartungsmodus“ / "Maintenance mode" in orange, the mode's sign where a terminal cannot show its icon. */
export const markMaintenanceWord = (text: string, color: boolean): string =>
  color ? text.replace(/Wartungsmodus|Maintenance mode/, (word) => `${ORANGE}${word}${RESET}`) : text;

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** `14:30` today, otherwise with the date (`16.11., 14:30` / `Nov 16, 14:30`), in the terminal's local time. */
export const formatMaintenanceTime = (iso: string, locale: string | undefined, now = new Date()): string => {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (sameDay(date, now)) return time;
  const day =
    cloudCliLanguage(locale) === "de"
      ? `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.`
      : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
  return `${day}, ${time}`;
};

/**
 * `14:30` (today, local) or an ISO date-time with offset. A time that has already passed is rejected, never moved
 * to tomorrow: an operator who types 09:00 at 10:00 most likely mistyped.
 */
export const parseMaintenanceTime = (value: string, now = new Date()): string => {
  const trimmed = value.trim();
  const clock = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  let date: Date;
  if (clock) {
    const hours = Number(clock[1]);
    const minutes = Number(clock[2]);
    if (hours > 23 || minutes > 59) throw new Error(`Invalid time "${value}". Use HH:MM or an ISO date-time.`);
    date = new Date(now);
    date.setHours(hours, minutes, 0, 0);
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(trimmed)) {
    date = new Date(trimmed);
  } else throw new Error(`Invalid time "${value}". Use HH:MM or an ISO date-time.`);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid time "${value}". Use HH:MM or an ISO date-time.`);
  if (date.getTime() <= now.getTime()) throw new Error(`The time ${trimmed} has already passed.`);
  return date.toISOString();
};

type Words = { locale?: string; now?: Date };
const de = (locale: string | undefined) => cloudCliLanguage(locale) === "de";

export const maintenanceOnSentence = (status: MaintenanceStatus, { locale, now }: Words = {}): string => {
  const until = status.until ? formatMaintenanceTime(status.until, locale, now) : null;
  if (de(locale)) {
    const on = until ? `Wartungsmodus aktiviert. Geplant bis ${until} Uhr.` : "Wartungsmodus aktiviert.";
    return status.quiesce ? `${on} Ruhe: Hintergrundarbeit hält an.` : on;
  }
  const on = until ? `Maintenance mode on. Planned until ${until}.` : "Maintenance mode on.";
  return status.quiesce ? `${on} Quiet: background work is stopping.` : on;
};

/** After `on --no-quiesce`: maintenance stays, background work runs again. */
export const maintenanceResumeSentence = ({ locale }: Words = {}): string =>
  de(locale) ? "Ruhe aus: Hintergrundarbeit läuft wieder." : "Quiet off: background work runs again.";

/** At most this many busy apps are named; the rest are counted. */
const QUIET_NAMED_APPS = 3;

/** „Ruhe: 8 von 9 Apps ruhig, Mail: 2 Jobs laufen noch“ / "Quiet: 8 of 9 apps quiet, Mail: 2 jobs still running". */
export const maintenanceQuietLine = (quiet: NonNullable<MaintenanceStatus["quiet"]>, { locale }: Words = {}): string => {
  const german = de(locale);
  const parts = [german ? `Ruhe: ${quiet.quiet} von ${quiet.total} Apps ruhig` : `Quiet: ${quiet.quiet} of ${quiet.total} apps quiet`];
  for (const app of quiet.busy.slice(0, QUIET_NAMED_APPS)) {
    const jobs = app.inFlight;
    if (jobs > 0)
      parts.push(
        german
          ? `${app.name}: ${jobs} ${jobs === 1 ? "Job läuft" : "Jobs laufen"} noch`
          : `${app.name}: ${jobs} ${jobs === 1 ? "job" : "jobs"} still running`,
      );
    else parts.push(german ? `${app.name}: noch keine Rückmeldung` : `${app.name}: no report yet`);
  }
  const more = quiet.busy.length - QUIET_NAMED_APPS;
  if (more > 0) parts.push(german ? `${more} weitere` : `${more} more`);
  return parts.join(", ");
};

export const maintenanceUntilSentence = (status: MaintenanceStatus, { locale, now }: Words = {}): string => {
  const until = status.until ? formatMaintenanceTime(status.until, locale, now) : "";
  return de(locale) ? `Neues Ende: ${until} Uhr.` : `New end: ${until}.`;
};

export const maintenanceOffSentence = ({ locale }: Words = {}): string =>
  de(locale) ? "Wartungsmodus beendet. Offene Seiten laden jetzt neu." : "Maintenance mode off. Open pages reload now.";

export const maintenanceStatusLines = (status: MaintenanceStatus, { locale, now }: Words = {}): string[] => {
  const german = de(locale);
  if (!status.active) return [german ? "Wartungsmodus aus." : "Maintenance mode off."];
  const since = status.startedAt ? formatMaintenanceTime(status.startedAt, locale, now) : "";
  const until = status.until ? formatMaintenanceTime(status.until, locale, now) : null;
  const lines = [
    german
      ? `Aktiv seit ${since}${until ? ` · geplant bis ${until}` : ""}`
      : `Active since ${since}${until ? ` · planned until ${until}` : ""}`,
  ];
  if (status.message) lines.push(german ? `Hinweis: ${status.message}` : `Note: ${status.message}`);
  const { ready, total, starting } = status.apps;
  const waiting = starting.length ? ` (${starting.join(", ")} ${german ? "starten" : "starting"})` : "";
  lines.push(german ? `Apps bereit: ${ready} von ${total}${waiting}` : `Apps ready: ${ready} of ${total}${waiting}`);
  if (status.quiesce && status.quiet) lines.push(maintenanceQuietLine(status.quiet, { locale }));
  return lines;
};

/**
 * The one sentence for a gateway maintenance answer (`503` problem JSON), or `null` for any other response.
 * Reads the body from a clone, so callers can still read the original.
 */
export const maintenanceProblemSentence = async (
  response: Pick<Response, "status" | "headers" | "clone">,
  { now }: { now?: Date } = {},
): Promise<{ code: "maintenance" | "app_unavailable"; en: string; de: string } | null> => {
  if (response.status !== 503 || !(response.headers.get("Content-Type") ?? "").startsWith("application/problem+json")) return null;
  let problem: ReturnType<typeof MaintenanceProblemSchema.safeParse>;
  try {
    problem = MaintenanceProblemSchema.safeParse(await response.clone().json());
  } catch {
    return null;
  }
  if (!problem.success) return null;
  const { code, until, appId } = problem.data;
  if (code === "maintenance") {
    const time = (language: string) => (until ? formatMaintenanceTime(until, language, now) : null);
    return {
      code,
      de: time("de") ? `Wartungsmodus aktiv, geplant bis ${time("de")} Uhr.` : "Wartungsmodus aktiv.",
      en: time("en") ? `Maintenance mode active, planned until ${time("en")}.` : "Maintenance mode active.",
    };
  }
  const name = appId ?? "app";
  return {
    code,
    de: `${name} ist gerade nicht erreichbar oder startet neu. Bitte gleich noch einmal versuchen.`,
    en: `${name} is restarting or unavailable right now. Try again shortly.`,
  };
};
