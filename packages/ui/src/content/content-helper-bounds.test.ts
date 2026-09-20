/**
 * Boundary regressions for the pure helpers extracted alongside Calendar,
 * Chart, FileTree and FileView.
 *
 * The helper sources are byte-identical to Cloud's (only the `@k2b/stdlib`
 * import differs, and the two stdlib builds differ only in doc-comment package
 * names), and the ported suites next to them are byte-identical to Cloud's too.
 * That makes those suites the *shared* contract — do not extend them, or the
 * mechanical diff against Cloud stops being meaningful. The cases below are the
 * ones Cloud never asserted: empty and single-element input, inclusive vs
 * exclusive range ends, min/max clamping, rounding, and what an omitted
 * optional argument does.
 */
import { describe, expect, test } from "bun:test";
import {
  CALENDAR_SNAP_MINUTES,
  calendarAutoScrollSpeed,
  calendarDayIndexAtPoint,
  calendarMinuteAtPoint,
  snapCalendarMinutes,
} from "./calendar-pointer";
import { DEFAULT_MAP_VIEWPORT, normalizeMapViewport, panMapViewport, zoomMapViewport } from "./chart-map-viewport";
import {
  normalizeStateTimelineViewport,
  renderStateTimelineSvg,
  stateTimelineDomain,
  stateTimelineHeight,
  zoomStateTimelineViewport,
} from "./chart-state-timeline";
import { allFolderPaths, buildTree, type FileTreeEntry, flattenVisible, parentOf } from "./file-tree";
import { canPreviewFile, fileViewExtension, getFileViewPreviewKind, parseDelimitedText } from "./file-view-preview";

const MEBIBYTE = 1024 * 1024;

/** Normalizes -0 to 0 so `toEqual` can compare clamped viewports structurally. */
const zeroed = <T extends Record<string, number>>(viewport: T): T =>
  Object.fromEntries(Object.entries(viewport).map(([key, value]) => [key, value + 0])) as T;

describe("calendar-pointer bounds", () => {
  test("snapping rounds half-steps up and honours a custom step", () => {
    expect(CALENDAR_SNAP_MINUTES).toBe(15);
    expect(snapCalendarMinutes(0)).toBe(0);
    // 7.5 is the exact midpoint — Math.round breaks the tie upwards.
    expect(snapCalendarMinutes(7)).toBe(0);
    expect(snapCalendarMinutes(8)).toBe(15);
    expect(snapCalendarMinutes(70, 30)).toBe(60);
    expect(snapCalendarMinutes(75, 30)).toBe(90);
  });

  test("day columns are start-inclusive and end-exclusive", () => {
    // Exactly on the left edge is column 0; exactly on the right edge is outside.
    expect(calendarDayIndexAtPoint(100, 100, 700, 7)).toBe(0);
    expect(calendarDayIndexAtPoint(99.9, 100, 700, 7)).toBeNull();
    expect(calendarDayIndexAtPoint(800, 100, 700, 7)).toBeNull();
    // Last representable point inside the strip still maps to the last column.
    expect(calendarDayIndexAtPoint(799.9, 100, 700, 7)).toBe(6);
  });

  test("day columns reject degenerate geometry instead of dividing by zero", () => {
    expect(calendarDayIndexAtPoint(150, 100, 0, 7)).toBeNull();
    expect(calendarDayIndexAtPoint(150, 100, 700, 0)).toBeNull();
    expect(calendarDayIndexAtPoint(150, 100, -700, 7)).toBeNull();
    // A single-day view collapses every inside point onto column 0.
    expect(calendarDayIndexAtPoint(100, 100, 700, 1)).toBe(0);
    expect(calendarDayIndexAtPoint(799, 100, 700, 1)).toBe(0);
  });

  test("minute mapping clamps outside the strip and survives zero height", () => {
    // Above the strip clamps to the first hour, below it to the last.
    expect(calendarMinuteAtPoint(0, 100, 600, 8, 17)).toBe(480);
    expect(calendarMinuteAtPoint(10_000, 100, 600, 8, 17)).toBe(1080);
    // Zero height must not produce NaN — the ratio falls back to 0.
    expect(calendarMinuteAtPoint(400, 100, 0, 8, 17)).toBe(480);
    // An inverted hour range still spans the minimum of one hour.
    expect(calendarMinuteAtPoint(100, 0, 100, 10, 5)).toBe(660);
  });

  test("auto-scroll saturates at the maximum speed and is zero in the middle", () => {
    // Default edge band is 56px, default maximum 18px/frame.
    expect(calendarAutoScrollSpeed(120, 100, 600)).toBe(-12);
    expect(calendarAutoScrollSpeed(100, 100, 600)).toBe(-18);
    expect(calendarAutoScrollSpeed(-500, 100, 600)).toBe(-18);
    expect(calendarAutoScrollSpeed(600, 100, 600)).toBe(18);
    expect(calendarAutoScrollSpeed(5_000, 100, 600)).toBe(18);
    // Exactly on the inner edge of the band is already the dead zone.
    expect(calendarAutoScrollSpeed(156, 100, 600)).toBe(0);
    expect(calendarAutoScrollSpeed(544, 100, 600)).toBe(0);
    // Custom edge/maximum.
    expect(calendarAutoScrollSpeed(100, 100, 600, 10, 4)).toBe(-4);
  });
});

