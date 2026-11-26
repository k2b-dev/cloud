import { useLocale } from "@k2b/ui";
import { type Action, Notice, type OnNavigate, Pane, Row, Section, StatusRow } from "@k2b/ui/v2";
import { createMemo } from "solid-js";
import { entryMark } from "./entry-mark";
import {
  actorOf,
  byParts,
  fill,
  formatDate,
  formatTime,
  type HistoryEnvironment,
  type HistoryTarget,
  type Part,
  placeOf,
} from "./history-actions";
import { useHistoryMessages } from "./history-messages";
import { personOf, SentenceText } from "./history-v2";
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
    return fill(props.moved.chain.certainty === "verified" ? h().movedNow : h().movedProbably, { name: name(), path });
  };
  const why = () =>
    fill(h().whyMoved, {
      date: formatDate(props.moved.entry.time, locale(), props.env),
      time: formatTime(props.moved.entry.time, locale(), props.env),
      by: byParts(actor(), h(), props.env, props.moved.entry),
    });
  const deeds = (): [Action] | [Action, Action] => {
    const history: Action = { label: h().viewHistory, icon: "history", href: props.historyHref, onNavigate: props.onNavigate };
    const point = props.moved.chain.endpoint;
    return point
      ? [{ label: h().jumpThere, icon: "arrow-right", onClick: () => props.onOpen({ kind: "endpoint", endpoint: point }) }, history]
      : [history];
  };
  const mark = entryMark({ name: name(), directory: true });
  return (
    <Pane label={h().movedTitleFolder} status={<StatusRow lead={h().movedTitleFolder} />}>
      <Section icon={mark.icon} color={mark.color} title={name()} actions={deeds()} summary={<SentenceText parts={now()} />}>
        <Row avatar={personOf(actor())} lines={[<SentenceText parts={why()} />, props.oldAddress.join(" › ")]} />
        <Notice tone="note">
          <SentenceText parts={fill(h().bookmarkNote, { path: [{ kind: "place", segments: props.oldAddress }] })} />
        </Notice>
      </Section>
    </Pane>
  );
}
