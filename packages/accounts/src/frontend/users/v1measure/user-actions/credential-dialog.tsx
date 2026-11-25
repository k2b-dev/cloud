import { Button, CodeDisplay, prompts } from "@k2b/ui";
import type { JSX } from "solid-js";

export function openCredentialDialog(config: {
  title: string;
  icon: string;
  intro: JSX.Element;
  fields: Array<{ label: string; value: string }>;
  doneLabel: string;
}) {
  return prompts.dialog<void>(
    (close) => (
      <div class="flex flex-col gap-5">
        <div class="flex flex-col gap-2 text-sm leading-relaxed text-dimmed">{config.intro}</div>
        <div class="flex flex-col gap-4">
          {config.fields.map((field) => (
            <CodeDisplay title={field.label} code={field.value} lineNumbers={false} />
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
