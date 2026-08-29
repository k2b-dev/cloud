import {
  CopyButton,
  DescriptionList,
  DetailPanel,
  Disclosure,
  IconButtonLink,
  isStructuredDataValue,
  Placeholder,
  StructuredDataPreview,
  useLocale,
} from "@k2b/ui";
import type {
  CapabilityPage,
  CapabilitySemanticLink,
  CloudResourceRef,
  CloudResourceView,
  UniversalSearchData,
} from "@valentinkolb/cloud/contracts";
import { For, Show } from "solid-js";
import type { SelectedCapability } from "../catalog";
import { resolveCapabilityDataPresentation } from "../result-presentation";
import { capabilityUiMessages } from "./messages";

const linkIcon = (link: CapabilitySemanticLink): string => {
  if (link.rel === "edit") return "ti ti-pencil";
  if (link.rel === "download") return "ti ti-download";
  if (link.rel === "preview") return "ti ti-eye";
  if (link.rel === "status") return "ti ti-activity";
  return "ti ti-arrow-up-right";
};

const linkLabel = (link: CapabilitySemanticLink, locale: string): string => {
  const t = capabilityUiMessages.resolve([locale]).t;
  if (link.title) return link.title;
  if (link.rel === "edit") return t.edit;
  if (link.rel === "download") return t.download;
  if (link.rel === "preview") return t.preview;
  if (link.rel === "status") return t.viewStatus;
  return t.open;
};

const primaryLink = (item: CloudResourceView): CapabilitySemanticLink =>
  item.links.find((link) => link.rel === "open") ??
  item.links.find((link) => link.rel === "preview") ??
  item.links.find((link) => link.rel === "edit") ??
  item.links[0]!;

function SearchResultRow(props: { item: CloudResourceView }) {
  const locale = useLocale();
  const primary = primaryLink(props.item);
  const secondaryLinks = props.item.links.filter((link) => link !== primary);

  return (
    <li class="group flex min-w-0 items-start gap-3 py-2">
      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-dimmed">
        <i class={`${props.item.icon ?? "ti ti-cube"} text-base`} aria-hidden="true" />
      </span>

      <div class="min-w-0 flex-1">
        <div class="flex min-w-0 items-start justify-between gap-2">
          <div class="min-w-0">
            <a href={primary.href} class="block truncate text-sm font-semibold text-primary transition-colors group-hover:app-accent-text">
              {props.item.title}
            </a>
            <Show when={props.item.preview}>
              {(preview) => <p class="mt-0.5 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-secondary">{preview()}</p>}
            </Show>
          </div>
          <IconButtonLink href={primary.href} class="shrink-0" size="sm" label={`${linkLabel(primary, locale())} ${props.item.title}`}>
            <i class={linkIcon(primary)} aria-hidden="true" />
          </IconButtonLink>
        </div>

        <Show when={props.item.metadata?.length}>
          <dl class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            <For each={props.item.metadata}>
              {(entry) => (
                <div class="flex min-w-0 gap-1">
                  <dt class="text-dimmed">{entry.label}</dt>
                  <dd class="max-w-64 truncate text-secondary" title={entry.value}>
                    {entry.value}
                  </dd>
                </div>
              )}
            </For>
          </dl>
        </Show>

        <div class="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-dimmed">
          <code class="min-w-0 truncate" title={`${props.item.ref.type}:${props.item.ref.id}`}>
            {props.item.ref.type} · {props.item.ref.id}
          </code>
          <CopyButton
            text={`${props.item.ref.type}:${props.item.ref.id}`}
            class="focus-ui inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] transition-colors hover:bg-[var(--ui-hover)] hover:text-secondary"
          />
          <For each={secondaryLinks}>
            {(link) => (
              <a href={link.href} class="inline-flex items-center gap-1 text-secondary transition-colors hover:app-accent-text">
                <i class={linkIcon(link)} aria-hidden="true" />
                {linkLabel(link, locale())}
              </a>
            )}
          </For>
        </div>
      </div>
    </li>
  );
}

