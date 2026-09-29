import { Button, DateRangePicker, ImageInput, SegmentedControl, Switch, TextInput, useLocale } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { type PublicSection, type PublicSectionInput, publicLinkHref } from "../../../contracts";
import { type VenueMessages, venueMessages } from "../../../messages";
import { createDialogSave, DialogFrame, type SubmittingDialogProps } from "./schedule";

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

export const sectionKindLabel = (kind: PublicSection["kind"], t: VenueMessages): string => {
  if (kind === "menu") return t.menu;
  if (kind === "notice") return t.notice;
  if (kind === "links") return t.links;
  return t.markdown;
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

const hasMenuContent = (item: MenuItemDraft) =>
  Boolean(item.name.trim() || item.description.trim() || item.info.trim() || item.price.trim() || item.image);

/** Why each field of the draft cannot be saved, keyed by the field it belongs to; empty when the draft is valid. */
const sectionFieldErrors = (
  draft: { title: string; kind: PublicSection["kind"]; items: MenuItemDraft[]; links: LinkDraft[] },
  t: VenueMessages,
): Record<string, string> => {
  const errors: Record<string, string> = {};
  if (!draft.title.trim()) errors.title = t.titleRequired;
  if (draft.kind === "menu") {
    for (const item of draft.items) {
      if (hasMenuContent(item) && !item.name.trim()) errors[`item:${item.id}:name`] = t.menuItemNameRequired;
      if (item.availableFrom && item.availableUntil && item.availableFrom > item.availableUntil) {
        errors[`item:${item.id}:availability`] = t.menuAvailabilityInvalid({ name: item.name.trim() || t.item });
      }
    }
    const first = draft.items[0];
    if (first && !draft.items.some((item) => item.name.trim())) errors[`item:${first.id}:name`] ??= t.addMenuItemRequired;
  }
  if (draft.kind === "links") {
    for (const link of draft.links) {
      const label = link.label.trim();
      const href = link.href.trim();
      if (href && !publicLinkHref(href)) errors[`link:${link.id}:href`] = t.linkUrlInvalid;
      else if (label && !href) errors[`link:${link.id}:href`] = t.linkRequiredFields;
      if (href && !label) errors[`link:${link.id}:label`] = t.linkRequiredFields;
    }
    const first = draft.links[0];
    if (first && !draft.links.some((link) => link.label.trim() && link.href.trim())) {
      errors[`link:${first.id}:href`] ??= t.addLinkRequired;
    }
  }
  return errors;
};

const buildPublicSectionContent = (
  kind: PublicSection["kind"],
  text: string,
  items: MenuItemDraft[],
  links: LinkDraft[],
): PublicSectionInput["content"] => {
  if (kind === "menu") return menuContent(items);
  if (kind === "links") return linksContent(links);
  return { markdown: text, text };
};

/**
 * Adds or edits one public section and saves it itself: fields say what is missing or wrong after the first
 * attempt to save, and the dialog stays open with its input until the server confirms the save.
 */
export function PublicSectionDialog(
  props: SubmittingDialogProps<PublicSectionInput> & {
    nextPosition: number;
    /** Whether the Venue's public page is on, so the switch says who sees the section. */
    publicPageEnabled: boolean;
    initial?: PublicSection;
    title?: string;
    submitLabel?: string;
  },
) {
  const locale = useLocale();
  const dialog = createDialogSave(props);
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
  // Visibility is its own explicit choice: saving an edit keeps whatever this switch shows.
  const [enabled, setEnabled] = createSignal(props.initial?.enabled ?? true);
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
  // Fields say what is wrong only after the first attempt to save, not while someone is still typing.
  const [attempted, setAttempted] = createSignal(false);
  const errors = () =>
    attempted() ? sectionFieldErrors({ title: title(), kind: kind(), items: Array.from(items), links: Array.from(links) }, t()) : {};
  const fieldError = (key: string) => errors()[key];

  const addLink = () => setLinks(links.length, newLink());
  const removeLink = (id: string) => {
    if (links.length > 1) setLinks(links.filter((link) => link.id !== id));
  };

  const submit = () => {
    setAttempted(true);
    if (Object.keys(errors()).length > 0) return;
    void dialog.save({
      kind: kind(),
      title: title().trim(),
      content: buildPublicSectionContent(kind(), contentText(), Array.from(items), Array.from(links)),
      enabled: enabled(),
      position: props.nextPosition,
    });
  };

  return (
    <DialogFrame
      title={props.title ?? t().addPublicSection}
      icon={sectionKindIcon(kind())}
      submitLabel={props.submitLabel ?? t().addSection}
      onCancel={() => props.close(false)}
      onSubmit={submit}
      pending={dialog.pending()}
      error={dialog.error()}
    >
      <div class="grid gap-3">
        <Show
          when={!props.initial}
          fallback={
            <div class="flex items-center gap-2 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-secondary dark:bg-zinc-900">
              <i class={sectionKindIcon(kind())} />
              <span>{t().sectionKind({ kind: sectionKindLabel(kind(), t()) })}</span>
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
        <TextInput
          label={t().title}
          description={t().sectionTitleDescription}
          value={title}
          onValueChange={setTitle}
          error={() => fieldError("title")}
          required
        />
        <Switch
          label={t().showOnPublicPage}
          description={
            !enabled()
              ? t().showOnPublicPageOffDescription
              : props.publicPageEnabled
                ? t().sectionPublicDetail
                : t().showOnPublicPagePageOffDescription
          }
          value={enabled}
          onValueChange={setEnabled}
        />
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
                          error={() => fieldError(`link:${link.id}:label`)}
                          required
                        />
                        <TextInput
                          label={t().url}
                          description={t().linkUrlDescription}
                          value={() => link.href}
                          onValueChange={(value) => updateLink(link.id, { href: value })}
                          placeholder="https://example.com"
                          error={() => fieldError(`link:${link.id}:href`)}
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
                        error={() => fieldError(`item:${item.id}:name`)}
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
                      error={() => fieldError(`item:${item.id}:availability`)}
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
