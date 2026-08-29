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

function ContactOrgTreeNode(props: {
  node: ContactTreeNode;
  selectedId: string;
  depth: number;
  isFirst: boolean;
  isLast: boolean;
  onSelect: (node: ContactTreeNode) => void;
}) {
  const locale = useLocale();
  const t = () => detailMessages.resolve([locale()]).t;
  const selected = () => props.node.id === props.selectedId;
  const hasChildren = () => props.node.children.length > 0;
  const lineColor = "border-[var(--ui-divider)]";

  return (
    <li class="relative">
      <Show when={props.depth > 0}>
        <span class="absolute left-0 top-0 bottom-0 w-4" aria-hidden="true">
          <span
            class={`absolute left-0 border-l ${lineColor} ${
              props.isFirst ? "top-0" : "-top-1"
            } ${props.isLast ? (props.isFirst ? "h-5" : "h-6") : "bottom-[-0.25rem]"}`}
          />
          <span class={`absolute left-0 top-5 w-4 border-t ${lineColor}`} />
        </span>
      </Show>
      <div class={`relative flex items-start ${props.depth > 0 ? "pl-5" : ""}`}>
        <button
          type="button"
          class={`group relative flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
            selected() ? "bg-[var(--ui-selected)] text-primary" : "text-primary hover:bg-[var(--ui-hover)]"
          }`}
          onClick={() => props.onSelect(props.node)}
          aria-current={selected() ? "true" : undefined}
        >
          <span class="contact-avatar flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
            {(resolveContactName(props.node) || "?").charAt(0).toUpperCase()}
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-[13px] font-semibold leading-tight">{resolveContactName(props.node)}</span>
            <Show when={nodeMeta(props.node)}>
              <span class="block truncate text-[11px] leading-tight text-dimmed">{nodeMeta(props.node)}</span>
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
      </div>
      <Show when={hasChildren()}>
        <div class={props.depth === 0 ? "ml-3.5 pl-3.5" : "ml-9 pl-3.5"}>
          <ul class="mt-1 flex flex-col gap-1">
            <For each={props.node.children}>
              {(child, index) => (
                <ContactOrgTreeNode
                  node={child}
                  selectedId={props.selectedId}
                  depth={props.depth + 1}
                  isFirst={index() === 0}
                  isLast={index() === props.node.children.length - 1}
                  onSelect={props.onSelect}
                />
              )}
            </For>
          </ul>
        </div>
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
              <ContactOrgTreeNode
                node={props.tree.root}
                selectedId={props.tree.selectedId}
                depth={0}
                isFirst={true}
                isLast={true}
                onSelect={props.onSelect}
              />
            </ul>
          </DetailPanel.Section>
        </DetailPanel.Group>
      </DetailPanel.Body>
    </DetailPanel>
  );
}