describe("chart-map-viewport bounds", () => {
  test("an omitted viewport falls back to the default", () => {
    expect(normalizeMapViewport(undefined)).toEqual(DEFAULT_MAP_VIEWPORT);
  });

  test("zoom 0 shows the whole world, so the centre is pinned to 0/0", () => {
    // latitudeLimit = 90 - 90/scale, so at scale 1 there is no room to pan.
    expect(normalizeMapViewport({ latitude: 45, longitude: 90, zoom: 0 })).toEqual(DEFAULT_MAP_VIEWPORT);
    // Clamping a negative value against a -0 bound yields -0, which `toEqual`
    // distinguishes from 0. Harmless (it serializes and compares as 0), but
    // assert it explicitly so the quirk is documented rather than rediscovered.
    expect(zeroed(normalizeMapViewport({ latitude: -80, longitude: -170, zoom: 0 }))).toEqual(DEFAULT_MAP_VIEWPORT);
    expect(Object.is(normalizeMapViewport({ latitude: -80, longitude: -170, zoom: 0 }).latitude, -0)).toBe(true);
  });

  test("zoom clamps to the 0..5 band from both directions", () => {
    expect(normalizeMapViewport({ latitude: 0, longitude: 0, zoom: -10 }).zoom).toBe(0);
    expect(normalizeMapViewport({ latitude: 0, longitude: 0, zoom: 5 }).zoom).toBe(5);
    expect(zoomMapViewport(DEFAULT_MAP_VIEWPORT, -1).zoom).toBe(0);
    expect(zoomMapViewport({ latitude: 0, longitude: 0, zoom: 4.5 }, 1).zoom).toBe(5);
  });

  test("pan limits grow with the zoom level", () => {
    // At zoom 1 the visible half-span is 45deg lat / 90deg lng.
    expect(normalizeMapViewport({ latitude: 89, longitude: 179, zoom: 1 })).toEqual({ latitude: 45, longitude: 90, zoom: 1 });
    expect(zeroed(panMapViewport({ latitude: 0, longitude: 0, zoom: 0 }, 100, 100, 400, 200))).toEqual(DEFAULT_MAP_VIEWPORT);
    // Non-positive dimensions short-circuit to a plain normalize.
    expect(panMapViewport({ latitude: 89, longitude: 0, zoom: 1 }, 10, 10, 400, 0).latitude).toBe(45);
    expect(panMapViewport({ latitude: 89, longitude: 0, zoom: 1 }, 10, 10, -1, 200).latitude).toBe(45);
  });
});

