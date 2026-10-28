import { Button, ButtonLink, DetailPanel, dialogCore, PanelDialog, panelDialogWorkspaceOptions, StatusBadge } from "@k2b/ui";
import { createEffect, createSignal, For, Show } from "solid-js";
import type { DslQueryContextKey } from "../../../query-dsl/parameters";
import { GqlSourceEditor } from "../query/GqlSourceEditor";
import { useCustomAppBuilderMessages } from "./builder-messages";

type CustomAppGqlFieldProps = {
  baseId: string;
  contextKeys: readonly DslQueryContextKey[];
  label: string;
  description: string;
  dialogTitle: string;
  value: () => string;
  onValueChange: (value: string) => void;
  error?: () => string | undefined;
  lines?: number;
};

const contextLabel = (key: DslQueryContextKey): string => `@${key}`;

export function CustomAppGqlField(props: CustomAppGqlFieldProps) {
  const messages = useCustomAppBuilderMessages();
  const text = messages().text;
  const openLargeEditor = () =>
    dialogCore.open<void>(
      (close) => (
        <PanelDialog>
          <PanelDialog.Header
            title={props.dialogTitle}
            subtitle={text({ value: "The query edits the same automatically saved draft as the inspector." })}
            icon="ti ti-code"
            close={close}
            closeLabel={text({ value: "Close GQL editor" })}
          />
          <PanelDialog.Body scrollPreserveKey={`custom-app-gql-${props.dialogTitle}`}>
            <div class="flex min-h-0 flex-1 flex-col gap-4">
              <GqlSourceEditor
                baseId={props.baseId}
                contextKeys={props.contextKeys}
                label={props.label}
                description={props.description}
                error={props.error}
                fill
                lines={24}
                spellcheck={false}
                value={props.value}
                onValueChange={props.onValueChange}
              />
              <div class="flex flex-wrap items-center gap-1.5" role="group" aria-label={text({ value: "Available App query context" })}>
                <For each={props.contextKeys}>
                  {(key) => <StatusBadge tone="neutral" icon={null} variant="text" label={contextLabel(key)} />}
                </For>
              </div>
            </div>
          </PanelDialog.Body>
          <PanelDialog.Footer>
            <span class="mr-auto text-xs text-dimmed" aria-live="polite">
              {props.error?.() ?? text({ value: "Changes save automatically." })}
            </span>
            <ButtonLink href="/app/grids/help/grids-gql" target="_blank" rel="noreferrer" size="sm" variant="secondary">
              {text({ value: "GQL reference" })} <i class="ti ti-external-link" aria-hidden="true" />
            </ButtonLink>
            <Button size="sm" onClick={() => close()}>
              {text({ value: "Done" })}
            </Button>
          </PanelDialog.Footer>
        </PanelDialog>
      ),
      panelDialogWorkspaceOptions,
    );

  return (
    <div class="flex flex-col gap-2">
      <GqlSourceEditor
        baseId={props.baseId}
        contextKeys={props.contextKeys}
        label={props.label}
        description={props.description}
        error={props.error}
        lines={props.lines ?? 8}
        spellcheck={false}
        value={props.value}
        onValueChange={props.onValueChange}
      />
      <Button size="xs" variant="secondary" class="self-start" onClick={() => void openLargeEditor()}>
        <i class="ti ti-arrows-maximize" aria-hidden="true" /> {text({ value: "Open large editor" })}
      </Button>
    </div>
  );
}

type CustomAppAvailabilitySectionProps = {
  baseId: string;
  contextKeys: readonly DslQueryContextKey[];
  targetLabel: string;
  value: () => string;
  onValueChange: (value: string) => void;
  error?: () => string | undefined;
};

export function CustomAppAvailabilitySection(props: CustomAppAvailabilitySectionProps) {
  const messages = useCustomAppBuilderMessages();
  const text = messages().text;
  const [editing, setEditing] = createSignal(Boolean(props.value().trim()));

  createEffect(() => {
    if (props.value().trim()) setEditing(true);
  });

  const removeRule = () => {
    props.onValueChange("");
    setEditing(false);
  };

  return (
    <DetailPanel.Section
      title={text({ value: "Availability" })}
      description={
        props.value().trim()
          ? text({ value: "Available when the query returns at least one row." })
          : text({ value: "Available to everyone who can open this app." })
      }
      meta={
        <StatusBadge
          tone={props.error?.() ? "error" : props.value().trim() ? "running" : "neutral"}
          icon={null}
          variant="text"
          label={
            props.error?.()
              ? text({ value: "Needs attention" })
              : props.value().trim()
                ? text({ value: "Custom rule" })
                : text({ value: "Always" })
          }
        />
      }
      collapsible
      defaultOpen={Boolean(props.value().trim() || props.error?.())}
    >
      <Show
        when={editing()}
        fallback={
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            <i class="ti ti-plus" aria-hidden="true" /> {text({ value: "Add rule" })}
          </Button>
        }
      >
        <div class="flex flex-col gap-3">
          <CustomAppGqlField
            baseId={props.baseId}
            contextKeys={props.contextKeys}
            label={text({ value: "Availability GQL" })}
            description={text({ value: "At least one returned row means available. An empty result or query error means unavailable." })}
            dialogTitle={messages().targetAvailability({ target: props.targetLabel })}
            value={props.value}
            onValueChange={props.onValueChange}
            error={props.error}
            lines={5}
          />
          <Button size="xs" variant="ghost" class="self-start" onClick={removeRule}>
            <i class="ti ti-x" aria-hidden="true" /> {text({ value: "Remove rule" })}
          </Button>
        </div>
      </Show>
    </DetailPanel.Section>
  );
}
