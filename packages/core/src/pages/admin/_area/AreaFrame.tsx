import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, type NavProps, Pane, type PaneProps, Path, Text } from "@k2b/ui/v2";
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
  /** A column beside the settings with what belongs to them, such as the latest changes; only when it has some. */
  side?: { label: string; content: JSX.Element };
  children: JSX.Element;
};

/**
 * The frame of one section of an administration area on v2: the path "Area › Section" in the head with the guide and
 * the section's deeds, then the section's one-line purpose and its settings, and a column beside them when the section
 * has one. A settings form brings its own footer with Discard and Save.
 */
export default function AreaFrame(props: AreaFrameProps) {
  const locale = useLocale();
  const s = () => settingsMessages.resolve([locale()]).t;
  const main = () => (
    <Pane label={props.title} scrollKey={`admin-${props.area.href}-${props.title}`} status={props.status}>
      {/* the purpose stands in a band of its own, with the room and line the settings recipe gives what leads a page */}
      <Show when={props.description}>
        {(description) => (
          <Band>
            <Text muted>{description()}</Text>
          </Band>
        )}
      </Show>
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
