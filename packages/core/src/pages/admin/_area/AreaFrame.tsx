import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { settingsSaveControls } from "@k2b/cloud/ssr/settings-draft";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Chip, type NavProps, Pane, type PaneProps, Path, Text } from "@k2b/ui/v2";
import { type JSX, Show } from "solid-js";
import { settingsMessages } from "../settings/_components/messages";
import { areaFormMessages } from "./messages";

export type AreaFrameProps = {
  /** The admin bar with the area's sections, from the server. */
  nav: NavProps;
  /** The area and its start, such as "Grundeinstellungen" at /admin/base. */
  area: { label: string; href: string };
  /** The open section's name and its one sentence. */
  title: string;
  description?: string;
  /** The documentation article of the section, when the Cloud names a documentation website. */
  documentationHref?: string;
  /** More deeds of the section in the head, such as "Test renderer". */
  actions?: JSX.Element;
  /** What stays under the head while the column scrolls, such as a list's filter bar and status row. */
  status?: PaneProps["status"];
  /**
   * The section is a settings form that saves as a whole: Discard and Save stand in the head from the first render
   * (off until the form is there), with the count of unsaved changes beside them.
   */
  saves?: boolean;
  /** A column beside the settings with what belongs to them, such as the latest changes; only when it has some. */
  side?: { label: string; content: JSX.Element };
  children: JSX.Element;
};

/**
 * The count of unsaved changes, Discard and Save of the page's settings form, for a head: "saved" (off) until the form
 * registers, on the server too, so both renders show the same head and nothing moves when the form arrives.
 */
export const FormSave = () => {
  const locale = useLocale();
  const f = () => areaFormMessages.resolve([locale()]).t;
  const state = () => settingsSaveControls()?.state ?? "saved";
  const changes = () => settingsSaveControls()?.changes ?? 0;
  return (
    <>
      <Show when={changes() > 0}>
        <Chip yours>{f().changes({ count: changes() })}</Chip>
      </Show>
      <Button disabled={state() === "saved" || state() === "saving"} onClick={() => settingsSaveControls()?.discard()}>
        {f().discard}
      </Button>
      <Button
        variant="primary"
        busy={state() === "saving"}
        disabled={state() === "saved" || state() === "invalid" || state() === "unknown"}
        onClick={() => settingsSaveControls()?.save()}
      >
        {f().save}
      </Button>
    </>
  );
};

/**
 * The frame of one section of an administration area on v2, as the settings recipe composes it: the path
 * "Area › Section" in the head with the guide, the section's deeds and, while a settings form has unsaved changes,
 * their count with Discard and Save; then the section's sentence and its settings, and a column beside them when the
 * section has one.
 */
export default function AreaFrame(props: AreaFrameProps) {
  const locale = useLocale();
  const s = () => settingsMessages.resolve([locale()]).t;
  const main = () => (
    <Pane label={props.title} scrollKey={`admin-${props.area.href}-${props.title}`} status={props.status}>
      <Show when={props.description}>{(description) => <Text muted>{description()}</Text>}</Show>
      {props.children}
    </Pane>
  );
  return (
    <AdminWorkspace
      nav={props.nav}
      head={
        <Bar
          start={<Path label={props.area.label} items={[{ label: props.area.label, href: props.area.href }, { label: props.title }]} />}
          end={
            <>
              <Show when={props.documentationHref}>
                {(href) => (
                  <Button variant="text" icon="book" href={href()}>
                    {s().documentation}
                  </Button>
                )}
              </Show>
              {props.actions}
              <Show when={props.saves}>
                <FormSave />
              </Show>
            </>
          }
        />
      }
    >
      <Show when={props.side} fallback={main()}>
        {(side) => (
          <Pane.Split>
            {main()}
            <Pane side label={side().label} width={{ min: 280, default: 340 }} scrollKey={`admin-${props.area.href}-side`}>
              {side().content}
            </Pane>
          </Pane.Split>
        )}
      </Show>
    </AdminWorkspace>
  );
}
