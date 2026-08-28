import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import { dialogCore, panelDialogOptions, prompts, toast, useLocale } from "@k2b/ui";
import { type Accessor, createEffect, createMemo, onCleanup, type Setter } from "solid-js";
import { apiClient } from "@/api/client";
import type { Contact, ContactRef, ContactTree, ContactTreeNode } from "../../service";
import { resolveContactName } from "../../shared";
import AddMemberDialog from "./AddMemberDialog";
import { readErrorMessage } from "./api";
import ContactUpsertForm from "./ContactUpsertForm";
import { detailMessages } from "./detail-messages";
import { createContactQuerySource, isCurrentQuerySnapshot, parseContactQuerySource } from "./contact-query-source";
import { setSelectedContactInUrl } from "./context";

export const createContactDetailActions = (config: {
  bookId: Accessor<string | null>;
  writableBooks: Array<{ id: string; name: string }>;
  orgTreeSource: Accessor<string | null>;
  setOrgTreeSource: Setter<string | null>;
  setDetailMode: Setter<"details" | "tree">;
  invalidateDetail: () => Promise<void>;
}) => {
  const locale = useLocale();
  const t = () => detailMessages.resolve([locale()]).t;
  let nextOrgTreeRevision = 0;
  let preparingAction = false;
  let disposed = false;
  const canEdit = () => {
    const selectedBookId = config.bookId();
    if (!selectedBookId) return false;
    return config.writableBooks.some((entry) => entry.id === selectedBookId);
  };

  const canMove = () => {
    const selectedBookId = config.bookId();
    if (!selectedBookId) return false;
    return config.writableBooks.some((entry) => entry.id !== selectedBookId);
  };

  const moveMutation = mutations.create<Contact, { bookId: string; contactId: string; targetBookId: string }>({
    mutation: async (target, { abortSignal }) => {
      const response = await apiClient.books[":bookId"].contacts[":contactId"].move.$post(
        {
          param: {
            bookId: target.bookId,
            contactId: target.contactId,
          },
          json: { targetBookId: target.targetBookId },
        },
        { init: { signal: abortSignal } },
      );

      if (!response.ok) throw new Error(await readErrorMessage(response, t().moveContactFailed));

      return await response.json();
    },
    onSuccess: (moved) => {
      toast.success(t().contactMoved);
      navigateTo(`/app/contacts/${moved.bookId}?contact=${moved.id}&contactBook=${moved.bookId}`);
    },
    onError: (error) => {
      void prompts.error(error.message);
    },
  });

  const unlinkMemberMutation = mutations.create<void, { bookId: string; memberId: string }>({
    mutation: async (target, { abortSignal }) => {
      const res = await apiClient.books[":bookId"].contacts[":contactId"].$patch(
        {
          param: { bookId: target.bookId, contactId: target.memberId },
          json: { parentContactId: null },
        },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readErrorMessage(res, t().removeMemberFailed));
    },
    onSuccess: () => {
      toast.success(t().memberRemoved);
      void config.invalidateDetail().catch(() => toast.error(t().memberRemovedReloadFailed));
    },
    onError: (error) => {
      void prompts.error(error.message);
    },
  });

  const orgTreeQuery = query.create<string | null, { source: string; tree: ContactTree } | null>({
    source: config.orgTreeSource,
    enabled: () => config.orgTreeSource() !== null,
    load: async (source, { abortSignal }) => {
      if (!source) return null;
      const { bookId, contactId } = parseContactQuerySource(source);
      const response = await apiClient.books[":bookId"].contacts[":contactId"].tree.$get(
        { param: { bookId, contactId } },
        { init: { signal: abortSignal } },
      );

      if (!response.ok) throw new Error(await readErrorMessage(response, t().loadOrgTreeFailed));

      return { source, tree: await response.json() };
    },
  });
  const orgTree = createMemo(() => {
    const loaded = orgTreeQuery.data();
    return isCurrentQuerySnapshot(loaded, config.orgTreeSource()) ? loaded.tree : null;
  });

  createEffect(() => {
    if (orgTree()) config.setDetailMode("tree");
  });

  createEffect(() => {
    const error = orgTreeQuery.error();
    if (error) void prompts.error(error.message);
  });

  const openAddMemberDialog = async (parent: Contact) => {
    const member = await dialogCore.open<Contact | null>((close) => <AddMemberDialog parent={parent} close={close} />, panelDialogOptions);
    if (!member || disposed) return;
    void config.invalidateDetail().catch(() => toast.error(t().memberAddedReloadFailed));
  };

  const openEditDialog = async (selectedContact: Contact) => {
    const updated = await dialogCore.open<Contact | undefined>(
      (close) => (
        <ContactUpsertForm
          mode="edit"
          bookId={selectedContact.bookId}
          initialContact={selectedContact}
          title={t().editContactTitle({ name: resolveContactName(selectedContact, t().unnamedContact) })}
          icon="ti ti-pencil"
          onCancel={() => close(undefined)}
          onSaved={(contact) => close(contact)}
        />
      ),
      panelDialogOptions,
    );

    if (!updated || disposed) return;
    setSelectedContactInUrl({
      contactId: updated.id,
      bookId: updated.bookId,
      contact: updated,
    });
  };

  const selectOrgTreeNode = (node: ContactTreeNode, fallbackBookId: string) => {
    const selectedBookId = orgTree()?.bookId ?? fallbackBookId;
    setSelectedContactInUrl({ contactId: node.id, bookId: selectedBookId, contact: null });
  };

  const moveToBook = async (contact: Contact) => {
    if (disposed || preparingAction || moveMutation.loading() || unlinkMemberMutation.loading()) return;
    const intent = { bookId: contact.bookId, contactId: contact.id };
    const targetOptions = config.writableBooks.filter((entry) => entry.id !== intent.bookId);
    preparingAction = true;
    try {
      if (targetOptions.length === 0) {
        await prompts.alert(t().noTargetBookDescription, {
          title: t().noTargetBookTitle,
          icon: "ti ti-cube-off",
        });
        return;
      }
      const result = await prompts.form({
        title: t().moveContactTitle,
        icon: "ti ti-arrows-transfer-up-down",
        confirmText: t().move,
        fields: {
          targetBookId: {
            type: "select",
            label: t().moveTargetLabel,
            required: true,
            options: targetOptions.map((entry) => ({ id: entry.id, label: entry.name, icon: "ti ti-cube" })),
          },
        },
      });
      if (!result || disposed) return;
      await moveMutation.mutate({ ...intent, targetBookId: result.targetBookId });
    } finally {
      preparingAction = false;
    }
  };

  const unlinkMember = async (member: ContactRef, parent: Contact) => {
    if (disposed || preparingAction || moveMutation.loading() || unlinkMemberMutation.loading()) return;
    const intent = { bookId: parent.bookId, memberId: member.id };
    const message = t().removeMemberConfirm({
      member: resolveContactName(member, t().unnamedContact),
      parent: resolveContactName(parent, t().unnamedContact),
    });
    preparingAction = true;
    try {
      const confirmed = await prompts.confirm(message, {
        title: t().removeMemberTitle,
        icon: "ti ti-unlink",
        confirmText: t().remove,
        cancelText: t().cancel,
      });
      if (!confirmed || disposed) return;
      await unlinkMemberMutation.mutate(intent);
    } finally {
      preparingAction = false;
    }
  };

  onCleanup(() => {
    disposed = true;
    moveMutation.abort();
    unlinkMemberMutation.abort();
  });

  return {
    canEdit,
    canMove,
    moveToBook,
    unlinkMember,
    openOrgTree: (contact: Contact) => {
      if (orgTreeQuery.loading()) return;
      const source = createContactQuerySource({ bookId: contact.bookId, contactId: contact.id, revision: ++nextOrgTreeRevision });
      config.setOrgTreeSource(source);
    },
    orgTree,
    orgTreeLoading: orgTreeQuery.loading,
    closeOrgTree: () => {
      config.setDetailMode("details");
      config.setOrgTreeSource(null);
    },
    openAddMemberDialog,
    openEditDialog,
    selectOrgTreeNode,
  };
};
