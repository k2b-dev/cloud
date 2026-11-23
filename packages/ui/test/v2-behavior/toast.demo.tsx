import { type JSX, Show } from "solid-js";
import { type ToasterParts, useToaster } from "../../src/v2/behavior/toast";

/** One Workspace's toasts: a region and the buttons that show toasts in it. */
function Workspace(props: { name: string; duration: number }): JSX.Element {
  const parts: ToasterParts = useToaster({ duration: props.duration });
  const { toaster, Region, Toast, Title, Description, Action, Close } = parts;
  let count = 0;
  return (
    <section class="field" data-workspace={props.name}>
      <button
        type="button"
        class="btn"
        data-testid={`${props.name}-save`}
        onClick={() => toaster.success({ title: `Gespeichert ${++count}`, description: "Alle Änderungen sind gesichert." })}
      >
        Speichern
      </button>
      <button
        type="button"
        class="btn"
        data-testid={`${props.name}-undo`}
        onClick={() =>
          toaster.show({
            title: "Verschoben",
            action: { label: "Rückgängig", onAction: () => toaster.info({ title: "Rückgängig gemacht" }) },
          })
        }
      >
        Verschieben
      </button>
      <Region
        class="toasts"
        data-testid={`${props.name}-region`}
        maxVisible={3}
        toast={(view) => (
          <Toast id={view().id} class="toast" data-toast={view().title}>
            <Title id={view().id}>{view().title}</Title>
            <Description id={view().id}>{view().description}</Description>
            <Show when={view().actionLabel}>
              <Action id={view().id}>{view().actionLabel}</Action>
            </Show>
            <Close id={view().id} aria-label="Schließen">
              ×
            </Close>
          </Toast>
        )}
      />
    </section>
  );
}

/** Two Workspaces on one page: each has its own toasts. */
export function Demo() {
  return (
    <div class="form">
      <Workspace name="a" duration={1500} />
      <Workspace name="b" duration={1500} />
    </div>
  );
}
