import { AppWorkspace, Button, Dropdown, type DropdownItem, IconButton, ViewTabs } from "@k2b/ui";
import { Show } from "solid-js";
import { usePulseMessages } from "../use-messages";
import { buildPulseWorkspaceHref, type WorkspaceView } from "./routes";

export type PulseHeadProps = {
  baseId: string;
  view: WorkspaceView;
  /** The number of sources, or null while a base switch loads it. */
  sourceCount: number | null;
  /** The head says "No access" instead of tabs; it keeps its height. */
  denied: boolean;
  canWrite: boolean;
  addSourceDisabled: boolean;
  addSource: () => void;
  assistant: { pending: boolean; disabled?: boolean; launch: () => void };
  menu: DropdownItem[];
};

/** Tab of the head for a view; the views that wait in "…" keep Sources marked as the place they belong to. */
const currentTab = (view: WorkspaceView) => (view === "overview" || view === "dashboards" ? undefined : view);

/** The base head: four tabs at the text edge, Gustav, "…" and the one filled action at the end. */
export default function PulseHead(props: PulseHeadProps) {
  const t = usePulseMessages();
  const href = (view: WorkspaceView) => buildPulseWorkspaceHref({ baseId: props.baseId, state: { view } });
  return (
    <Show
      when={!props.denied}
      fallback={
        <AppWorkspace.Head
          views={
            <h1 class="pulse-head__title">
              <i class="ti ti-lock" aria-hidden="true" />
              {t().noAccess}
            </h1>
          }
        />
      }
    >
      <AppWorkspace.Head
        views={
          <ViewTabs
            label={t().baseViews}
            current={currentTab(props.view)}
            fit
            max={4}
            items={[
              {
                id: "sources",
                label: t().sources,
                href: href("sources"),
                count: props.sourceCount ?? "",
                countReserve: "99",
              },
              { id: "data", label: t().tabData, href: href("data") },
              { id: "usage", label: t().tabUsage, href: href("usage") },
              { id: "sql", label: "SQL", href: href("sql") },
            ]}
          />
        }
        actions={
          <span class="pulse-head__actions">
            <Button
              class="pulse-head__assistant"
              variant="secondary"
              size="sm"
              loading={props.assistant.pending}
              loadingLabel={t().sqlAssistantLaunching}
              disabled={props.assistant.disabled}
              onClick={props.assistant.launch}
            >
              <i class="ti ti-sparkles pulse-ai-icon" aria-hidden="true" />
              {t().askGustav}
            </Button>
            <IconButton
              class="pulse-head__assistant-icon"
              variant="secondary"
              size="sm"
              label={props.assistant.pending ? t().sqlAssistantLaunching : t().askGustav}
              loading={props.assistant.pending}
              disabled={props.assistant.disabled}
              onClick={props.assistant.launch}
            >
              <i class="ti ti-sparkles pulse-ai-icon" aria-hidden="true" />
            </IconButton>
            <Dropdown.Root items={props.menu} align="end" phone="sheet" label={t().moreBaseActions}>
              <Dropdown.Trigger iconOnly label={t().moreBaseActions} size="sm" variant="secondary">
                <i class="ti ti-dots" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown.Root>
          </span>
        }
        primary={
          props.canWrite
            ? {
                label: t().createSource,
                icon: "ti ti-plus",
                onClick: () => {
                  if (!props.addSourceDisabled) props.addSource();
                },
              }
            : undefined
        }
      />
    </Show>
  );
}
