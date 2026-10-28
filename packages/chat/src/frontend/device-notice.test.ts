import { expect, test } from "bun:test";
import {
  CHAT_DEVICE_NOTICE_COOKIE,
  type DeviceNotice,
  deviceNoticeCookie,
  parseDeviceNotice,
  serializeDeviceNotice,
} from "./device-notice";

const now = new Date("2026-10-28T10:42:00Z");

test("the remembered notice survives the cookie, and anything else reads as none", () => {
  const notices: DeviceNotice[] = [
    { kind: "ask" },
    { kind: "home-screen" },
    { kind: "none" },
    { kind: "quiet", reason: "doNotDisturb", until: "2026-10-28T12:00:00.000Z" },
    { kind: "quiet", reason: "quietHours", until: null },
  ];
  for (const notice of notices) expect(parseDeviceNotice(serializeDeviceNotice(notice), now)).toEqual(notice);
  for (const value of [undefined, "", "yes", "doNotDisturb", "doNotDisturb.not-a-date", "quietHours.2026-10-28T10:00:00Z"])
    expect(parseDeviceNotice(value, now)).toEqual({ kind: "none" });
});

test("the cookie is scoped to Chat and kept for a year", () => {
  const cookie = deviceNoticeCookie({ kind: "quiet", reason: "doNotDisturb", until: "2026-10-28T12:00:00.000Z" });
  expect(cookie).toStartWith(`${CHAT_DEVICE_NOTICE_COOKIE}=doNotDisturb.2026-10-28T12%3A00%3A00.000Z;`);
  expect(cookie).toContain("Path=/app/chat");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).toContain(`Max-Age=${365 * 24 * 60 * 60}`);
});
