import { Button, DetailPanel, useLocale } from "@k2b/ui";
import { For, Show } from "solid-js";
import type { ContactTree, ContactTreeNode } from "../../service";
import { resolveContactName } from "../../shared";
import { detailMessages } from "./detail-messages";

type Props = {
  tree: ContactTree;
  onSelect: (node: ContactTreeNode) => void;
  onBack: () => void;
};

const nodeMeta = (node: ContactTreeNode) => [node.companyName, node.jobTitle].filter(Boolean).join(" · ");

function ContactOrgTreeNode(props: { node: ContactTreeNode; selectedId: string; onSelect: (node: ContactTreeNode) => void }) {
  const locale = useLocale();
  const t = () => detailMessages.resolve([locale()]).t;
  const selected = () => props.node.id === props.selectedId;
  const hasChildren = () => props.node.children.length > 0;

  return (
    <li>
      <button
        type="button"
        class={`group relative flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
          selected() ? "bg-[var(--ui-app-selected)] app-accent-text" : "text-primary hover:bg-[var(--ui-hover)]"
        }`}
        onClick={() => props.onSelect(props.node)}
        aria-current={selected() ? "true" : undefined}
      >
        <span class="contact-avatar flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
          {(resolveContactName(props.node) || "?").charAt(0).toUpperCase()}
        </span>
        <span class="min-w-0 flex-1">
          <span class="block k2b-truncate-fade text-[13px] font-semibold leading-tight">{resolveContactName(props.node)}</span>
          <Show when={nodeMeta(props.node)}>
            <span class="block k2b-truncate-fade text-[11px] leading-tight text-dimmed">{nodeMeta(props.node)}</span>
          </Show>
        </span>
        <Show when={hasChildren()}>
          <span
            class={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
              selected() ? "bg-[var(--ui-active)] text-primary" : "bg-[var(--ui-surface-subtle)] text-dimmed"
            }`}
            title={t().directReports({ count: props.node.children.length })}
          >
            {props.node.children.length}
            <i class="ti ti-users text-[10px]" aria-hidden="true" />
          </span>
        </Show>
      </button>
      <Show when={hasChildren()}>
        {/* Each level indents its reports under the parent's name; the indentation alone draws the hierarchy. */}
        <ul class="mt-1 flex flex-col gap-1 pl-9">
          <For each={props.node.children}>
            {(child) => <ContactOrgTreeNode node={child} selectedId={props.selectedId} onSelect={props.onSelect} />}
          </For>
        </ul>
      </Show>
    </li>
  );
}

export default function ContactOrgTreeView(props: Props) {
  const locale = useLocale();
  const t = () => detailMessages.resolve([locale()]).t;
  return (
    <DetailPanel>
      <DetailPanel.Header
        icon="ti ti-hierarchy"
        title={t().orgTree}
        subtitle={t().hierarchyOfThisContact}
        actions={
          <Button type="button" variant="secondary" size="sm" onClick={props.onBack}>
            <i class="ti ti-arrow-left" aria-hidden="true" /> {t().details}
          </Button>
        }
      />
      <DetailPanel.Body scrollPreserveKey="contacts-org-tree">
        <DetailPanel.Group label={t().organizationContext}>
          <DetailPanel.Section title={t().hierarchy} icon="ti ti-sitemap" tone="accent">
            <ul class="flex flex-col gap-1">
              <ContactOrgTreeNode node={props.tree.root} selectedId={props.tree.selectedId} onSelect={props.onSelect} />
            </ul>
          </DetailPanel.Section>
        </DetailPanel.Group>
      </DetailPanel.Body>
    </DetailPanel>
  );
}