describe("chart-state-timeline bounds", () => {
  test("an inverted explicit domain is flipped, a degenerate one is ignored", () => {
    const rows = [{ label: "row", intervals: [{ from: 10, to: 30, state: "ok" }] }];

    expect(stateTimelineDomain(rows, [100, 0])).toEqual([0, 100]);
    // from === to carries no range, so the data domain wins instead.
    expect(stateTimelineDomain(rows, [5, 5])).toEqual([10, 30]);
    expect(stateTimelineDomain(rows, [Number.NaN, 100])).toEqual([10, 30]);
    expect(stateTimelineDomain(rows)).toEqual([10, 30]);
  });

  test("a degenerate full domain normalizes to the unit range", () => {
    expect(normalizeStateTimelineViewport([2, 8], [0, 0])).toEqual([0, 1]);
    expect(normalizeStateTimelineViewport(undefined, [0, 100])).toEqual([0, 100]);
    // A viewport wider than the full domain is capped, not offset.
    expect(normalizeStateTimelineViewport([-1000, 1000], [0, 100])).toEqual([0, 100]);
    // A viewport past the right edge is pushed back inside, keeping its span.
    expect(normalizeStateTimelineViewport([90, 130], [0, 100])).toEqual([60, 100]);
  });

  test("zoom clamps its anchor and never shrinks past 1/64 of the domain", () => {
    let viewport = normalizeStateTimelineViewport([0, 640], [0, 640]);
    for (let step = 0; step < 40; step += 1) viewport = zoomStateTimelineViewport(viewport, [0, 640], 1);
    expect(viewport[1] - viewport[0]).toBeCloseTo(10, 10);

    // Out-of-range anchors clamp to the viewport edges rather than escaping it.
    expect(zoomStateTimelineViewport([0, 100], [0, 100], 1, -5)).toEqual(zoomStateTimelineViewport([0, 100], [0, 100], 1, 0));
    expect(zoomStateTimelineViewport([0, 100], [0, 100], 1, 5)).toEqual(zoomStateTimelineViewport([0, 100], [0, 100], 1, 1));
  });

  test("height has a floor and reacts to the legend flag", () => {
    // TOP 38 + rows*24 + axis 28 + legend 24, floored at 160.
    expect(stateTimelineHeight(0)).toBe(160);
    expect(stateTimelineHeight(3)).toBe(162);
    expect(stateTimelineHeight(3, false)).toBe(160);
    expect(stateTimelineHeight(10)).toBe(330);
    expect(stateTimelineHeight(10, false)).toBe(306);
  });

  test("only same-origin absolute paths survive as links", () => {
    const link = (href: string) =>
      renderStateTimelineSvg({
        width: 800,
        height: 160,
        rows: [{ label: "row", href, intervals: [{ from: 0, to: 1, state: "ok" }] }],
      });

    // Protocol-relative URLs start with "/" too — they must not slip through.
    expect(link("//evil.example/steal")).not.toContain("evil.example");
    expect(link("https://evil.example/steal")).not.toContain("evil.example");
    expect(link("javascript:alert(1)")).not.toContain("javascript:");
    expect(link("/admin/jobs")).toContain('href="/admin/jobs"');
  });
});

describe("file-tree bounds", () => {
  test("parentOf collapses top-level and relative paths to the root", () => {
    expect(parentOf("/a.txt")).toBe("/");
    expect(parentOf("a.txt")).toBe("/");
    expect(parentOf("/a/b")).toBe("/a");
    expect(parentOf("/a/b/c")).toBe("/a/b");
  });

  test("empty and single-entry inputs stay well formed", () => {
    expect(buildTree([])).toEqual([]);
    expect(allFolderPaths([])).toEqual([]);
    expect(flattenVisible([], new Set())).toEqual([]);

    const single = buildTree([{ path: "/only.txt" }]);
    expect(single).toHaveLength(1);
    expect(single[0]!.isFolder).toBe(false);
    expect(single[0]!.depth).toBe(0);
    expect(allFolderPaths(single)).toEqual([]);
  });

  test("every ancestor of a deep path becomes an implicit folder", () => {
    const tree = buildTree([{ path: "/a/b/c/deep.txt" }]);
    expect(allFolderPaths(tree)).toEqual(["/a", "/a/b", "/a/b/c"]);
    // Collapsed by default: nothing below the first level is visible.
    expect(flattenVisible(tree, new Set()).map((node) => node.entry.path)).toEqual(["/a"]);
  });

  test("folders sort before files regardless of name", () => {
    // "zzz" is a folder and "aaa.txt" a file, so the folder still leads.
    const tree = buildTree([{ path: "/zzz/inner.txt" }, { path: "/aaa.txt" }]);
    expect(tree.map((node) => node.entry.path)).toEqual(["/zzz", "/aaa.txt"]);
  });

  test("a later entry for the same path wins", () => {
    const entries: FileTreeEntry[] = [
      { path: "/dup.txt", badge: "first" },
      { path: "/dup.txt", badge: "second" },
    ];
    const tree = buildTree(entries);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.entry.badge).toBe("second");
  });

  test("an explicit folder entry keeps its own metadata", () => {
    const tree = buildTree([{ path: "/mount", kind: "folder", badge: "ro" }]);
    expect(tree[0]!.isFolder).toBe(true);
    expect(tree[0]!.entry.badge).toBe("ro");
    expect(tree[0]!.children).toEqual([]);
  });
});

