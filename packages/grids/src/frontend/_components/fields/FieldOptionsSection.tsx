import { DetailPanel, IconButton } from "@k2b/ui";
import { createSignal, createUniqueId, type JSX } from "solid-js";

/** Keep controls mounted when collapsing so unsaved editor state survives. */
export function FieldOptionsSection(props: { title: string; description?: string; icon: string; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  const id = createUniqueId();
  let trigger: HTMLDivElement | undefined;
  let panel: HTMLDivElement | undefined;
  const toggle = (next: boolean) => {
    setOpen(next);
    (next ? panel : trigger)?.querySelector<HTMLButtonElement>("button")?.focus();
  };
  return (
    <div>
      <div ref={trigger} hidden={open()}>
        <DetailPanel.Action
          title={props.title}
          description={props.description}
          leading={<i class={props.icon} aria-hidden="true" />}
          trailing={<i class="ti ti-chevron-down" aria-hidden="true" />}
          aria-expanded={false}
          aria-controls={id}
          onClick={() => toggle(true)}
        />
      </div>
      <div ref={panel} id={id} hidden={!open()}>
        <DetailPanel.Group>
          <DetailPanel.Section
            title={props.title}
            description={props.description}
            icon={props.icon}
            actions={
              <IconButton
                label={props.title}
                aria-expanded={true}
                aria-controls={id}
                variant="ghost"
                size="sm"
                onClick={() => toggle(false)}
              >
                <i class="ti ti-chevron-up" aria-hidden="true" />
              </IconButton>
            }
          >
            {props.children}
          </DetailPanel.Section>
        </DetailPanel.Group>
      </div>
    </div>
  );
}
