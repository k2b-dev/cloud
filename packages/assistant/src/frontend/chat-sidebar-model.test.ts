import { describe, expect, test } from "bun:test";
import type { AssistantChatResult } from "../chat-context";
import { emptySidebarSnapshot, fileResult, minutesAgo, SIDEBAR_NOW, sidebarSnapshot, source, upload } from "./AssistantChatSidebar.fixture";
import {
  buildFilesModel,
  buildResultsModel,
  buildSourceEntries,
  buildWorkingModel,
  calendarDay,
  groupByTime,
  matchChatSearch,
  resultsInFolder,
} from "./chat-sidebar-model";

const days = (count: number) => minutesAgo(count * 24 * 60);

describe("chat sidebar time groups", () => {
  test("group the last seven days by day and older entries by month, in the viewer's time zone", () => {
    // 23:30 UTC on Oct 5 is already Oct 6 in Berlin.
    expect(calendarDay("2026-10-05T23:30:00.000Z", "Europe/Berlin")).toBe("2026-10-06");
    expect(calendarDay("2026-10-05T23:30:00.000Z", "UTC")).toBe("2026-10-05");
    const items = [minutesAgo(10), days(1), days(6), days(7), days(40), days(41)];
    const groups = groupByTime(items, (at) => at, SIDEBAR_NOW, "Europe/Berlin");
    expect(groups.map((group) => [group.kind, group.date, group.items.length])).toEqual([
      ["day", "2026-10-06", 1],
      ["day", "2026-10-05", 1],
      ["day", "2026-09-30", 1],
      ["month", "2026-09", 1],
      ["month", "2026-08", 2],
    ]);
  });
});

describe("chat sidebar results", () => {
  test("keep every result of the latest delivering turn on top, however old it is", () => {
    const results = [
      fileResult("/a.pdf", { at: days(30), turn: "t2", seq: 20 }),
      fileResult("/b.pdf", { at: days(31), turn: "t1", seq: 10 }),
    ];
    const model = buildResultsModel(results, SIDEBAR_NOW, "UTC");
    expect(model.current.map((result) => result.key)).toEqual(["/a.pdf"]);
    expect(model.older.map((group) => group.items.map((result) => result.key))).toEqual([["/b.pdf"]]);
  });

  test("add other results of the last 24 hours up to six entries, then move the rest into groups", () => {
    const results = [
      fileResult("/latest.pdf", { at: minutesAgo(1), turn: "t9", seq: 90 }),
      ...Array.from({ length: 7 }, (_, index) =>
        fileResult(`/today-${index}.pdf`, { at: minutesAgo(60 + index), turn: `t${index}`, seq: index }),
      ),
      fileResult("/older.pdf", { at: days(2), turn: "old", seq: 1 }),
    ];
    const model = buildResultsModel(results, SIDEBAR_NOW, "UTC");
    expect(model.latestCount).toBe(1);
    expect(model.current.map((result) => result.key)).toEqual([
      "/latest.pdf",
      "/today-0.pdf",
      "/today-1.pdf",
      "/today-2.pdf",
      "/today-3.pdf",
      "/today-4.pdf",
    ]);
    expect(model.older.map((group) => [group.kind, group.daysAgo, group.items.length])).toEqual([
      ["day", 0, 2],
      ["day", 2, 1],
    ]);
  });

  test("fold a latest turn of more than six results into five and one row", () => {
    const results = Array.from({ length: 8 }, (_, index) => fileResult(`/part-${index}.pdf`, { at: minutesAgo(index), turn: "t", seq: 1 }));
    const model = buildResultsModel(results, SIDEBAR_NOW, "UTC");
    expect(model.current).toHaveLength(5);
    expect(model.latestOverflow.map((result) => result.key)).toEqual(["/part-5.pdf", "/part-6.pdf", "/part-7.pdf"]);
    expect(model.older).toEqual([]);
  });

  test("judge the 24-hour window at the snapshot's now, so a later render without a new snapshot moves nothing", () => {
    const results = [
      fileResult("/new.pdf", { at: minutesAgo(1), turn: "t2", seq: 2 }),
      fileResult("/day.pdf", { at: minutesAgo(23 * 60), turn: "t1", seq: 1 }),
    ];
    expect(buildResultsModel(results, SIDEBAR_NOW, "UTC").current).toHaveLength(2);
    expect(buildResultsModel(results, minutesAgo(-120), "UTC").current).toHaveLength(1);
  });
});

