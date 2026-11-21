import { codePageFixture } from "./code-page.fixture";
import type { CodePageAutomation, CodePageData } from "./data";

export const HEAD_STATES = [
  "page",
  "pages",
  "schedule",
  "manual",
  "schedules",
  "both",
  "mailbox",
  "events",
  "needs-you",
  "paused",
  "paused-reader",
  "reader-page",
  "reader",
  "reader-waiting",
  "waiting",
  "partial",
  "error",
  "loading",
] as const;
export type HeadState = (typeof HEAD_STATES)[number];
export const HEAD_RUN_ID = "00000000-0000-4000-8000-999900000001";
export function headActionFixture(name: HeadState, locale = "de"): CodePageData {
  const data = codePageFixture(
    name === "waiting" || name === "reader-waiting"
      ? "new-version"
      : name === "needs-you"
        ? "needs-you"
        : name === "error"
          ? "personal-error"
          : "personal",
    locale,
    name.startsWith("reader") || name === "paused-reader" ? "Lena" : undefined,
  );
  if (data.state.kind !== "ready") return data;
  data.dates.now = "2026-11-14T12:49:04.000Z";
  const state = data.state;
  if (!state.runs) throw new Error("Expected run history in ready head fixture");
  // These head scenarios create reports and pages, not chat messages. The base personal fixture also covers chat.send.
  delete state.chatBinding;
  if (state.words?.current)
    state.words.current.mayDo.items = state.words.current.mayDo.items.filter((row) => row.target?.ref.type !== "core.ai.chat");
  const de = locale === "de";
  data.owner = { kind: "person", ref: null, title: de ? "Wochenbericht Vertrieb" : "Weekly sales report", typeTitle: null };
  const schedules = (state.automations ?? []).filter((item) => item.kind === "schedule").slice(0, 2);
  const schedule = schedules[0] ?? { entrypoint: "report", kind: "schedule" as const, cron: "0 8 * * 1", isNew: false, lastRun: null };
  // The base fixture runs Mondays at 07:00 Berlin; these head examples run at 08:00.
  // Keep the whole weekly history in the same zone and on the changed schedule.
  state.runs.items = state.runs.items.map((run) => {
    if (run.entrypoint !== "wochenbericht") return run;
    const localHour = Number(
      new Intl.DateTimeFormat("en", {
        timeZone: data.dates.timeZone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date(run.createdAt)),
    );
    const createdAt = new Date(Date.parse(run.createdAt) + (8 - localHour) * 60 * 60_000).toISOString();
    const words = state.words?.runs[run.id];
    if (words) words.at = createdAt;
    return {
      ...run,
      createdAt,
      startedAt: new Date(Date.parse(createdAt) + 1000).toISOString(),
      endedAt: new Date(Date.parse(createdAt) + 4000).toISOString(),
    };
  });
  schedule.lastRun = state.runs.items.find((run) => run.entrypoint === "wochenbericht") ?? null;
  schedule.entrypoint = "wochenbericht";
  schedule.cron = "0 8 * * 1";
  schedule.timeZone = data.dates.timeZone;
  schedule.nextRunAt = "2026-11-16T07:00:00.000Z";
  schedule.title = de ? "Erstellt den Wochenbericht" : "Creates the weekly report";
  schedule.timingText = de ? "montags um 08:00" : "Mondays at 08:00";
  const second: CodePageAutomation = {
    ...schedule,
    entrypoint: "reminder",
    cron: "0 16 * * 5",
    nextRunAt: "2026-11-20T15:00:00.000Z",
    title: de ? "Erinnert an offene Aufgaben" : "Reminds about open tasks",
    timingText: de ? "freitags um 16:00" : "Fridays at 16:00",
    lastRun: schedule.lastRun
      ? {
          ...schedule.lastRun,
          id: "00000000-0000-4000-8000-888800000001",
          entrypoint: "reminder",
          createdAt: "2026-11-13T15:00:00.000Z",
          startedAt: "2026-11-13T15:00:01.000Z",
          endedAt: "2026-11-13T15:00:04.000Z",
        }
      : null,
  };
  const home: CodePageAutomation = {
    entrypoint: "route:GET:/",
    kind: "route",
    route: { method: "GET", path: "/", public: false, page: true },
    cron: null,
    isNew: false,
    lastRun: null,
  };
  const page: CodePageAutomation = {
    ...home,
    entrypoint: "route:GET:/archive",
    title: de ? "Vergangene Wochen" : "Previous weeks",
    route: { ...home.route!, path: "/archive" },
  };
  home.pageLink = { entrypoint: home.entrypoint, title: null, path: "/", isRoot: true, href: `/code/${state.code.id}/` };
  page.pageLink = {
    entrypoint: page.entrypoint,
    title: page.title!,
    path: "/archive",
    isRoot: false,
    href: `/code/${state.code.id}/archive`,
  };
  const event: CodePageAutomation = {
    ...schedule,
    entrypoint: "event:received",
    nextRunAt: null,
    kind: "event",
    cron: null,
    title: de ? "Ordnet eingehende Nachrichten ein" : "Sorts incoming messages",
    timingText: de ? "wenn eine Nachricht eintrifft" : "when a message arrives",
  };
  state.automations =
    name === "page" || name === "reader-page" || name === "reader-waiting" || name === "paused-reader"
      ? [home]
      : name === "pages"
        ? [page, home]
        : name === "both" || name === "mailbox"
          ? [
              home,
              page,
              schedule,
              second,
              event,
              {
                ...home,
                pageLink: undefined,
                entrypoint: "public",
                title: de ? "Öffentlicher Eingang" : "Public inbox",
                route: { method: "POST", path: "/inbox", public: true, page: false },
              },
            ]
          : name === "events" || name === "reader"
            ? [event]
            : name === "schedules"
              ? [schedule, second, event]
              : name === "manual"
                ? [{ ...schedule, kind: "manual", cron: null, timingText: undefined, title: undefined, nextRunAt: null, lastRun: null }]
                : [schedule];
  if (state.automations.some((item) => item.entrypoint === second.entrypoint) && second.lastRun) state.runs.items.unshift(second.lastRun);
  if (state.words?.current && (name === "manual" || name === "events" || name === "reader"))
    state.words.current.description.text =
      name === "manual"
        ? de
          ? "Fasst die offenen Angebote zusammen, wenn du sie startest, und legt den Bericht im Notizbuch Vertrieb ab."
          : "Sums up the open offers when you run it and files the report in the Sales notebook."
        : de
          ? "Ordnet eingehende Nachrichten ein, sobald sie eintreffen."
          : "Sorts incoming messages when they arrive.";
  if (name === "mailbox")
    data.owner = {
      kind: "resource",
      ref: { type: "mail.mailbox", id: "Mb4kd2" },
      title: "info@beispiel.de",
      typeTitle: de ? "Postfach" : "Mailbox",
    };
  if (name.startsWith("reader") || name === "paused-reader") {
    state.permission = "reader";
    data.owner.runsAs = { name: "Lena" };
  }
  if (name === "paused" || name === "paused-reader") state.code = { ...state.code, state: "paused" };
  if (name === "manual") {
    state.runs = { items: [], nextCursor: null };
    if (state.words) state.words.runs = {};
  }
  const pageLinks =
    name === "pages" || name === "both" || name === "mailbox"
      ? [home.pageLink, page.pageLink]
      : name === "page" || name === "reader-page" || name === "reader-waiting" || name === "paused-reader"
        ? [home.pageLink]
        : [];
  state.pages = { versionId: state.code.activeVersionId!, homeUrl: pageLinks[0]?.href ?? null, pages: pageLinks };
  if (name === "partial") {
    state.automations = null;
    state.pages = null;
  }
  if (name === "loading") return { ...data, state: { kind: "loading" } };
  return data;
}
