import { dates } from "@k2b/stdlib";
import { InlineGuidance, LinkCard, MarkdownView, NoticeCard, Paper, Placeholder, useLocale } from "@k2b/ui";
import { For, type JSX, Match, Show, Switch } from "solid-js";
import { type PublicMenuItem, PublicMenuItemSchema, type PublicSection, publicLinkHref } from "../../contracts";
import { venueMessages } from "../../messages";
import { isPublicMenuItemAvailable } from "../../public-menu";

const sectionText = (section: PublicSection, key: "markdown" | "text"): string => {
  const value = section.content[key];
  return typeof value === "string" ? value : "";
};

const sectionList = (section: PublicSection, key: "items" | "links"): unknown[] => {
  const value = section.content[key];
  return Array.isArray(value) ? value : [];
};

type PublicLink = { label: string; href: string; target: string };

/** What a link card names under its label: the site of a web address, otherwise the address itself. */
const linkTarget = (href: string): string => {
  if (href.startsWith("/")) return href;
  const url = new URL(href);
  return url.protocol === "http:" || url.protocol === "https:" ? url.host : href.slice(url.protocol.length);
};

/** The section's links that visitors can follow, by the same rule that saving a section enforces. */
const publicLinks = (section: PublicSection): PublicLink[] =>
  sectionList(section, "links").flatMap((raw) => {
    const link = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const href = typeof link.href === "string" ? publicLinkHref(link.href) : null;
    if (!href) return [];
    const target = linkTarget(href);
    const label = typeof link.label === "string" && link.label.trim() ? link.label.trim() : target;
    return [{ label, href, target }];
  });

/** The menu's valid items; with a date, only those available on that Venue-local date. */
const menuItems = (section: PublicSection, date?: string): PublicMenuItem[] =>
  sectionList(section, "items").flatMap((raw) => {
    const parsed = PublicMenuItemSchema.safeParse(raw);
    return parsed.success && (!date || isPublicMenuItemAvailable(parsed.data, date)) ? [parsed.data] : [];
  });

function SectionHeading(props: { children: JSX.Element }) {
  return <h2 class="text-base font-semibold text-primary">{props.children}</h2>;
}

/**
 * One public section as visitors see it. The public page and the workspace preview both render this, so the
 * preview cannot drift from what the page shows: notices stand out, and links lead only to web, mail, or phone
 * addresses or to paths on this Cloud. The server leaves out menu items outside their availability dates, and
 * menus without any, before the public page gets its sections; the `preview` gets every item and leaves out the
 * same ones for today in the Venue's `timeZone`. Only the preview says what visitors miss.
 */
export function PublicSectionView(props: { section: PublicSection; timeZone: string; preview?: boolean }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const links = () => publicLinks(props.section);
  const hiddenLinks = () => (props.preview ? sectionList(props.section, "links").length - links().length : 0);
  const items = () => menuItems(props.section, props.preview ? dates.formatDateKey(new Date(), { timeZone: props.timeZone }) : undefined);

  return (
    <Switch>
      <Match when={props.section.kind === "notice"}>
        <NoticeCard tone="warning" icon="ti ti-speakerphone" bodyClass="!text-sm" data-section-kind="notice">
          <SectionHeading>{props.section.title}</SectionHeading>
          <Show when={sectionText(props.section, "text") || sectionText(props.section, "markdown")}>
            {(text) => <p class="mt-1 whitespace-pre-line">{text()}</p>}
          </Show>
        </NoticeCard>
      </Match>
      <Match when={props.section.kind === "links"}>
        <section class="grid gap-2" data-section-kind="links">
          <div class="px-1">
            <SectionHeading>{props.section.title}</SectionHeading>
          </div>
          <For
            each={links()}
            fallback={
              <Paper class="p-4 text-sm text-secondary">
                <p>{sectionText(props.section, "text") || t().noLinks}</p>
              </Paper>
            }
          >
            {(link) => <LinkCard href={link.href} title={link.label} description={link.target} icon="ti ti-link" />}
          </For>
          <Show when={hiddenLinks() > 0}>
            <InlineGuidance tone="warning" icon="ti ti-link-off">
              {t().linksHiddenFromVisitors({ count: hiddenLinks() })}
            </InlineGuidance>
          </Show>
        </section>
      </Match>
      {/* A menu without a current item is left out of the public page; only the preview shows it, and why. */}
      <Match when={props.section.kind === "menu" && (props.preview || items().length > 0)}>
        <Paper as="section" class="grid gap-3 p-4 sm:p-5" data-section-kind="menu">
          <SectionHeading>{props.section.title}</SectionHeading>
          <For each={items()} fallback={<Placeholder align="left" class="px-0 py-2" description={<>{t().noMenuItemsToday}</>} />}>
            {(item) => (
              <div class="flex items-start gap-3" data-menu-item="">
                <Show when={item.image}>{(image) => <img src={image()} alt="" class="size-16 shrink-0 rounded-lg object-cover" />}</Show>
                <div class="min-w-0 flex-1">
                  <div class="flex items-baseline justify-between gap-3">
                    <p class="min-w-0 font-medium text-primary">{item.name}</p>
                    <Show when={item.price}>
                      <span class="shrink-0 text-sm font-semibold tabular-nums text-primary">{item.price}</span>
                    </Show>
                  </div>
                  <Show when={item.description}>
                    <p class="mt-0.5 text-sm text-secondary">{item.description}</p>
                  </Show>
                  <Show when={item.info || item.allergens}>
                    <p class="mt-1 text-xs text-dimmed">({item.info || item.allergens})</p>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </Paper>
      </Match>
      <Match when={props.section.kind === "markdown"}>
        <Paper as="section" class="grid gap-3 p-4 sm:p-5" data-section-kind="markdown">
          <SectionHeading>{props.section.title}</SectionHeading>
          <MarkdownView markdown={sectionText(props.section, "markdown")} class="text-sm" headingScale="compact" />
        </Paper>
      </Match>
    </Switch>
  );
}
