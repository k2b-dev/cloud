import { Empty, Pane, Workspace } from "@k2b/ui/v2";

/** The display address names no place: the page says what is missing where the weather would stand. */
export default function DisplayMissing(props: { title: string; text: string }) {
  return (
    <Workspace>
      <Pane label={props.title}>
        <Empty icon="map-pin-off" text={`${props.title}. ${props.text}`} />
      </Pane>
    </Workspace>
  );
}
