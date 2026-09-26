import { openCloudResourcePicker } from "@k2b/cloud/browser/resource-picker";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { DetailPanel, prompts, StatusBadge, type StatusTone } from "@k2b/ui";
import { createSignal, For, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceItemLink, SpaceItemLinkPreview, SpaceItemResourceReferenceInput } from "@/contracts";
import { linkHostname, parseGitHubLink } from "@/lib/link-targets";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";
import type { SpaceItemDetail } from "../workspace/workspace-types";

type Props = {
  spaceId: string;
  itemId: string;
  /** Cloud resource references (without `spaces.item`, which the panel shows as related tasks). */
  references: SpaceItemDetail["references"];
  /** External links with the previews known at render time. */
  links: SpaceItemLink[];
  canEdit: boolean;
  /** Re-reads the canonical detail after a write. */
  onChanged: () => void;
};

const previewTone: Record<SpaceItemLinkPreview["state"], StatusTone> = { open: "ok", closed: "neutral", merged: "info" };

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

/** A site's favicon; falls back to a generic icon when the host serves none. */
function LinkFavicon(props: { url: string }) {
  const [failed, setFailed] = createSignal(false);
  return (
    <Show when={!failed()} fallback={<i class="ti ti-world" aria-hidden="true" />}>
      <img
        src={`https://${linkHostname(props.url)}/favicon.ico`}
        alt=""
        width={16}
        height={16}
        loading="lazy"
        referrerpolicy="no-referrer"
        class="h-4 w-4 rounded-[2px]"
        onError={() => setFailed(true)}
      />
    </Show>
  );
}

/**
 * One "Links" list per item: Cloud resource references plus external URLs.
 * GitHub links render their cached issue or pull request state; the section
 * fills a missing GitHub preview once through the API after mount so SSR never
 * waits on GitHub.
 */
