import {
  Button,
  DateRangePicker,
  ImageInput,
  MarkdownView,
  NoticeCard,
  Placeholder,
  prompts,
  SegmentedControl,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import type { PublicSection, PublicSectionInput } from "../../../contracts";
import { venueMessages, type VenueMessages } from "../../../messages";
import { DialogFrame } from "./schedule";

type MenuItemDraft = {
  id: string;
  name: string;
  description: string;
  info: string;
  price: string;
  image: string | null;
  availableFrom: string | null;
  availableUntil: string | null;
};

type LinkDraft = {
  id: string;
  label: string;
  href: string;
};

export const sectionKindIcon = (kind: PublicSection["kind"]): string => {
  if (kind === "menu") return "ti ti-tools-kitchen-2";
  if (kind === "notice") return "ti ti-speakerphone";
  if (kind === "links") return "ti ti-link";
  return "ti ti-markdown";
};

const sectionText = (section: PublicSection, key: "markdown" | "text"): string => {
  const value = section.content[key];
  return typeof value === "string" ? value : "";
};

const readMenuItems = (section: PublicSection | null): MenuItemDraft[] => {
  const items = Array.isArray(section?.content.items) ? section.content.items : [];
  return items
    .map((raw, index) => {
      const item = raw as Record<string, unknown>;
      return {
        id: String(index + 1),
        name: String(item.name ?? ""),
        description: String(item.description ?? ""),
        info: String(item.info ?? item.allergens ?? ""),
        price: String(item.price ?? ""),
        image: typeof item.image === "string" ? item.image : null,
        availableFrom: typeof item.availableFrom === "string" ? item.availableFrom : null,
        availableUntil: typeof item.availableUntil === "string" ? item.availableUntil : null,
      };
    })
    .filter((item) => item.name || item.description || item.info || item.price || item.image);
};

const readLinks = (section: PublicSection | null): LinkDraft[] => {
  const links = Array.isArray(section?.content.links) ? section.content.links : [];
  return links
    .map((raw, index) => {
      const link = raw as Record<string, unknown>;
      return {
        id: String(index + 1),
        label: String(link.label ?? ""),
        href: String(link.href ?? ""),
      };
    })
    .filter((link) => link.label || link.href);
};

const menuContent = (items: MenuItemDraft[]) => ({
  items: items
    .map((item) => ({
      name: item.name.trim(),
      description: item.description.trim(),
      info: item.info.trim(),
      price: item.price.trim(),
      image: item.image || null,
      availableFrom: item.availableFrom,
      availableUntil: item.availableUntil,
    }))
    .filter((item) => item.name),
});

const linksContent = (links: LinkDraft[]) => ({
  links: links.map((link) => ({ label: link.label.trim(), href: link.href.trim() })).filter((link) => link.label && link.href),
});

const buildPublicSectionContent = (
  kind: PublicSection["kind"],
  text: string,
  items: MenuItemDraft[],
  links: LinkDraft[],
  t: VenueMessages,
): { content: PublicSectionInput["content"]; error: null } | { content: null; error: string } => {
  if (kind === "menu") {
    const invalidRange = items.find((item) => item.availableFrom && item.availableUntil && item.availableFrom > item.availableUntil);
    if (invalidRange) {
      return { content: null, error: t.menuAvailabilityInvalid({ name: invalidRange.name.trim() || t.item }) };
    }
    const content = menuContent(items);
    return content.items.length > 0 ? { content, error: null } : { content: null, error: t.addMenuItemRequired };
  }

  if (kind === "links") {
    const content = linksContent(links);
    return content.links.length > 0 ? { content, error: null } : { content: null, error: t.addLinkRequired };
  }

  return { content: { markdown: text, text }, error: null };
};

export function PublicSectionDialog(props: {
  close: (value: PublicSectionInput | null) => void;
  nextPosition: number;
  initial?: PublicSection;
  title?: string;
  submitLabel?: string;
}) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  let nextItemId = 1;
  const newItem = (): MenuItemDraft => ({
    id: String(nextItemId++),
    name: "",
    description: "",
    info: "",
    price: "",
    image: null,
    availableFrom: null,
    availableUntil: null,
  });
  let nextLinkId = 1;
  const newLink = (): LinkDraft => ({ id: String(nextLinkId++), label: "", href: "" });
  const initialItems = readMenuItems(props.initial ?? null);
  const initialLinks = readLinks(props.initial ?? null);
  nextItemId = initialItems.length + 1;
  nextLinkId = initialLinks.length + 1;
  const [kind, setKind] = createSignal<PublicSection["kind"]>(props.initial?.kind ?? "markdown");
  const [title, setTitle] = createSignal(props.initial?.title ?? "");
  const [contentText, setContentText] = createSignal(
    props.initial ? sectionText(props.initial, props.initial.kind === "markdown" ? "markdown" : "text") : "",
  );
  const [items, setItems] = createStore<MenuItemDraft[]>(initialItems.length > 0 ? initialItems : [newItem()]);
  const [links, setLinks] = createStore<LinkDraft[]>(initialLinks.length > 0 ? initialLinks : [newLink()]);

  const updateItem = (id: string, patch: Partial<MenuItemDraft>) => {
    const index = items.findIndex((item) => item.id === id);
    if (index >= 0) setItems(index, patch);
  };
  const updateLink = (id: string, patch: Partial<LinkDraft>) => {
    const index = links.findIndex((link) => link.id === id);
    if (index >= 0) setLinks(index, patch);
  };

  const addItem = () => setItems(items.length, newItem());
  const removeItem = (id: string) => {
    if (items.length > 1) setItems(items.filter((item) => item.id !== id));
  };
  const addLink = () => setLinks(links.length, newLink());
  const removeLink = (id: string) => {
    if (links.length > 1) setLinks(links.filter((link) => link.id !== id));
  };

  const submit = () => {
    if (!title().trim()) {
      prompts.error(t().titleRequired);
      return;
    }

    const result = buildPublicSectionContent(kind(), contentText(), Array.from(items), Array.from(links), t());
    if (result.error || !result.content) {
      prompts.error(result.error ?? t().sectionInvalid);
      return;
    }

    props.close({
      kind: kind(),
      title: title().trim(),
      content: result.content,
      enabled: true,
      position: props.nextPosition,
    });
  };

  return (
    <DialogFrame
      title={props.title ?? t().addPublicSection}
      icon={sectionKindIcon(kind())}
      submitLabel={props.submitLabel ?? t().addSection}
      onCancel={() => props.close(null)}
      onSubmit={submit}
    >
      <div class="grid gap-3">
        <Show
          when={!props.initial}
          fallback={
            <div class="flex items-center gap-2 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-secondary dark:bg-zinc-900">
              <i class={sectionKindIcon(kind())} />
              <span>{t().sectionKind({ kind: kind()[0]?.toUpperCase() + kind().slice(1) })}</span>
            </div>
          }
        >
          <SegmentedControl
            value={kind}
            onValueChange={setKind}
            options={[
              { value: "markdown", label: t().markdown, icon: "ti ti-markdown" },
              { value: "menu", label: t().menu, icon: "ti ti-tools-kitchen-2" },
              { value: "notice", label: t().notice, icon: "ti ti-speakerphone" },
              { value: "links", label: t().links, icon: "ti ti-link" },
            ]}
          />
        </Show>
        <TextInput label={t().title} description={t().sectionTitleDescription} value={title} onValueChange={setTitle} required />
        <Show
          when={kind() === "menu"}
          fallback={
            <Show
              when={kind() === "links"}
              fallback={
                <TextInput
                  label={t().content}
                  description={t().contentDescription}
                  value={contentText}
                  onValueChange={setContentText}
                  multiline
                  markdown={kind() === "markdown"}
                  lines={8}
                />
              }
            >
              <div class="grid gap-2">
                <For each={links}>
                  {(link, index) => (
                    <div class="paper p-3">
                      <div class="mb-3 flex items-center justify-between gap-2">
                        <p class="text-xs font-semibold uppercase tracking-wide text-dimmed">{t().linkNumber({ count: index() + 1 })}</p>
                        <Button type="button" variant="secondary" size="xs" onClick={() => removeLink(link.id)}>
                          <i class="ti ti-trash" /> {t().remove}
                        </Button>
                      </div>
                      <div class="grid gap-3 sm:grid-cols-2">
                        <TextInput
                          label={t().label}
                          description={t().linkLabelDescription}
                          value={() => link.label}
                          onValueChange={(value) => updateLink(link.id, { label: value })}
                          required
                        />
                        <TextInput
                          label={t().url}
                          description={t().linkUrlDescription}
                          value={() => link.href}
                          onValueChange={(value) => updateLink(link.id, { href: value })}
                          placeholder="https://example.com"
                          required
                        />
                      </div>
                    </div>
                  )}
                </For>
                <Button type="button" variant="secondary" size="sm" class="justify-center" onClick={addLink}>
                  <i class="ti ti-plus" /> {t().addLink}
                </Button>
              </div>
            </Show>
          }
        >
          <div class="grid gap-2">
            <For each={items}>
              {(item, index) => (
                <div class="paper p-3">
                  <div class="mb-3 flex items-center justify-between gap-2">
                    <p class="text-xs font-semibold uppercase tracking-wide text-dimmed">{t().itemNumber({ count: index() + 1 })}</p>
                    <Button type="button" variant="secondary" size="xs" onClick={() => removeItem(item.id)}>
                      <i class="ti ti-trash" /> {t().remove}
                    </Button>
                  </div>
                  <div class="grid gap-3">
                    <ImageInput
                      label={t().image}
                      description={t().menuImageDescription}
                      value={() => item.image}
                      onValueChange={(value) => updateItem(item.id, { image: value })}
                      variant="small"
                    />
                    <div class="grid gap-3 sm:grid-cols-2">
                      <TextInput
                        label={t().name}
                        description={t().menuNameDescription}
                        value={() => item.name}
                        onValueChange={(value) => updateItem(item.id, { name: value })}
                        required
                      />
                      <TextInput
                        label={t().price}
                        description={t().priceDescription}
                        value={() => item.price}
                        onValueChange={(value) => updateItem(item.id, { price: value })}
                      />
                    </div>
                    <TextInput
                      label={t().description}
                      description={t().menuDescription}
                      value={() => item.description}
                      onValueChange={(value) => updateItem(item.id, { description: value })}
                      multiline
                      lines={2}
                    />
                    <TextInput
                      label={t().allergens}
                      description={t().allergensDescription}
                      value={() => item.info}
                      onValueChange={(value) => updateItem(item.id, { info: value })}
                      placeholder={t().containsNuts}
                    />
                    <DateRangePicker
                      label={t().availability}
                      description={t().availabilityDescription}
                      value={() => ({ start: item.availableFrom, end: item.availableUntil })}
                      onValueChange={(value) => updateItem(item.id, { availableFrom: value.start, availableUntil: value.end })}
                      clearable
                    />
                  </div>
                </div>
              )}
            </For>
            <Button type="button" variant="secondary" size="sm" class="justify-center" onClick={addItem}>
              <i class="ti ti-plus" /> {t().addMenuItem}
            </Button>
          </div>
        </Show>
      </div>
    </DialogFrame>
  );
}

