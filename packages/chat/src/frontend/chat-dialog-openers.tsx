import { LocaleProvider, prompts } from "@k2b/ui";
import { chatMessages } from "../messages";
import type { AddPeopleProps as AddPeopleDialogProps } from "./AddPeopleDialog";
import type { EditProps as ChannelDialogsProps } from "./ChannelDialogs";
import type { DetailsProps as ChatDetailsDialogProps } from "./ChatDetailsDialog";
import { DeferredChatContent } from "./deferred-chat-content";
import type { LeaveProps as LeaveChatDialogProps } from "./LeaveChatDialog";
import type { Props as MessageMutationDialogProps } from "./MessageMutationDialog";
import type { NewChatProps as NewChatDialogProps } from "./NewChatDialog";
import type { ThreadDialogProps } from "./ThreadDialog";
import type { Thread } from "./threads";

export const openNewChatDialog = (props: NewChatDialogProps): Promise<string | undefined> => {
  const t = chatMessages.resolve([props.locale]).t;
  return prompts.dialog<string>(
    (close, context) => (
      <LocaleProvider locale={props.locale}>
        <DeferredChatContent
          load={() => import("./NewChatDialog").then((module) => module.NewConversationDialog)}
          contentProps={{ ...props, close, setDismissHandler: context.setDismissHandler }}
          dialog
        />
      </LocaleProvider>
    ),
    { title: t.newChat, icon: "ti ti-message-plus", size: "medium" },
  );
};

export const openAddPeopleDialog = (props: AddPeopleDialogProps): Promise<string | undefined> => {
  const t = chatMessages.resolve([props.locale]).t;
  return prompts.dialog<string>(
    (close, context) => (
      <LocaleProvider locale={props.locale}>
        <DeferredChatContent
          load={() => import("./AddPeopleDialog").then((module) => module.AddPeopleDialog)}
          contentProps={{ ...props, close, setDismissHandler: context.setDismissHandler }}
          dialog
        />
      </LocaleProvider>
    ),
    { title: t.addPeople, icon: "ti ti-user-plus", size: "medium" },
  );
};

export const openChannelDialog = (props: ChannelDialogsProps): Promise<string | undefined> => {
  const t = chatMessages.resolve([props.locale]).t;
  return prompts.dialog<string>(
    (close, context) => (
      <LocaleProvider locale={props.locale}>
        <DeferredChatContent
          load={() => import("./ChannelDialogs").then((module) => module.ChannelDialog)}
          contentProps={{ ...props, close, setDismissHandler: context.setDismissHandler }}
          dialog
        />
      </LocaleProvider>
    ),
    { title: props.conversation ? t.discoverySettings : t.newChannel, icon: "ti ti-hash", size: "medium" },
  );
};

export const openChatDetailsDialog = (props: ChatDetailsDialogProps): Promise<void | undefined> => {
  const t = chatMessages.resolve([props.locale]).t;
  return prompts.dialog<void>(
    (close, context) => (
      <LocaleProvider locale={props.locale}>
        <DeferredChatContent
          load={() => import("./ChatDetailsDialog").then((module) => module.ChatDetailsDialog)}
          contentProps={{ ...props, close, setDismissHandler: context.setDismissHandler }}
          dialog
        />
      </LocaleProvider>
    ),
    { title: t.chatDetails, icon: "ti ti-pencil", size: "medium" },
  );
};

export const openLeaveChatDialog = (props: LeaveChatDialogProps): Promise<boolean | undefined> => {
  const t = chatMessages.resolve([props.locale]).t;
  return prompts.dialog<boolean>(
    (close, context) => (
      <LocaleProvider locale={props.locale}>
        <DeferredChatContent
          load={() => import("./LeaveChatDialog").then((module) => module.LeaveChatDialog)}
          contentProps={{ ...props, close, setDismissHandler: context.setDismissHandler }}
          dialog
        />
      </LocaleProvider>
    ),
    { title: t.leaveChatTitle, icon: "ti ti-logout", size: "medium" },
  );
};

export const openMessageMutationDialog = (props: MessageMutationDialogProps): Promise<void | undefined> => {
  const t = chatMessages.resolve([props.locale]).t;
  return prompts.dialog<void>(
    (close, context) => (
      <LocaleProvider locale={props.locale}>
        <DeferredChatContent
          load={() => import("./MessageMutationDialog").then((module) => module.MessageMutationDialog)}
          contentProps={{ ...props, close, setDismissHandler: context.setDismissHandler }}
          dialog
        />
      </LocaleProvider>
    ),
    {
      title: props.operation === "edit" ? t.editMessage : t.deleteMessage,
      icon: props.operation === "edit" ? "ti ti-pencil" : "ti ti-trash",
      size: "medium",
    },
  );
};

export const openThreadDialog = (props: ThreadDialogProps): Promise<Thread | undefined> => {
  const t = chatMessages.resolve([props.locale]).t;
  return prompts.dialog<Thread>(
    (close, context) => (
      <LocaleProvider locale={props.locale}>
        <DeferredChatContent
          load={() => import("./ThreadDialog").then((module) => module.ThreadDialog)}
          contentProps={{ ...props, close, setDismissHandler: context.setDismissHandler }}
          dialog
        />
      </LocaleProvider>
    ),
    {
      title: props.thread ? t.renameThread : t.newThreadTitle({ title: props.title }),
      icon: props.thread ? "ti ti-pencil" : "ti ti-hash",
      size: "medium",
    },
  );
};
