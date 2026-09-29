import { dates } from "@k2b/stdlib";
import { LinkCard, MarkdownView, NoticeCard, Paper, Placeholder, useLocale } from "@k2b/ui";
import { For, type JSX, Match, Show, Switch } from "solid-js";
import { type PublicMenuItem, PublicMenuItemSchema, type PublicSection } from "../../contracts";
import { venueMessages } from "../../messages";
import { isPublicMenuItemAvailable } from "../../public-menu";

const sectionText = (section: PublicSection, key: "markdown" | "text"): string => {
  const value = section.content[key];
  return typeof value === "string" ? value : "";
};

/** Link schemes a visitor can follow safely; anything else, such as `javascript:`, never becomes a link. */
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

type PublicLink = { label: string; href: string; target: string };

/** The section's links that visitors can follow, each with the address it leads to. */
const publicLinks = (section: PublicSection): PublicLink[] =>
  (Array.isArray(section.content.links) ? section.content.links : []).flatMap((raw) => {
    const link = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    if (typeof link.href !== "string") return [];
    let url: URL;
    try {
      url = new URL(link.href.trim());
    } catch {
      return [];
    }
    if (!SAFE_LINK_PROTOCOLS.has(url.protocol)) return [];
    const target = url.protocol === "http:" || url.protocol === "https:" ? url.host : url.href.slice(url.protocol.length);
    const label = typeof link.label === "string" && link.label.trim() ? link.label.trim() : target;
    return [{ label, href: url.href, target }];
  });

/** Menu items available on the Venue-local date: the public page shows only these. */
const availableMenuItems = (section: PublicSection, date: string): PublicMenuItem[] =>
  (Array.isArray(section.content.items) ? section.content.items : []).flatMap((raw) => {
    const parsed = PublicMenuItemSchema.safeParse(raw);
    return parsed.success && isPublicMenuItemAvailable(parsed.data, date) ? [parsed.data] : [];
  });

function SectionHeading(props: { children: JSX.Element }) {
  return <h2 class="text-base font-semibold text-primary">{props.children}</h2>;
}

/**
 * One public section as visitors see it. The public page and the workspace preview both render this, so the
 * preview cannot drift from what the page shows: notices stand out, menu items outside their availability dates
 * stay hidden, and links only lead to web, mail, or phone addresses. `timeZone` is the Venue's, which decides
 * what "today" means for menu availability.
 */
export function PublicSectionView(props: { section: PublicSection; timeZone: string }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const today = () => dates.formatDateKey(new Date(), { timeZone: props.timeZone });

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
            each={publicLinks(props.section)}
            fallback={
              <Paper class="p-4 text-sm text-secondary">
                <p>{sectionText(props.section, "text") || t().noLinks}</p>
              </Paper>
            }
          >
            {(link) => <LinkCard href={link.href} title={link.label} description={link.target} icon="ti ti-link" />}
          </For>
        </section>
      </Match>
      <Match when={props.section.kind === "menu"}>
        <Paper as="section" class="grid gap-3 p-4 sm:p-5" data-section-kind="menu">
          <SectionHeading>{props.section.title}</SectionHeading>
          <For
            each={availableMenuItems(props.section, today())}
            // The public page leaves such a menu out; only the workspace preview reaches this.
            fallback={<Placeholder align="left" class="px-0 py-2" description={<>{t().noMenuItemsToday}</>} />}
          >
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
