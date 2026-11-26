import { mutation as mutations } from "@k2b/stdlib/solid";
import { confirm, Empty, Menu, Row, Section, useToast } from "@k2b/ui/v2";
import { createEffect, createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { SpaceTag } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import { NameColorDialog } from "./NameColorForm";
import { readErrorMessage } from "./utils";

export function TagsSection(props: {
  spaceId: string;
  tags: SpaceTag[];
  onWorkspaceChange?: () => void;
  onSettingsChange?: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const m = useSpaceMessages();
  const toast = useToast();
  const reconcile = () => void props.onSettingsChange?.().catch((error: Error) => toast(error.message, { status: "bad" }));

  const createMut = mutations.create({
    mutation: async (data: { name: string; color: string }) => {
      const res = await apiClient[":id"].tags.$post({
        param: { id: props.spaceId },
        json: data,
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, m.createTagFailed));
      }
      return res.json();
    },
    onSuccess: () => {
      props.onWorkspaceChange?.();
      reconcile();
    },
  });

  const updateMut = mutations.create({
    mutation: async (data: { id: string; name: string; color: string }) => {
      const res = await apiClient[":id"].tags[":tagId"].$patch({
        param: { id: props.spaceId, tagId: data.id },
        json: { name: data.name, color: data.color },
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, m.updateTagFailed));
      }
      return res.json();
    },
    onSuccess: () => {
      props.onWorkspaceChange?.();
      reconcile();
    },
  });

  const deleteMut = mutations.create<SpaceTag, SpaceTag>({
    mutation: async (tag: SpaceTag) => {
      const res = await apiClient[":id"].tags[":tagId"].$delete({
        param: { id: props.spaceId, tagId: tag.id },
      });
      if (!res.ok) {
        throw new Error(await readErrorMessage(res, m.deleteTagFailed));
      }
      return tag;
    },
    onSuccess: () => {
      props.onWorkspaceChange?.();
      reconcile();
    },
  });

  const [editing, setEditing] = createSignal<SpaceTag | "new" | null>(null);
  const busy = () => createMut.loading() || updateMut.loading() || deleteMut.loading();
  const tagOf = (value: SpaceTag | "new") => (value === "new" ? undefined : value);
  createEffect(() => props.onDirtyChange(editing() !== null));
  const save = async (data: { name: string; color: string }) => {
    const current = editing();
    setEditing(null);
    const outcome = current === "new" ? await createMut.mutate(data) : current ? await updateMut.mutate({ id: current.id, ...data }) : null;
    const error = createMut.error() ?? updateMut.error();
    if (outcome === "error" && error) toast(error.message, { status: "bad" });
  };
  const remove = async (tag: SpaceTag) => {
    if (busy()) return;
    if (!(await confirm({ title: m.deleteTag, description: m.deleteTagConfirm, confirm: m.delete }))) return;
    if ((await deleteMut.mutate(tag)) === "error") toast(deleteMut.error()?.message ?? m.deleteTagFailed, { status: "bad" });
  };
  return (
    <Section
      icon="tags"
      title={m.vocabulary}
      summary={m.vocabularyDescription}
      count={props.tags.length}
      actions={[{ label: m.newTag, icon: "plus", disabled: busy(), onClick: () => setEditing("new") }]}
    >
      <Show when={props.tags.length > 0} fallback={<Empty icon="tags" text={m.noTags} />}>
        <For each={props.tags}>
          {(tag) => (
            <Row
              mark={{ icon: "tag", color: tag.color }}
              lines={[tag.name]}
              end={
                <Menu
                  label={m.moreActionsFor({ label: tag.name })}
                  items={[
                    { label: m.editTag, icon: "pencil", onClick: () => setEditing(tag) },
                    { label: m.deleteTag, icon: "trash", danger: true, onClick: () => void remove(tag) },
                  ]}
                />
              }
            />
          )}
        </For>
      </Show>
      <Show when={editing()}>
        {(current) => (
          <NameColorDialog
            title={current() === "new" ? m.newTag : m.editTag}
            initialName={tagOf(current())?.name ?? ""}
            initialColor={tagOf(current())?.color ?? "#3b82f6"}
            namePlaceholder={m.tagNamePlaceholder}
            confirmLabel={current() === "new" ? m.create : m.save}
            busy={busy()}
            onSave={(data) => void save(data)}
            onClose={() => setEditing(null)}
          />
        )}
      </Show>
    </Section>
  );
}
