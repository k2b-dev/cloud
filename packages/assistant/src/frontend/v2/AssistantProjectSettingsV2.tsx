import { AccessSummary } from "@k2b/cloud/access/ui";
import type { AiProject } from "@k2b/cloud/ai";
import { AiModelField } from "@k2b/cloud/ai/ui";
import { Bar, Button, Canvas, Failed, Field, Inline, Input, Loading, Notice, Pane, RecordHead, Section } from "@k2b/ui/v2";
import { Show } from "solid-js";
import { createProjectSettings } from "../AssistantProjectSettingsDialog";

/**
 * A Project's settings as a page of v2 (screen brief 3, recipe "form"): the Project's name in the head, then its
 * fields with their hints, then who has access. Saving returns to the Project. Discard and Save stand in the flow after
 * the fields and move to the pane's foot (sticky while there are changes) with G's Pane `foot` (#4334).
 */
export default function AssistantProjectSettingsV2(props: { project: AiProject; onDone: () => void }) {
  const s = createProjectSettings({ project: props.project, close: props.onDone });
  const text = s.text;
  const readOnly = () => props.project.permission === "read";

  return (
    <Pane
      label={text("Project settings")}
      head={<Bar start={<RecordHead name={props.project.name} kinds={[text("Project settings")]} />} />}
    >
      <Section icon="id" title={text("General")} summary={text("Instructions are applied to new turns in every Project chat.")}>
        <Field label={text("Name")} required error={!s.name().trim() ? text("Name is required.") : undefined}>
          <Input value={s.name()} onInput={s.setName} maxLength={120} disabled={s.saving() || readOnly()} />
        </Field>
        <Field label={text("Description")}>
          <Input multiline value={s.description()} onInput={s.setDescription} maxLength={500} disabled={s.saving() || readOnly()} />
        </Field>
        <Field
          label={text("Instructions")}
          hint={text("Only Project instructions are treated as instructions; files, knowledge, and references remain data.")}
        >
          <Input multiline value={s.instructions()} onInput={s.setInstructions} maxLength={16_000} disabled={s.saving() || readOnly()} />
        </Field>
        {/* k2b-ui gap: the model choice is Cloud's shared v1 field (`@k2b/cloud/ai/ui`); it draws itself here until it
            has a v2 form. */}
        <Canvas label={text("Default model")}>
          <div class="assistant-project-settings-v2__model">
            <AiModelField
              label={text("Default model")}
              description={text("Chats in this Project use it. Without a default, they use the person's choice, otherwise Balanced.")}
              noneLabel={text("No Project default")}
              state={
                s.models.data()
                  ? { status: "ready", models: s.models.data()! }
                  : s.models.error()
                    ? { status: "error" }
                    : { status: "loading" }
              }
              onRetry={() => void s.models.refresh()}
              value={s.defaultModel()}
              onChange={s.setDefaultModel}
              disabled={s.saving() || readOnly()}
            />
          </div>
        </Canvas>
        <Show when={s.saveError()}>
          {(message) => (
            <Notice tone="bad" title={text("Could not save Project")}>
              {message()}
            </Notice>
          )}
        </Show>
      </Section>
      <Show when={!readOnly()}>
        <Inline>
          <Button disabled={s.saving() || s.changeCount() === 0} onClick={s.discard}>
            {text("Discard")}
          </Button>
          <Button variant="primary" busy={s.saving()} disabled={s.changeCount() === 0 || !s.name().trim()} onClick={() => void s.save()}>
            {text("Save")}
          </Button>
        </Inline>
      </Show>
      <Show when={props.project.permission === "admin"}>
        <Section
          icon="shield"
          title={text("Project access")}
          summary={text("Changes apply when you save them. At least one administrator must remain.")}
          actions={[{ label: text("Edit access"), icon: "lock-access", onClick: s.runEditAccess }]}
        >
          <Show
            when={s.access.data()}
            fallback={
              <Show when={s.access.error()} fallback={<Loading rows={2} lines={1} />}>
                {(error) => <Failed text={`${text("Could not load access")} ${error().message}`} onRetry={() => void s.access.refresh()} />}
              </Show>
            }
          >
            {(entries) => (
              // k2b-ui gap: the access summary is Cloud's shared v1 part (`@k2b/cloud/access/ui`).
              <Canvas label={text("Project access")}>
                <div class="assistant-project-settings-v2__access">
                  <AccessSummary entries={entries()} />
                </div>
              </Canvas>
            )}
          </Show>
        </Section>
      </Show>
    </Pane>
  );
}