describe("chat sidebar files, working files, and sources", () => {
  test("show the five newest uploads and fold older ones and voice recordings", () => {
    const files = [
      ...Array.from({ length: 7 }, (_, index) => upload(`/upload-${index}.csv`, days(index))),
      { ...upload("/voice.webm", minutesAgo(3), "audio/webm"), dictationRecordedAt: minutesAgo(3) },
      { ...upload("/made-by-assistant.csv", minutesAgo(2)), origin: "assistant" as const },
    ];
    const model = buildFilesModel(files, SIDEBAR_NOW, "UTC");
    expect(model.recent.map((file) => file.path)).toEqual([
      "/upload-0.csv",
      "/upload-1.csv",
      "/upload-2.csv",
      "/upload-3.csv",
      "/upload-4.csv",
    ]);
    expect(model.olderCount).toBe(2);
    expect(model.voice.map((file) => file.path)).toEqual(["/voice.webm"]);
    expect(model.count).toBe(8);
  });

  test("name a working folder after the result it prepared and gather undelivered assistant files under Other", () => {
    const snapshot = sidebarSnapshot({
      files: [{ ...upload("/notes.md", minutesAgo(5), "text/markdown"), origin: "assistant" }],
      working: {
        groups: [
          { folder: "umsatzbericht-q1-q3", count: 7, bytes: 10, updatedAt: minutesAgo(22), mediaTypes: { "text/html": 7 } },
          { folder: null, count: 1, bytes: 5, updatedAt: minutesAgo(3), mediaTypes: { "image/png": 1 } },
        ],
        groupCount: 3,
        looseFiles: [{ ...upload("/temp/chart.png", minutesAgo(3), "image/png"), origin: "assistant" }],
        count: 8,
        bytes: 15,
      },
      storage: { usedBytes: 200, maxBytes: 250 },
    });
    const model = buildWorkingModel(snapshot);
    const groups = model.groups.flatMap((group) => group.items);
    // Most recently changed first.
    expect(groups.map((group) => [group.folder, group.resultTitle, group.count])).toEqual([
      [null, null, 2],
      ["umsatzbericht-q1-q3", "Umsatzbericht Q1-Q3.pdf", 7],
    ]);
    expect(groups[0]!.files.map((file) => file.path)).toEqual(["/temp/chart.png", "/notes.md"]);
    expect(model.count).toBe(9);
    expect(model.hiddenGroups).toBe(1);
    expect(model.kinds[0]).toEqual({ kind: "html", count: 7 });
    expect(model.storage.notice).toBe(true);
    expect(buildWorkingModel(emptySidebarSnapshot()).storage.notice).toBe(false);
  });

  test("bundle the Cloud items of one tool call and keep each search as its own entry", () => {
    const entries = buildSourceEntries([
      source("activity", "web_search:a", "a", minutesAgo(1)),
      source("activity", "web_search:b", "b", minutesAgo(2)),
      source("resource", "mail.message:1", "Mail 1", minutesAgo(3), { sourceCallId: "call-mail" }),
      source("resource", "mail.message:2", "Mail 2", minutesAgo(3), { sourceCallId: "call-mail" }),
      source("web", "https://example.com/", "Example", minutesAgo(4)),
    ]);
    expect(entries.map((entry) => [entry.kind, entry.kind === "cloud" ? entry.items.length : 1])).toEqual([
      ["search", 1],
      ["search", 1],
      ["cloud", 2],
      ["web", 1],
    ]);
  });

  test("search finds a result by its file name, an app by its current title, and shows a delivered file once", () => {
    const report = fileResult("/final-report.pdf", { title: "Sales summary", at: minutesAgo(5), turn: "t1", seq: 3 });
    const app: AssistantChatResult = {
      key: "assistant.artifact:App001",
      kind: "app",
      title: "Revenue dashboard",
      description: null,
      icon: "ti ti-app-window",
      deliveredAt: minutesAgo(4),
      turnId: "t1",
      callId: "open",
      messageSeq: 3,
      app: { id: "App001", href: "/app/assistant/apps/App001", published: false, lastRun: null },
    };
    // The server matched the result's path and the file itself; the local title search knows nothing of the path.
    const byPath = matchChatSearch(
      [report, app],
      [
        source("result", "/final-report.pdf", "Sales summary", minutesAgo(5), {
          path: "/final-report.pdf",
          size: 4,
          mediaType: "application/pdf",
        }),
        source("file", "/final-report.pdf", "final-report.pdf", minutesAgo(5), { path: "/final-report.pdf", size: 4 }),
        source("file", "/data.csv", "data.csv", minutesAgo(9), { path: "/data.csv", size: 2, mediaType: "text/csv" }),
      ],
      "final-report",
    );
    expect(byPath.results.map((result) => result.key)).toEqual(["/final-report.pdf"]);
    expect(byPath.files.map((file) => file.path)).toEqual(["/data.csv"]);
    // The server stores an app under "Studio app"; its current title matches only here.
    expect(matchChatSearch([report, app], [], "dashboard").results.map((result) => result.key)).toEqual(["assistant.artifact:App001"]);
    expect(matchChatSearch([report, app], [], "final-report.pdf").results).toEqual([report]);
  });

  test("a delivered file the snapshot does not carry shows as a file, a deleted one not at all", () => {
    const matches = matchChatSearch(
      [],
      [
        source("result", "/old.pdf", "Old report", minutesAgo(90), { path: "/old.pdf", size: 4, mediaType: "application/pdf" }),
        source("result", "/gone.pdf", "Gone", minutesAgo(91), { path: null, size: null }),
        source("web", "https://example.test/", "Example", minutesAgo(2)),
      ],
      "report",
    );
    expect(matches.files).toEqual([{ path: "/old.pdf", title: "Old report", mediaType: "application/pdf", size: 4 }]);
    expect(matches.sources.map((hit) => hit.key)).toEqual(["https://example.test/"]);
  });

  test("a working folder's results are the delivered files below it", () => {
    const results = [
      fileResult("/temp/report/final.pdf", { at: minutesAgo(1), turn: "t", seq: 1 }),
      fileResult("/temp/report-2/other.pdf", { at: minutesAgo(1), turn: "t", seq: 1 }),
      fileResult("/report.pdf", { at: minutesAgo(1), turn: "t", seq: 1 }),
    ];
    expect(resultsInFolder(results, "report").map((result) => result.key)).toEqual(["/temp/report/final.pdf"]);
  });
});