export default function ItemLinksSection(props: Props) {
  const t = useSpaceMessages();
  const [filled, setFilled] = createSignal<SpaceItemLink[] | null>(null);
  const links = () => filled() ?? props.links;

  onMount(() => {
    const missing = props.links.some((link) => link.preview === null && parseGitHubLink(link.url));
    if (!missing) return;
    void apiClient[":id"].items[":itemId"].links
      .$get({ param: { id: props.spaceId, itemId: props.itemId } })
      .then(async (response) => {
        if (response.ok) setFilled(await response.json());
      })
      .catch(() => {
        // A failed fill keeps the plain links; the next detail load retries.
      });
  });

  const unlinkReference = mutations.create<void, { type: string; id: string }>({
    mutation: async (ref, { abortSignal }) => {
      const response = await apiClient[":id"].items[":itemId"].references.$delete(
        { param: { id: props.spaceId, itemId: props.itemId }, json: { ref } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t.unlinkResourceFailed));
    },
    onSuccess: () => props.onChanged(),
    onError: (error) => prompts.error(error.message),
  });

  const linkReference = mutations.create<void, SpaceItemResourceReferenceInput>({
    mutation: async (reference, { abortSignal }) => {
      const response = await apiClient[":id"].items[":itemId"].references.$post(
        { param: { id: props.spaceId, itemId: props.itemId }, json: reference },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t.linkResourceFailed));
    },
    onSuccess: () => props.onChanged(),
    onError: (error) => prompts.error(error.message),
  });

  const addLink = mutations.create<void, { url: string; label: string | null }>({
    mutation: async (link, { abortSignal }) => {
      const response = await apiClient[":id"].items[":itemId"].links.$post(
        { param: { id: props.spaceId, itemId: props.itemId }, json: link },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t.addLinkFailed));
    },
    onSuccess: () => {
      setFilled(null);
      props.onChanged();
    },
    onError: (error) => prompts.error(error.message),
  });

  const removeLink = mutations.create<void, string>({
    mutation: async (url, { abortSignal }) => {
      const response = await apiClient[":id"].items[":itemId"].links.$delete(
        { param: { id: props.spaceId, itemId: props.itemId }, json: { url } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t.removeLinkFailed));
    },
    onSuccess: () => {
      setFilled(null);
      props.onChanged();
    },
    onError: (error) => prompts.error(error.message),
  });

  const busy = () => unlinkReference.loading() || linkReference.loading() || addLink.loading() || removeLink.loading();

  const linkCloudResource = async () => {
    const selected = await openCloudResourcePicker({
      title: t.linkCloudResource,
      excludeRefs: [{ type: "spaces.item", id: props.itemId }, ...props.references.map((reference) => reference.ref)],
      requireReader: true,
    });
    if (!selected) return;
    await linkReference.mutate({ ref: selected.ref, label: selected.title });
  };

  const promptLink = async () => {
    const values = await prompts.form({
      title: t.addLink,
      icon: "ti ti-link-plus",
      fields: {
        url: { type: "text", label: t.linkUrl, placeholder: "https://", required: true },
        label: { type: "text", label: t.linkLabel, description: t.linkLabelDescription },
      },
      confirmText: t.addLink,
    });
    if (!values) return;
    const url = values.url.trim();
    if (!isHttpUrl(url)) {
      await prompts.error(t.invalidLinkUrl);
      return;
    }
    await addLink.mutate({ url, label: values.label?.trim() || null });
  };

  const menu = (label: string, action: () => void) =>
    props.canEdit
      ? {
          menuLabel: t.moreActionsFor({ label }),
          menuItems: [{ label: t.removeLink, icon: "ti ti-unlink", disabled: busy(), action }],
        }
      : {};

  const stateLabel = (state: SpaceItemLinkPreview["state"]) =>
    state === "open" ? t.linkStateOpen : state === "merged" ? t.linkStateMerged : t.linkStateClosed;

  return (
    <DetailPanel.Section title={t.links} icon="ti ti-link" tone="neutral" meta={props.references.length + links().length || undefined}>
      <div class="flex flex-col gap-1">
        <For each={props.references}>
          {(reference) => {
            const href = () => reference.resource?.links?.find((link) => link.rel === "open")?.href;
            const icon = () => reference.resource?.icon ?? (reference.ref.type === "mail.conversation" ? "ti ti-mail" : "ti ti-link");
            const referenceMenu = () =>
              props.canEdit
                ? {
                    menuLabel: t.moreActionsFor({ label: reference.label }),
                    menuItems: [
                      { label: t.unlink, icon: "ti ti-unlink", disabled: busy(), action: () => unlinkReference.mutate(reference.ref) },
                    ],
                  }
                : {};
            return (
              <Show
                when={href()}
                fallback={
                  <DetailPanel.Action
                    type="button"
                    disabled
                    leading={<i class={icon()} aria-hidden="true" />}
                    title={reference.label}
                    description={t.resourceUnavailable}
                    {...referenceMenu()}
                  />
                }
              >
                {(openHref) => (
                  <DetailPanel.Action
                    href={openHref()}
                    leading={<i class={icon()} aria-hidden="true" />}
                    title={reference.label}
                    description={reference.resource?.title !== reference.label ? reference.resource?.title : undefined}
                    trailing={!props.canEdit ? <i class="ti ti-chevron-right" aria-hidden="true" /> : undefined}
                    {...referenceMenu()}
                  />
                )}
              </Show>
            );
          }}
        </For>
        <For each={links()}>
          {(link) => {
            const preview = () => link.preview;
            const github = () => parseGitHubLink(link.url);
            const fallbackTitle = () =>
              link.label ?? (github() ? `${github()!.owner}/${github()!.repo}#${github()!.number}` : linkHostname(link.url));
            return (
              <Show
                when={preview()}
                fallback={
                  <DetailPanel.Action
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    leading={github() ? <i class="ti ti-brand-github" aria-hidden="true" /> : <LinkFavicon url={link.url} />}
                    title={fallbackTitle()}
                    description={link.label ? linkHostname(link.url) : link.url.replace(/^https?:\/\//, "")}
                    trailing={!props.canEdit ? <i class="ti ti-external-link" aria-hidden="true" /> : undefined}
                    {...menu(fallbackTitle(), () => removeLink.mutate(link.url))}
                  />
                }
              >
                {(item) => (
                  <DetailPanel.Action
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    leading={<i class={item().type === "pull" ? "ti ti-git-pull-request" : "ti ti-brand-github"} aria-hidden="true" />}
                    title={item().title}
                    description={
                      <span class="inline-flex items-center gap-1.5">
                        <span>
                          {item().repo}#{item().number}
                        </span>
                        <StatusBadge variant="dot" tone={previewTone[item().state]} label={stateLabel(item().state)} />
                      </span>
                    }
                    trailing={!props.canEdit ? <i class="ti ti-external-link" aria-hidden="true" /> : undefined}
                    {...menu(`${item().repo}#${item().number}`, () => removeLink.mutate(link.url))}
                  />
                )}
              </Show>
            );
          }}
        </For>
        <Show when={props.canEdit}>
          <DetailPanel.Action
            type="button"
            onClick={() => void promptLink()}
            disabled={busy()}
            leading={
              <i
                class={
                  addLink.loading() ? "ti ti-loader-2 animate-spin text-[var(--k2b-action)]" : "ti ti-link-plus text-[var(--k2b-action)]"
                }
                aria-hidden="true"
              />
            }
            title={t.addLink}
          />
          <DetailPanel.Action
            type="button"
            onClick={() => void linkCloudResource()}
            disabled={busy()}
            leading={
              <i
                class={
                  linkReference.loading()
                    ? "ti ti-loader-2 animate-spin text-[var(--k2b-action)]"
                    : "ti ti-cloud-plus text-[var(--k2b-action)]"
                }
                aria-hidden="true"
              />
            }
            title={t.linkCloudResource}
          />
        </Show>
      </div>
    </DetailPanel.Section>
  );
}
