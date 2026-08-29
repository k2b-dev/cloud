import { Button, CopyButton, prompts } from "@k2b/ui";
import type { JSX } from "solid-js";

function SecretField(props: { label: string; value: string; copyLabel: string; tone?: "default" | "primary" }) {
  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between gap-3">
        <span class="text-[11px] font-semibold uppercase tracking-[0.28em] text-dimmed">{props.label}</span>
        <CopyButton text={props.value} label={props.copyLabel} />
      </div>
      <pre
        class={`overflow-x-auto whitespace-pre-wrap break-all rounded-2xl px-4 py-3 text-sm font-mono leading-relaxed ${
          props.tone === "primary"
            ? "bg-blue-50 text-blue-950 dark:bg-blue-950/50 dark:text-blue-100"
            : "bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100"
        }`}
      >
        {props.value}
      </pre>
    </div>
  );
}

export function openCredentialDialog(config: {
  title: string;
  icon: string;
  intro: JSX.Element;
  fields: Array<{ label: string; value: string; copyLabel: string; tone?: "default" | "primary" }>;
  doneLabel: string;
}) {
  return prompts.dialog<void>(
    (close) => (
      <div class="flex flex-col gap-5">
        <div class="flex flex-col gap-2 text-sm leading-relaxed text-dimmed">{config.intro}</div>
        <div class="flex flex-col gap-4">
          {config.fields.map((field) => (
            <SecretField label={field.label} value={field.value} copyLabel={field.copyLabel} tone={field.tone} />
          ))}
        </div>
        <div class="flex justify-end">
          <Button size="sm" onClick={() => close()}>
            {config.doneLabel}
          </Button>
        </div>
      </div>
    ),
    { title: config.title, icon: config.icon },
  );
}
