import { Bar, Canvas, Empty, Pane, Text, Workspace } from "@k2b/ui/v2";
import type { JSX } from "solid-js";

export type PageErrorScreenProps = {
  status: number;
  title: string;
  description: string;
  action: { label: string; href: string; icon?: string };
  /** The status in words for the head, such as "Fehler 404". */
  code: string;
  /** The waiting game below the way out, for the generic "not found" and server failures. */
  game?: JSX.Element;
  /** The name of the game's drawing, for assistive technology. */
  gameLabel?: string;
};

/** The sign of a status: a lock for what is not allowed, a compass for what is not there, a warning for a failure. */
const signOf = (status: number) => (status === 403 || status === 401 ? "lock" : status === 404 ? "compass-off" : "alert-triangle");

/**
 * An error page on UI v2, inside the Cloud shell: the title in the head with the status as a quiet note, then one sign,
 * the one sentence that says what is the matter, and the one way out. The waiting game stands below it, where a
 * generic page offers it; the server draws its box at its final size, so nothing moves when the game arrives.
 */
export default function PageErrorScreen(props: PageErrorScreenProps) {
  return (
    <Workspace
      head={
        <Bar
          start={
            <>
              <Text weight="strong">{props.title}</Text>
              <Text type="meta" muted>
                {props.code}
              </Text>
            </>
          }
        />
      }
    >
      {/* named by its status, so a page's own title never stands in an attribute */}
      <Pane label={props.code}>
        <Empty
          icon={signOf(props.status)}
          text={props.description}
          action={{ label: props.action.label, icon: props.action.icon ?? "home", href: props.action.href }}
        />
        {props.game ? <Canvas label={props.gameLabel ?? props.code}>{props.game}</Canvas> : null}
      </Pane>
    </Workspace>
  );
}
