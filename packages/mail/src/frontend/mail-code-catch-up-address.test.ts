import { expect, test } from "bun:test";
import { mailCodeCatchUpRedirect, opensMailCodeCatchUp } from "./mail-code-catch-up-address";

// "Process existing mail" is a step of the mailbox's Code page: its former page redirects there and keeps its state.
test("the former catch-up address leads to the Code page in that step and keeps selection, preview and operation", () => {
  expect(mailCodeCatchUpRedirect(new URL("https://cloud.test/app/mail/Mb4kd2/code/catch-up"))).toBe("/app/mail/Mb4kd2/code?catchUp=1");
  expect(
    mailCodeCatchUpRedirect(
      new URL(
        "https://cloud.test/app/mail/Mb4kd2/code/catch-up?folder=Fold01&from=2026-11-01&preview=00000000-0000-4000-8000-000000000004",
      ),
    ),
  ).toBe("/app/mail/Mb4kd2/code?catchUp=1&folder=Fold01&from=2026-11-01&preview=00000000-0000-4000-8000-000000000004");
  expect(mailCodeCatchUpRedirect(new URL("https://cloud.test/app/mail/Mb4kd2/code/catch-up?catchUp=1&operation=x"))).toBe(
    "/app/mail/Mb4kd2/code?catchUp=1&operation=x",
  );
});

test("only catchUp=1 opens the step", () => {
  expect(opensMailCodeCatchUp(new URL("https://cloud.test/app/mail/Mb4kd2/code?catchUp=1"))).toBe(true);
  expect(opensMailCodeCatchUp(new URL("https://cloud.test/app/mail/Mb4kd2/code"))).toBe(false);
  expect(opensMailCodeCatchUp(new URL("https://cloud.test/app/mail/Mb4kd2/code?tab=runs"))).toBe(false);
});
