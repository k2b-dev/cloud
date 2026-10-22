import { NumberInput, Select, TextInput } from "@k2b/ui";
import { type Accessor, createSignal, Show } from "solid-js";
import { usePulseMessages } from "../use-messages";

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
export function SourceExpectationFields(props: {
  form: ReturnType<typeof createSourceExpectationForm>;
  timezone: string;
  disabled?: Accessor<boolean>;
}) {
  const t = usePulseMessages();
  return (
    <div class="grid gap-3">
      <Select
        label={t().sourceExpectation}
        description={t().sourceExpectationTimezone({ timezone: props.timezone })}
        value={props.form.mode}
        onValueChange={(value) => {
          if (value !== null && ["none", "every", "daily"].includes(value)) props.form.setMode(value);
        }}
        disabled={props.disabled?.()}
        options={[
          { id: "none", label: t().sourceExpectationNone },
          { id: "every", label: t().sourceExpectationEvery },
          { id: "daily", label: t().sourceExpectationDaily },
        ]}
      />
      <Show when={props.form.mode() === "every"}>
        <NumberInput
          label={t().sourceExpectationSeconds}
          value={props.form.seconds}
          onValueChange={props.form.setSeconds}
          min={1}
          max={2_147_483_647}
          step={1}
          disabled={props.disabled?.()}
          error={props.form.valid() ? undefined : t().sourceExpectationInvalid}
        />
      </Show>
      <Show when={props.form.mode() === "daily"}>
        <TextInput
          label={t().sourceExpectationTime}
          value={props.form.time}
          onValueChange={props.form.setTime}
          placeholder="04:00"
          disabled={props.disabled?.()}
          error={props.form.valid() ? undefined : t().sourceExpectationInvalid}
        />
      </Show>
    </div>
  );
}
