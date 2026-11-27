import { Notice, Pane, Workspace } from "@k2b/ui/v2";

/**
 * The display address names no place: the page says what is missing where the weather would stand. A wall shows it as
 * an alert (a notice in the tone of wrong), as the v1 page did, so assistive technology hears it at once.
 */
export default function DisplayMissing(props: { title: string; text: string }) {
  return (
    <Workspace>
      <Pane label={props.title}>
        <Notice tone="bad" icon="map-pin-off" title={props.title}>
          {props.text}
        </Notice>
      </Pane>
    </Workspace>
  );
}
