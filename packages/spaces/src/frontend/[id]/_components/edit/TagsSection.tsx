import { mutation as mutations } from "@k2b/stdlib/solid";
import { prompts, SettingsGroup, TagEditor, toast } from "@k2b/ui";
import { apiClient } from "@/api/client";
import type { SpaceTag } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import { readErrorMessage } from "./utils";

export function TagsSection(props: {
  spaceId: string;
  tags: SpaceTag[];
  onWorkspaceChange?: () => void;
  onSettingsChange?: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const m = useSpaceMessages();
  const reconcile = () => void props.onSettingsChange?.().catch((error) => prompts.error(error.message));

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
      toast.success(m.tagCreated);
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
      toast.success(m.tagUpdated);
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
      toast.success(m.tagDeleted);
      props.onWorkspaceChange?.();
      reconcile();
    },
  });

  const throwMutationError = (error: Error | null) => {
    if (error) throw error;
  };
  let deletePromptPending = false;

  return (
    <SettingsGroup title={m.vocabulary} description={m.vocabularyDescription}>
      <TagEditor
        items={props.tags}
        defaultColor="#3b82f6"
        disabled={createMut.loading() || updateMut.loading() || deleteMut.loading()}
        onDirtyChange={props.onDirtyChange}
        onCreate={async (value) => {
          await createMut.mutate(value);
          throwMutationError(createMut.error());
        }}
        onUpdate={async (tag, value) => {
          await updateMut.mutate({ id: tag.id, ...value });
          throwMutationError(updateMut.error());
        }}
        onDelete={async (tag) => {
          if (deletePromptPending || deleteMut.loading()) return;
          deletePromptPending = true;
          try {
            const confirmed = await prompts.confirm(m.deleteTagConfirm, { title: m.deleteTag, variant: "danger" });
            if (!confirmed) return;
            await deleteMut.mutate(tag);
            throwMutationError(deleteMut.error());
          } finally {
            deletePromptPending = false;
          }
        }}
      />
    </SettingsGroup>
  );
}
