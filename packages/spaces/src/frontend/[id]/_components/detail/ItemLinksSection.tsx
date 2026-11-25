import { openCloudResourcePicker } from "@k2b/cloud/browser/resource-picker";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, Chip, Dialog, Field, Input, Menu, Row, Section, useToast } from "@k2b/ui/v2";
import { createSignal, For, onMount, Show } from "solid-js";
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

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

/** A site's favicon; falls back to a generic icon when the host serves none. */

/**
 * One "Linked" list per item: related tasks and other Cloud resource references, then external URLs.
 * GitHub links render their cached issue or pull request state; the section
 * fills a missing GitHub preview once through the API after mount so SSR never
 * waits on GitHub.
 */
export default function ItemLinksSection(props: Props) {
  const t = useSpaceMessages();
  const toast = useToast();
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
    onError: (error) => toast(error.message, { status: "bad" }),
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
    onError: (error) => toast(error.message, { status: "bad" }),
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

  const [adding, setAdding] = createSignal(false);
  const [url, setUrl] = createSignal("");
  const [label, setLabel] = createSignal("");
  const [urlError, setUrlError] = createSignal<string>();
  const submitLink = async () => {
    const value = url().trim();
    if (!value || !isHttpUrl(value)) return setUrlError(t.invalidLinkUrl);
    await addLink.mutate({ itemId: props.itemId, link: { url: value, label: label().trim() || null } });
    if (!addLink.error()) {
      setAdding(false);
      setUrl("");
      setLabel("");
    }
  };
  const stateLabel = (state: SpaceItemLinkPreview["state"]) =>
    state === "open" ? t.linkStateOpen : state === "merged" ? t.linkStateMerged : t.linkStateClosed;
  const referenceIcon = (reference: SpaceItemDetail["references"][number]) =>
    (
      reference.resource?.icon ??
      (reference.ref.type === "spaces.item" ? "checkbox" : reference.ref.type === "mail.conversation" ? "mail" : "link")
    ).replace(/^ti\s+ti-/, "");
  const unlinkMenu = (name: string, run: () => void, words: string) =>
    props.canEdit ? (
      <Menu label={t.moreActionsFor({ label: name })} items={[{ label: words, icon: "unlink", disabled: busy(), onClick: run }]} />
    ) : undefined;

  return (
    <Section
      icon="link"
      title={t.links}
      count={props.references.length + links().length}
      actions={
        props.canEdit
          ? [
              { label: t.addLink, icon: "link-plus", disabled: busy(), onClick: () => setAdding(true) },
              { label: t.linkCloudResource, icon: "cloud-plus", disabled: busy(), onClick: () => void linkCloudResource() },
            ]
          : undefined
      }
    >
      <For each={props.references}>
        {(reference) => {
          const href = reference.resource?.links?.find((link) => link.rel === "open")?.href;
          // A reference the person can no longer open stays visible and says why.
          const second = !href
            ? reference.ref.type === "spaces.item"
              ? t.taskUnavailable
              : t.resourceUnavailable
            : reference.resource?.title !== reference.label
              ? reference.resource?.title
              : undefined;
          return (
            <Row
              icon={referenceIcon(reference)}
              lines={second ? [reference.label, second] : [reference.label]}
              href={href}
              end={unlinkMenu(reference.label, () => unlinkReference.mutate(reference.ref), t.unlink)}
            />
          );
        }}
      </For>
      <For each={links()}>
        {(link) => {
          const preview = link.preview;
          const github = parseGitHubLink(link.url);
          const title =
            preview?.title ?? link.label ?? (github ? `${github.owner}/${github.repo}#${github.number}` : linkHostname(link.url));
          const second = preview
            ? `${preview.repo}#${preview.number}`
            : link.label
              ? linkHostname(link.url)
              : link.url.replace(/^https?:\/\//, "");
          return (
            // k2b-ui gap: a Row link cannot open in a new tab; an outside link opens in this one (a modifier key keeps a tab).
            <Row
              icon={preview?.type === "pull" ? "git-pull-request" : github ? "brand-github" : "world"}
              lines={[title, second]}
              href={link.url}
              end={
                <>
                  <Show when={preview}>
                    {(state) => <Chip status={state().state === "open" ? "ok" : "warn"}>{stateLabel(state().state)}</Chip>}
                  </Show>
                  {unlinkMenu(title, () => removeLink.mutate(link.url), t.removeLink)}
                </>
              }
            />
          );
        }}
      </For>
      <Show when={adding()}>
        <Dialog
          title={t.addLink}
          open
          onOpenChange={(open) => !open && setAdding(false)}
          foot={
            <>
              <Button onClick={() => setAdding(false)}>{t.cancel}</Button>
              <Button variant="primary" icon="link-plus" busy={addLink.loading()} onClick={() => void submitLink()}>
                {t.addLink}
              </Button>
            </>
          }
        >
          <Field label={t.linkUrl} name="link-url" error={urlError()} required>
            <Input
              type="url"
              value={url()}
              placeholder="https://"
              onInput={(value) => {
                setUrl(value);
                setUrlError(undefined);
              }}
            />
          </Field>
          <Field label={t.linkLabel} name="link-label" hint={t.linkLabelDescription} optional={t.optional}>
            <Input value={label()} onInput={setLabel} />
          </Field>
        </Dialog>
      </Show>
    </Section>
  );
}
