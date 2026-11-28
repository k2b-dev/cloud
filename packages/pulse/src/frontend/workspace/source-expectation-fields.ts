import { createSignal } from "solid-js";

// Domain-only form state shared by the create and edit flows. Mode changes clear
// the other expectation explicitly in the request, including "none".
export function createSourceExpectationForm(initial: { expectEverySeconds?: number | null; expectDailyBy?: string | null }) {
  const [mode, setMode] = createSignal(initial.expectEverySeconds != null ? "every" : initial.expectDailyBy ? "daily" : "none");
  const [seconds, setSeconds] = createSignal<number | null>(initial.expectEverySeconds ?? 3600);
  const [time, setTime] = createSignal(initial.expectDailyBy ?? "04:00");
  const valid = () =>
    mode() === "none" ||
    (mode() === "every"
      ? Number.isInteger(seconds()) && seconds()! > 0 && seconds()! <= 2_147_483_647
      : /^([01]\d|2[0-3]):[0-5]\d$/.test(time()));
  const value = () => ({ expectEverySeconds: mode() === "every" ? seconds() : null, expectDailyBy: mode() === "daily" ? time() : null });
  return { mode, setMode, seconds, setSeconds, time, setTime, valid, value };
}
