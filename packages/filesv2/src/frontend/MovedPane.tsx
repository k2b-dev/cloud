import { useLocale } from "@k2b/ui";
import { type Action, Button, List, Notice, type OnNavigate, Pane, Row } from "@k2b/ui/v2";
import { createMemo, type JSX } from "solid-js";
import { entryMark } from "./entry-mark";
import {
  actorOf,
  actorParts,
  fill,
  formatWhen,
  type HistoryEnvironment,
  type HistoryTarget,
  type Part,
  placeOf,
  plain,
} from "./history-actions";
import { useHistoryMessages } from "./history-messages";
import { SentenceText } from "./history-v2";
import type { MovedSnapshot } from "./workspace-state";

/**
 * An old folder address whose folder the reader saw move away: where it is now, who moved it when, the way there and
 * its history. Shown instead of "not found"; never a silent redirect, since a bookmark should be updated.
 */
export default function MovedPane(props: {
  moved: MovedSnapshot;
  /** The old address as the person reads it: the storage, then the folders down to the opened one. */
  oldAddress: readonly string[];
  env: HistoryEnvironment;
  onOpen: (target: HistoryTarget) => void;
  historyHref: string;
  onNavigate?: OnNavigate;
  /** What the folder holds at its new place, under the card. */
  children?: JSX.Element;
}) {
  const h = useHistoryMessages();
  const locale = useLocale();
  const name = () => props.oldAddress.at(-1) ?? props.moved.path.split("/").at(-1) ?? props.moved.path;
  const actor = createMemo(() => actorOf(props.moved.entry, h(), props.env));
  const now = (): Part[] => {
    const point = props.moved.chain.endpoint;
    // A null endpoint can mean hidden, missing or interrupted evidence; it does not prove a current place.
    if (!point) return fill(h().chainFailed, {});
    const path: Part[] = [{ kind: "place", segments: placeOf(props.env, { kind: "endpoint", endpoint: point }) }];
    return fill(props.moved.chain.certainty === "verified" ? h().v2MovedNow : h().v2MovedProbably, { path });
  };
  // who and when as the folder's entries below say it: "Jana Krüger, heute, 13:00"
  const why = () =>
    fill(h().v2MovedWhen, {
      // plain, as the entries below name their authors
      actor: plain(actorParts(actor(), h())),
      when: formatWhen(props.moved.entry.time, locale(), h(), props.env),
    });
  const history = (): Action => ({ label: h().viewHistory, icon: "history", href: props.historyHref, onNavigate: props.onNavigate });
  const jump = (): Action | undefined => {
    const point = props.moved.chain.endpoint;
    return point
      ? { label: h().jumpThere, icon: "arrow-right", onClick: () => props.onOpen({ kind: "endpoint", endpoint: point }) }
      : undefined;
  };
  const mark = entryMark({ name: name(), directory: true });
  return (
    <Pane label={h().movedTitleFolder}>
      {/* Say it once (Valentin 26.11.): the note says that the folder moved and what that means for the bookmark; the
          row says where it is now and who moved it when, with the way there and its history; the old place is the
          head's path. */}
      <Notice tone="note">{h().v2MovedNote}</Notice>
      <List label={h().movedTitleFolder}>
        <Row
          mark={mark}
          lines={[<SentenceText parts={now()} />, <SentenceText parts={why()} />]}
          action={jump()}
          end={<Button variant="ghost" icon="history" label={history().label} href={history().href} onNavigate={props.onNavigate} />}
        />
      </List>
      {props.children}
    </Pane>
  );
}
