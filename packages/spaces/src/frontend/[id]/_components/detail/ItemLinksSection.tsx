import { openCloudResourcePicker } from "@k2b/cloud/browser/resource-picker";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { type DetailLinkItem, DetailLinks, DetailPanel, prompts, StatusBadge, type StatusTone, toast } from "@k2b/ui";
import { createMemo, createSignal, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceItemLink, SpaceItemLinkPreview, SpaceItemResourceReferenceInput } from "@/contracts";
import { linkHostname, parseGitHubLink } from "@/lib/link-targets";
import { createRetryToasts } from "../../../lib/feedback";
import { readResponseError } from "../../../lib/response";
import { useSpaceMessages } from "../../messages";
import type { SpaceItemDetail } from "../workspace/workspace-types";

type Props = {
  spaceId: string;
  itemId: string;
  /** Cloud resource references, related tasks (`spaces.item`) first. */
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
 * One "Linked" list per item: related tasks and other Cloud resource references, then external URLs.
 * GitHub links render their cached issue or pull request state; the section
 * fills a missing GitHub preview once through the API after mount so SSR never
 * waits on GitHub.
 */
export default function ItemLinksSection(props: Props) {
  const t = useSpaceMessages();
  const retryToast = createRetryToasts();
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
    onError: (error) => toast.error(error.message),
  });

  type LinkReferenceIntent = { itemId: string; reference: SpaceItemResourceReferenceInput };
  const linkReference = mutations.create<void, LinkReferenceIntent, { intent: LinkReferenceIntent }>({
    onBefore: (intent) => ({ intent }),
    mutation: async ({ itemId, reference }, { abortSignal }) => {
      const response = await apiClient[":id"].items[":itemId"].references.$post(
        { param: { id: props.spaceId, itemId }, json: reference },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t.linkResourceFailed));
    },
    onSuccess: () => props.onChanged(),
    // The picker has closed, so Retry links the captured choice to the same item, and stays until closed.
    onError: (error, context) =>
      retryToast(error.message, t.retry, () => context && linkReference.mutate(context.intent), { untilClosed: true }),
  });

  type AddLinkIntent = { itemId: string; link: { url: string; label: string | null } };
  const addLink = mutations.create<void, AddLinkIntent, { intent: AddLinkIntent }>({
    onBefore: (intent) => ({ intent }),
    mutation: async ({ itemId, link }, { abortSignal }) => {
      const response = await apiClient[":id"].items[":itemId"].links.$post(
        { param: { id: props.spaceId, itemId }, json: link },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readResponseError(response, t.addLinkFailed));
    },
    onSuccess: () => {
      setFilled(null);
      props.onChanged();
    },
    // The form has closed, so Retry adds the captured link to the same item, and stays until closed.
    onError: (error, context) => retryToast(error.message, t.retry, () => context && addLink.mutate(context.intent), { untilClosed: true }),
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
    onError: (error) => toast.error(error.message),
  });

  const busy = () => unlinkReference.loading() || linkReference.loading() || addLink.loading() || removeLink.loading();

  const linkCloudResource = async () => {
    const selected = await openCloudResourcePicker({
      title: t.linkCloudResource,
      excludeRefs: [{ type: "spaces.item", id: props.itemId }, ...props.references.map((reference) => reference.ref)],
      requireReader: true,
    });
    if (!selected) return;
    await linkReference.mutate({ itemId: props.itemId, reference: { ref: selected.ref, label: selected.title } });
  };

  const promptLink = async () => {
    const values = await prompts.form({
      title: t.addLink,
      icon: "ti ti-link-plus",
      fields: {
        url: {
          type: "text",
          label: t.linkUrl,
          placeholder: "https://",
          required: true,
          validate: (value) => (value && !isHttpUrl(value.trim()) ? t.invalidLinkUrl : null),
        },
        label: { type: "text", label: t.linkLabel, description: t.linkLabelDescription },
      },
      confirmText: t.addLink,
    });
    if (!values) return;
    await addLink.mutate({ itemId: props.itemId, link: { url: values.url.trim(), label: values.label?.trim() || null } });
  };

  const menu = (label: string, action: () => void, actionLabel: string) =>
    props.canEdit
      ? {
          menuLabel: t.moreActionsFor({ label }),
          // A getter keeps the rows stable while a write is pending; only the menu entry follows `busy`.
          menuItems: [
            {
              label: actionLabel,
              icon: "ti ti-unlink",
              get disabled() {
                return busy();
              },
              action,
            },
          ],
        }
      : {};

  const stateLabel = (state: SpaceItemLinkPreview["state"]) =>
    state === "open" ? t.linkStateOpen : state === "merged" ? t.linkStateMerged : t.linkStateClosed;

  const referenceIcon = (reference: SpaceItemDetail["references"][number]) =>
    reference.resource?.icon ??
    (reference.ref.type === "spaces.item" ? "ti ti-checkbox" : reference.ref.type === "mail.conversation" ? "ti ti-mail" : "ti ti-link");

  const referenceItems = createMemo((): DetailLinkItem[] =>
    props.references.map((reference) => {
      const href = reference.resource?.links?.find((link) => link.rel === "open")?.href;
      const shared = {
        id: `ref:${reference.ref.type}:${reference.ref.id}`,
        title: reference.label,
        icon: referenceIcon(reference),
        ...menu(reference.label, () => unlinkReference.mutate(reference.ref), t.unlink),
      };
      // A reference the person can no longer open stays visible, disabled, and says why.
      if (!href)
        return {
          ...shared,
          disabled: true,
          description: reference.ref.type === "spaces.item" ? t.taskUnavailable : t.resourceUnavailable,
        };
      return {
        ...shared,
        href,
        description: reference.resource?.title !== reference.label ? reference.resource?.title : undefined,
        trailing: !props.canEdit ? <i class="ti ti-chevron-right" aria-hidden="true" /> : undefined,
      };
    }),
  );

  const linkItems = createMemo((): DetailLinkItem[] =>
    links().map((link) => {
      const preview = link.preview;
      const github = parseGitHubLink(link.url);
      const external = {
        id: `url:${link.url}`,
        href: link.url,
        target: "_blank",
        rel: "noreferrer",
        trailing: !props.canEdit ? <i class="ti ti-external-link" aria-hidden="true" /> : undefined,
      };
      if (preview) {
        const label = `${preview.repo}#${preview.number}`;
        return {
          ...external,
          title: preview.title,
          leading: <i class={preview.type === "pull" ? "ti ti-git-pull-request" : "ti ti-brand-github"} aria-hidden="true" />,
          description: (
            <span class="inline-flex items-center gap-1.5">
              <span>{label}</span>
              <StatusBadge variant="dot" tone={previewTone[preview.state]} label={stateLabel(preview.state)} />
            </span>
          ),
          ...menu(label, () => removeLink.mutate(link.url), t.removeLink),
        };
      }
      const title = link.label ?? (github ? `${github.owner}/${github.repo}#${github.number}` : linkHostname(link.url));
      return {
        ...external,
        title,
        leading: github ? <i class="ti ti-brand-github" aria-hidden="true" /> : <LinkFavicon url={link.url} />,
        description: link.label ? linkHostname(link.url) : link.url.replace(/^https?:\/\//, ""),
        ...menu(title, () => removeLink.mutate(link.url), t.removeLink),
      };
    }),
  );

  return (
    <DetailLinks
      incoming={[]}
      outgoing={[...referenceItems(), ...linkItems()]}
      footer={
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
      }
    />
  );
}