describe("file-view-preview bounds", () => {
  test("extension parsing strips query/hash, lowercases, and ignores dotfiles", () => {
    expect(fileViewExtension("report.CSV")).toBe("csv");
    expect(fileViewExtension("/a/b/report.csv?token=1")).toBe("csv");
    expect(fileViewExtension("/a/b/report.csv#top")).toBe("csv");
    expect(fileViewExtension("/a/b/noextension")).toBe("");
    // A leading dot is part of the name, not an extension separator.
    expect(fileViewExtension(".env")).toBe("");
    expect(fileViewExtension("/etc/.env")).toBe("");
    expect(fileViewExtension("app.env")).toBe("env");
    // Only the last dot counts.
    expect(fileViewExtension("archive.tar.gz")).toBe("gz");
  });

  test("size limits are inclusive at the maximum and reject impossible sizes", () => {
    expect(getFileViewPreviewKind({ path: "a.png", size: 25 * MEBIBYTE })).toBe("image");
    expect(getFileViewPreviewKind({ path: "a.png", size: 25 * MEBIBYTE + 1 })).toBeNull();
    expect(getFileViewPreviewKind({ path: "a.txt", size: 0 })).toBe("text");
    expect(getFileViewPreviewKind({ path: "a.txt", size: -1 })).toBeNull();
    expect(getFileViewPreviewKind({ path: "a.txt", size: Number.NaN })).toBeNull();
    expect(getFileViewPreviewKind({ path: "a.txt", size: Number.POSITIVE_INFINITY })).toBeNull();
    // An omitted size skips the limit check entirely.
    expect(getFileViewPreviewKind({ path: "a.txt" })).toBe("text");
  });

  test("media types are matched case-insensitively and without parameters", () => {
    expect(getFileViewPreviewKind({ path: "blob", mediaType: "TEXT/CSV; charset=utf-8" })).toBe("delimited-text");
    expect(getFileViewPreviewKind({ path: "blob", mediaType: "application/ld+json" })).toBe("json");
    expect(getFileViewPreviewKind({ path: "blob", mediaType: "text/anything-at-all" })).toBe("text");
    expect(getFileViewPreviewKind({ path: "blob" })).toBeNull();
    expect(canPreviewFile({ path: "blob" })).toBe(false);
  });

  test("markdown outranks the generic text/* fallback", () => {
    expect(getFileViewPreviewKind({ path: "notes.md", mediaType: "text/plain" })).toBe("markdown");
    expect(getFileViewPreviewKind({ path: "notes.txt", mediaType: "text/markdown" })).toBe("markdown");
  });

  test("delimited parsing handles empty, single-cell and trailing-newline input", () => {
    expect(parseDelimitedText("", ",")).toMatchObject({ rows: [], truncated: false });
    expect(parseDelimitedText("a", ",")).toMatchObject({ rows: [["a"]], truncated: false });
    // A trailing newline must not emit a phantom empty row.
    expect(parseDelimitedText("a,b\n", ",")).toMatchObject({ rows: [["a", "b"]], truncated: false });
    // Bare CR is a line ending too.
    expect(parseDelimitedText("a\rb", ",")).toMatchObject({ rows: [["a"], ["b"]], truncated: false });
    // Empty fields are preserved.
    expect(parseDelimitedText("a,,c", ",")).toMatchObject({ rows: [["a", "", "c"]], truncated: false });
  });

  test("quotes only open a quoted field at the field start", () => {
    expect(parseDelimitedText('a"b"c,d', ",")).toMatchObject({ rows: [['a"b"c', "d"]], truncated: false });
    // An unterminated quote yields the rest of the input as one field.
    expect(parseDelimitedText('"abc', ",")).toMatchObject({ rows: [["abc"]], truncated: false });
    // A lone empty quoted field produces no row at all: the trailing flush only
    // fires when a field or row has accumulated content.
    expect(parseDelimitedText('""', ",")).toMatchObject({ rows: [], truncated: false });
    // With a sibling column it survives, so this only affects fully empty input.
    expect(parseDelimitedText('"",x', ",")).toMatchObject({ rows: [["", "x"]], truncated: false });
  });

  test("column and row caps flag truncation without dropping the kept cells", () => {
    expect(parseDelimitedText("a,b,c", ",", { columns: 2 })).toMatchObject({ rows: [["a", "b"]], truncated: true });
    // Exactly at the cap is not truncation.
    expect(parseDelimitedText("a\nb", ",", { rows: 2 })).toMatchObject({ rows: [["a"], ["b"]], truncated: false });
    // A zero/negative cap floors at 1 rather than returning nothing.
    expect(parseDelimitedText("a,b\nc,d", ",", { rows: 0 })).toMatchObject({ rows: [["a", "b"]], truncated: true });
    expect(parseDelimitedText("a,b", ",", { columns: 0 })).toMatchObject({ rows: [["a"]], truncated: true });
  });
});
