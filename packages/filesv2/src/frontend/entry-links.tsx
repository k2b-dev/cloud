import { useLocale } from "@k2b/ui";
import { Bar, Button, Chip, List, Notice, type OnNavigate, Row, Section, Text } from "@k2b/ui/v2";
import { For, Show } from "solid-js";
import type { BaseSummary, ShareView } from "../contracts";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import type { EntryLinks } from "./entry-history";
import { storageMark } from "./entry-mark";
import { formatDate, type HistoryEnvironment } from "./history-actions";
import { useHistoryMessages } from "./history-messages";
import { filesUrl } from "./urls";

/**
 * Who reaches the entry, as the Files recipe shows it: the storage's team, then each public link with who made it, how
 * it may be used, when it ends and how often it was opened, and when it was made or why it no longer opens. Links are
 * managed (and revoked) on the shares page the head leads to. The team is one line with what it may do on the right;
 * a link has two, as the recipe's rows do.
 */
export function EntryLinksSection(props: {
  links: EntryLinks;
  env: HistoryEnvironment;
  base: BaseSummary;
  /** The reader may change the entry: the team row says "Bearbeiten", else "Ansehen". */
  writable: boolean;
  onNavigate: OnNavigate;
}) {
  const h = useHistoryMessages();
  const b = useBrowserMessages();
  const locale = useLocale();
  const list = () => props.links.list();
  const team = () => props.base.kind === "groups";
  const count = () => props.links.items().length + (team() ? 1 : 0);
  return (
    <Show when={count() > 0 || list().loading || list().failed}>
      <Section
        icon="share"
        title={b().v2Sharing}
        count={count() || undefined}
        actions={[{ label: b().v2Manage, href: `${filesUrl(props.base.id)}&view=shares`, onNavigate: props.onNavigate }]}
      >
        <List label={b().v2Sharing}>
          <Show when={team()}>
            <Row
              mark={storageMark(props.base)}
              lines={[b().v2TeamOf({ name: baseLabel(props.base, b(), locale()) })]}
              time={props.writable ? b().edit : b().v2CanView}
            />
          </Show>
          <For each={props.links.items()}>{(item) => <LinkRow share={item.share} creator={item.creatorName} env={props.env} />}</For>
        </List>
        <Show when={list().loading}>
          <Bar start={<Text type="meta">{h().accessLoading}</Text>} />
        </Show>
        <Show when={list().failed}>
          <Notice tone="bad" actions={[{ label: h().retry, onClick: () => void props.links.loadMore() }]}>
            {h().accessFailed}
          </Notice>
        </Show>
        <Show when={list().more && !list().failed}>
          <Bar
            end={
              <Button icon="chevron-down" busy={list().busy} onClick={() => void props.links.loadMore()}>
                {list().label}
              </Button>
            }
          />
        </Show>
      </Section>
    </Show>
  );
}

function LinkRow(props: { share: ShareView; creator: string | null; env: HistoryEnvironment }) {
  const b = useBrowserMessages();
  const h = useHistoryMessages();
  const locale = useLocale();
  const facts = () =>
    [
      props.share.kind === "inbox" ? b().upload : b().v2CanView,
      props.share.state === "active" && props.share.expiresAt
        ? b().v2EndsOn({ date: formatDate(props.share.expiresAt, locale(), props.env) })
        : "",
      b().v2OpenedTimes({ count: props.share.accessCount }),
    ]
      .filter(Boolean)
      .join(" · ");
  // the right column says when an active link was made, or the state of one that no longer opens; a link's address is
  // only shown once, when it is made, so there is nothing to copy here
  return (
    <Row
      avatar={props.creator ? { name: props.creator } : undefined}
      mark={props.creator ? undefined : { icon: "link" }}
      lines={[props.creator ? b().v2LinkBy({ name: props.creator }) : b().shareLink, facts()]}
      time={
        props.share.state === "active" ? (
          <time dateTime={props.share.createdAt}>{formatDate(props.share.createdAt, locale(), props.env)}</time>
        ) : undefined
      }
      end={
        props.share.state === "active" ? undefined : (
          <Chip status={props.share.state === "expired" ? "warn" : "bad"}>
            {props.share.state === "expired" ? h().expired : h().revoked}
          </Chip>
        )
      }
    />
  );
}
