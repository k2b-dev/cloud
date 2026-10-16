import { describe, expect, test } from "bun:test";
import { readShellFocusCookie, SHELL_FOCUS_COOKIE, shellFocusCookie } from "./shell-focus";

describe("shell focus cookie", () => {
  test("reads only the exact cookie name and value 1", () => {
    expect(SHELL_FOCUS_COOKIE).toBe("cloud_shell_focus");
    for (const header of ["cloud_shell_focus=1", "theme=dark; cloud_shell_focus=1; other=2", " cloud_shell_focus=1 "])
      expect(readShellFocusCookie(header)).toBe(true);
    for (const header of [
      undefined,
      null,
      "",
      "xcloud_shell_focus=1",
      "cloud_shell_focus_extra=1",
      "cloud_shell_focus=0",
      "cloud_shell_focus=",
      "cloud_shell_focus=11",
      "cloud_shell_focus=%31",
      "other=cloud_shell_focus=1",
    ])
      expect(readShellFocusCookie(header)).toBe(false);
  });
  test.each([false, true])("writes and deletes a year-long, root-scoped cookie (secure=%s)", (secure) => {
    const suffix = secure ? "; Secure" : "";
    expect(shellFocusCookie(true, secure)).toBe(`cloud_shell_focus=1; Path=/; Max-Age=31536000; SameSite=Lax${suffix}`);
    expect(shellFocusCookie(false, secure)).toBe(`cloud_shell_focus=; Path=/; Max-Age=0; SameSite=Lax${suffix}`);
  });
});