function UniversalSearchResults(props: { items: UniversalSearchData }) {
  const locale = useLocale();
  const t = () => capabilityUiMessages.resolve([locale()]).t;
  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-baseline justify-between gap-3">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-dimmed">{t().results}</h3>
        <span class="text-xs tabular-nums text-dimmed">{t().resourceCount({ count: props.items.length })}</span>
      </div>

      <Show
        when={props.items.length > 0}
        fallback={
          <Placeholder
            icon="ti ti-search-off"
            title={t().noResults}
            description={t().noResultsDescription}
          />
        }
      >
        <ul class="flex flex-col gap-1">
          <For each={props.items}>{(item) => <SearchResultRow item={item} />}</For>
        </ul>
      </Show>

      <Disclosure summary={t().rawResult} icon="ti ti-braces">
        <StructuredDataPreview data={props.items} defaultMode="raw" />
      </Disclosure>
    </div>
  );
}

function ResourceReferences(props: { refs: CloudResourceRef[] }) {
  const locale = useLocale();
  const t = () => capabilityUiMessages.resolve([locale()]).t;
  return (
    <div class="flex flex-col gap-2">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-dimmed">{t().refs}</h3>
      <DescriptionList
        layout="rows"
        size="sm"
        actionVisibility="always"
        items={props.refs.map((ref) => ({
          term: ref.type,
          description: (
            <code class="block min-w-0 truncate text-[11px] text-secondary" title={`${ref.type}:${ref.id}`}>
              {ref.id}
            </code>
          ),
          action: <CopyButton text={`${ref.type}:${ref.id}`} />,
        }))}
      />
    </div>
  );
}

function PageSummary(props: { page: CapabilityPage }) {
  const locale = useLocale();
  const t = () => capabilityUiMessages.resolve([locale()]).t;
  return (
    <div class="flex items-start gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-3 py-2.5">
      <i class={`ti ${props.page.hasMore ? "ti-list-details" : "ti-check"} mt-0.5 text-dimmed`} aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="text-xs font-medium text-secondary">{props.page.hasMore ? t().moreResults : t().finalPage}</p>
        <Show when={props.page.hasMore ? props.page.nextCursor : undefined}>
          {(cursor) => <code class="mt-0.5 block truncate text-[10px] text-dimmed">{t().cursor}: {cursor()}</code>}
        </Show>
      </div>
      <Show when={props.page.hasMore ? props.page.nextCursor : undefined}>
        {(cursor) => <CopyButton text={cursor()} label={t().copyCursor} />}
      </Show>
    </div>
  );
}

function SemanticLinks(props: { links: CapabilitySemanticLink[] }) {
  const locale = useLocale();
  const t = () => capabilityUiMessages.resolve([locale()]).t;
  return (
    <div class="flex flex-col gap-2">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-dimmed">{t().links}</h3>
      <div class="flex flex-col gap-1">
        <For each={props.links}>
          {(link) => (
            <DetailPanel.Action
              href={link.href}
              leading={<i class={linkIcon(link)} aria-hidden="true" />}
              title={linkLabel(link, locale())}
              description={link.href}
              trailing={<i class="ti ti-arrow-up-right" aria-hidden="true" />}
            />
          )}
        </For>
      </div>
    </div>
  );
}

export default function CapabilityResultView(props: {
  selection: SelectedCapability;
  data: unknown;
  refs?: CloudResourceRef[];
  page?: CapabilityPage;
  links?: CapabilitySemanticLink[];
}) {
  const locale = useLocale();
  const t = () => capabilityUiMessages.resolve([locale()]).t;
  const presentation = () => resolveCapabilityDataPresentation(props.selection, props.data);
  const searchItems = () => {
    const resolved = presentation();
    return resolved.kind === "universal-search" ? resolved.items : undefined;
  };

  return (
    <div class="flex flex-col gap-4">
      <Show
        when={searchItems()}
        fallback={
          <StructuredDataPreview
            title={t().data}
            data={isStructuredDataValue(props.data) ? props.data : { error: t().invalidData }}
            empty={t().noData}
          />
        }
      >
        {(items) => <UniversalSearchResults items={items()} />}
      </Show>
      <Show when={props.refs}>{(refs) => refs().length > 0 && <ResourceReferences refs={refs()} />}</Show>
      <Show when={props.page}>{(page) => <PageSummary page={page()} />}</Show>
      <Show when={props.links}>{(links) => links().length > 0 && <SemanticLinks links={links()} />}</Show>
    </div>
  );
}
