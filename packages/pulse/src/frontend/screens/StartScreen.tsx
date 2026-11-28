import { navigateTo } from "@k2b/ssr/nav";
import { Empty, List, Pane, Section, Text, useToast, Workspace } from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import type { PulseBaseNav } from "../../contracts";
import { usePulseMessages } from "../use-messages";
import { DeletingBase, NewBaseDialog } from "./base-lifecycle";
import { baseHref } from "./base-nav";
import { useScreenMessages } from "./messages";

export type StartScreenProps = {
  /** Bases in deletion the person administers: they follow or resume the deletion here until it finishes. */
  deleting: PulseBaseNav[];
};

/**
 * Pulse before the first base: no sidebar, only the lead line and the way to begin in the middle of the page
 * (approved mockup empty-start-tiles v4). An admin whose bases are being deleted follows them under it.
 */
export default function StartScreen(props: StartScreenProps) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const toast = useToast();
  const [creating, setCreating] = createSignal(false);
  return (
    // the start's one deed stands in the middle of the page on every width, so no main action floats beside it
    <Workspace>
      {/* k2b-ui gap: rows in a centred Pane draw their lines short of the column's edges; with deletions to follow the
          start stands at the top of the column, so their rows reach its edges */}
      <Pane label={words().startLabel} center={props.deleting.length === 0}>
        <Text type="lead">{words().firstBaseLead}</Text>
        {/* k2b-ui gap: start tiles (#4505): Leere Base, Server überwachen, Werte per HTTP senden, Website-Besuche */}
        <Empty
          icon="activity-heartbeat"
          text={t().firstBaseDescription}
          action={{ label: t().newBase, icon: "plus", onClick: () => setCreating(true) }}
        />
        <Show when={props.deleting.length > 0}>
          <Section icon="trash" title={words().deletingTitle} count={props.deleting.length}>
            <List label={words().deletingTitle}>
              <For each={props.deleting}>{(base) => <DeletingBase base={base} />}</For>
            </List>
          </Section>
        </Show>
      </Pane>
      <NewBaseDialog
        open={creating()}
        onOpenChange={setCreating}
        onCreated={(base) => {
          toast(t().baseCreated, { status: "ok" });
          navigateTo(baseHref(base.id));
        }}
      />
    </Workspace>
  );
}
