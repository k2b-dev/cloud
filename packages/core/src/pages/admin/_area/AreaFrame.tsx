import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { Bar, Button, type NavProps, Pane, type PaneProps, Path, Text } from "@k2b/ui/v2";
import { type JSX, Show } from "solid-js";
import { settingsMessages } from "../settings/_components/messages";

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
  children: JSX.Element;
};

/**
 * The frame of one section of an administration area on v2: the admin bar with the area's sections, the path
 * "Area › Section" with the guide link and the section's deeds in the head, and one column with the section's sentence.
 */
export default function AreaFrame(props: AreaFrameProps) {
  const locale = useLocale();
  const s = () => settingsMessages.resolve([locale()]).t;
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
            </>
          }
        />
      }
    >
      <Pane label={props.title} scrollKey={`admin-${props.area.href}-${props.title}`} status={props.status}>
        <Show when={props.description}>{(description) => <Text muted>{description()}</Text>}</Show>
        {props.children}
      </Pane>
    </AdminWorkspace>
  );
}