export function PublicSectionPreview(props: { section: PublicSection }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const items = () => (Array.isArray(props.section.content.items) ? props.section.content.items : []);
  const links = () => (Array.isArray(props.section.content.links) ? props.section.content.links : []);

  return (
    <div class="grid gap-3">
      <Show when={props.section.kind === "markdown"}>
        <MarkdownView markdown={sectionText(props.section, "markdown")} class="text-sm" headingScale="compact" />
      </Show>
      <Show when={props.section.kind === "notice"}>
        <NoticeCard tone="warning" icon={false}>
          {sectionText(props.section, "text") || sectionText(props.section, "markdown") || t().noNoticeText}
        </NoticeCard>
      </Show>
      <Show when={props.section.kind === "links"}>
        <div class="grid gap-2">
          <For
            each={links()}
            fallback={<Placeholder align="left" class="px-0 py-2" description={<>{sectionText(props.section, "text") || t().noLinks}</>} />}
          >
            {(raw) => {
              const link = raw as Record<string, unknown>;
              return (
                <a class="paper flex items-center gap-3 p-3 no-underline hover:paper-highlighted" href={String(link.href ?? "#")}>
                  <i class="ti ti-link text-dimmed" />
                  <span class="min-w-0 flex-1 truncate text-sm font-medium text-primary">
                    {String(link.label ?? link.href ?? t().links)}
                  </span>
                  <i class="ti ti-external-link text-dimmed" />
                </a>
              );
            }}
          </For>
        </div>
      </Show>
      <Show when={props.section.kind === "menu"}>
        <div class="grid gap-2">
          <For each={items()} fallback={<Placeholder align="left" class="px-0 py-2" description={<>{t().noMenuItems}</>} />}>
            {(raw) => {
              const item = raw as Record<string, unknown>;
              const image = typeof item.image === "string" ? item.image : "";
              return (
                <div class="px-1 py-2 text-sm">
                  <div class="flex items-start justify-between gap-3">
                    <Show when={image}>
                      <img src={image} alt="" class="h-14 w-14 shrink-0 rounded-lg object-cover" />
                    </Show>
                    <div class="min-w-0 flex-1">
                      <p class="font-medium text-primary">{String(item.name ?? t().item)}</p>
                      <Show when={item.description}>
                        <p class="text-xs text-dimmed">{String(item.description)}</p>
                      </Show>
                      <Show when={item.info || item.allergens}>
                        <p class="mt-1 text-xs text-dimmed">({String(item.info ?? item.allergens)})</p>
                      </Show>
                    </div>
                    <span class="shrink-0 text-sm font-semibold text-primary">{String(item.price ?? "")}</span>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
