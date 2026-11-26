import { toast, useLocale } from "@k2b/ui";
import { Bar, Button, Chip, Dialog, List, Menu, Notice, Row, Section, Text } from "@k2b/ui/v2";
import { For, Show } from "solid-js";
import type { ShareView } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import type { EntryLinks } from "./entry-history";
import { isHistoryUnavailable } from "./HistoryUnavailable";
import { formatDate, type HistoryEnvironment } from "./history-actions";
import { useHistoryMessages } from "./history-messages";
import type { ShareAccess } from "./ShareHistory";

/**
 * The detail's public links on v2: one row per link, its state and how often it was used as quiet words, never as big
 * figures; revoking is the row's deed behind its "…". The list's own state (its first page, a failed page, more
 * pages) stands under the rows.
 */
export function EntryLinksSection(props: { links: EntryLinks; env: HistoryEnvironment }) {
  const h = useHistoryMessages();
  const list = () => props.links.list();
  return (
    <Show when={props.links.items().length > 0 || list().loading || list().failed}>
      <Section icon="world-share" title={h().publicLink} count={props.links.items().length || undefined}>
        <List label={h().publicLink}>
          <For each={props.links.items()}>{(item) => <LinkRow item={item} env={props.env} links={props.links} />}</For>
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

function LinkRow(props: { item: ShareAccess; env: HistoryEnvironment; links: EntryLinks }) {
  const h = useHistoryMessages();
  const b = useBrowserMessages();
  const locale = useLocale();
  const share = () => props.item.share;
  const data = () => props.item.access.pages()[0];
  const days = () => {
    const period = props.links.period();
    return Math.round((Date.parse(period.to) - Date.parse(period.from)) / 86_400_000) + 1;
  };
  // how often it was used, in words; a link without counts says why
  const use = () => {
    const counts = data();
    if (counts) return h().v2LinkUse({ pages: counts.pages, downloads: counts.downloads, days: days() });
    const error = props.item.access.error();
    if (error) return isHistoryUnavailable(error) ? "" : h().accessFailed;
    return h().accessLoading;
  };
  // an active link without an end is the rule and says nothing about it
  const ends = () =>
    share().state === "active" && share().expiresAt
      ? h().validUntil.replace("{date}", formatDate(share().expiresAt!, locale(), props.env))
      : "";
  const by = () => (props.item.creatorName ? h().byCreator.replace("{name}", props.item.creatorName) : "");
  const revoke = async (link: ShareView) => {
    const confirmed = await Dialog.confirm({
      title: b().v2RevokeTitle({ name: link.title }),
      description: b().revokeQuestion,
      confirm: b().revoke,
    });
    if (!confirmed) return;
    try {
      await props.links.revoke(link);
      toast.success(b().revoked);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : b().revokeFailed);
    }
  };
  return (
    <Row
      mark={{ icon: share().kind === "inbox" ? "inbox" : "link" }}
      lines={[share().title, [by(), ends(), use()].filter(Boolean).join(" · ")]}
      action={
        props.item.access.error() && !isHistoryUnavailable(props.item.access.error())
          ? { label: h().retry, icon: "refresh", onClick: () => void props.item.access.refresh() }
          : undefined
      }
      end={
        <Show
          when={share().state === "active"}
          fallback={
            <Chip status={share().state === "expired" ? "warn" : "bad"}>{share().state === "expired" ? h().expired : h().revoked}</Chip>
          }
        >
          <Menu
            label={b().v2DeedsFor({ name: share().title })}
            items={[{ label: h().revokeLink, icon: "link-off", danger: true, onClick: () => void revoke(share()) }]}
          />
        </Show>
      }
    />
  );
}
