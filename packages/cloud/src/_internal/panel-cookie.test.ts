import { expect, test } from "bun:test";
import { readPanelCookie, serializePanelCookie } from "./panel-cookie";

test("round trips encoded provider ids, open state and rounded width", () => {
  const state = { open: true, provider: "fixture:two", widthRem: 24.126 };
  const cookie = serializePanelCookie(state, true);
  expect(cookie).toBe("cloud_panel=1:fixture%3Atwo:24.13; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
  expect(readPanelCookie(`other=x; ${cookie}`, [state.provider])).toEqual({ ...state, widthRem: 24.13 });
  expect(serializePanelCookie({ open: false, provider: "a" }, false)).toBe("cloud_panel=0:a:; Path=/; Max-Age=31536000; SameSite=Lax");
  expect(readPanelCookie("cloud_panel=0:a:", ["a"])).toEqual({ open: false, provider: "a" });
  expect(readPanelCookie("cloud_panel=0::", [])).toEqual({ open: false });
});

test("clamps widths on reads and writes", () => {
  for (const [width, expected] of [
    [19, 20],
    [40, 36],
    [24, 24],
  ] as const) {
    expect(readPanelCookie(`cloud_panel=1:a:${width}`, ["a"]).widthRem).toBe(expected);
    expect(serializePanelCookie({ open: true, provider: "a", widthRem: width }, false)).toContain(`1:a:${expected};`);
  }
});

test("malformed cookies and inaccessible providers close and drop all state", () => {
  for (const value of [
    "garbage",
    "1:x",
    "2:a:20",
    "1:a:abc",
    "1:a:24.123",
    "1:a:-20",
    "1:a:2e1",
    "1:a:100",
    "1:%:24",
    "1::24",
    "1:unknown:24",
    "0:unknown:24",
    "1:a:24:extra",
  ]) {
    expect(readPanelCookie(`cloud_panel=${value}`, ["a"]), value).toEqual({ open: false });
  }
  expect(readPanelCookie(undefined, ["a"])).toEqual({ open: false });
  expect(readPanelCookie("other=1:a:24", ["a"])).toEqual({ open: false });
});
