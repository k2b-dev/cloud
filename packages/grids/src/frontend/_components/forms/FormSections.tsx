import { DetailPanel } from "@k2b/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import type { FormSection } from "../../../contracts";
import { formLayoutClass } from "./field-layout";
import type { UserInputEntry } from "./form-fields";

type Section = { firstFieldId: string; config?: FormSection; entries: UserInputEntry[] };

/** Sections change presentation only. All controls remain mounted in one form. */
export function createFormSections(entries: UserInputEntry[], initialValues: Readonly<Record<string, unknown>> = {}) {
  const groups: Section[] = [];
  for (const entry of entries) {
    if (entry.section || groups.length === 0) groups.push({ firstFieldId: entry.fieldId, config: entry.section, entries: [] });
    groups.at(-1)!.entries.push(entry);
  }
  const populated = (fieldId: string) => {
    const value = initialValues[fieldId];
    if (value == null || value === false) return false;
    if (typeof value === "string") return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  };
  // Read once: typing or clearing a value must never override a user's toggle.
  const [open, setOpen] = createSignal<Record<string, boolean>>(
    Object.fromEntries(
      groups
        .filter((group) => group.config?.collapsible)
        .map((group) => [group.firstFieldId, group.entries.some((entry) => populated(entry.fieldId))]),
    ),
  );
  const reveal = (fieldId: string) => {
    const group = groups.find((group) => group.entries.some((entry) => entry.fieldId === fieldId));
    if (group?.config?.collapsible) setOpen((current) => ({ ...current, [group.firstFieldId]: true }));
  };
  return { groups, open, setOpen, reveal };
}

export function focusFormField(form: HTMLFormElement | undefined, fieldId: string, sections: ReturnType<typeof createFormSections>) {
  sections.reveal(fieldId);
  const field = form?.querySelector<HTMLElement>(`[data-grids-form-field="${fieldId}"]`);
  const control =
    field?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
    field?.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, [role="combobox"], button, [tabindex]');
  control?.focus();
}

export function FormSections(props: { state: ReturnType<typeof createFormSections>; children: (entry: UserInputEntry) => JSX.Element }) {
  return (
    <For each={props.state.groups}>
      {(group) => {
        const fields = () => (
          <div class={formLayoutClass}>
            <For each={group.entries}>{props.children}</For>
          </div>
        );
        return (
          <div class="min-w-0 basis-full">
            <Show when={group.config} fallback={fields()}>
              {(section) => (
                <Show
                  when={section().collapsible}
                  fallback={
                    <DetailPanel.Section title={section().title} description={section().description}>
                      {fields()}
                    </DetailPanel.Section>
                  }
                >
                  <DetailPanel.Section
                    title={section().title}
                    description={section().description}
                    collapsible
                    open={props.state.open()[group.firstFieldId] ?? false}
                    onOpenChange={(value) => props.state.setOpen((current) => ({ ...current, [group.firstFieldId]: value }))}
                  >
                    {fields()}
                  </DetailPanel.Section>
                </Show>
              )}
            </Show>
          </div>
        );
      }}
    </For>
  );
}
