---
id: chat-members
title: Chat members
icon: ti ti-users
description: Understand how groups, guests, and former accounts affect your chats.
order: 300
---

With **Manage** access to a chat, you can add people, guest accounts, groups, agents, and service accounts.

## Add people {icon="user-plus"}

You need **Manage** access to the chat.
The dialog shows how many people join. They can read the whole chat history.

:::steps
1. Choose **Add people** in the chat header or **Chat info**.
2. Choose the people or groups to add.
3. Review who joins and can read the history.
4. Choose **Add**.
:::

Above 20 members, the chat becomes quiet: by default, only people who are mentioned get a notification.
For 21 or more people joining through groups, the dialog suggests **Discoverable by**.
A discoverable chat lets people find it and join when they want to.

If the chat has no name, you can give it one in the dialog.
You can choose **Start a new chat without the history** instead. The new chat has the current members and the new ones,
without deactivated accounts. This choice is available for a chat with up to 100 members.
As a guest, you do not get this choice when the chat includes a group.

If **Try again** appears after **Start a new chat without the history**, choose it to finish the same request.
After reloading this tab, reopen **Add people** in the original chat to resume it.
Choose **Cancel** to discard the request. The new chat may already appear in the list.

## Use Chat info {icon="info-circle"}

Choose **Chat info** in the header to see the chat's purpose and members.
Members appear in pages of 100. Use **Search members** to find a person or group, or **Show more members** to continue.

With **Write** access, you can change the name, icon, and purpose. Open the actions menu (**…**) and choose **Edit details**.
A message in the chat records the change.

People with **Manage** access can change a person's access or remove a member.
A removed person who also belongs through a group keeps access through that group.
The last person with **Manage** keeps that access and cannot be removed.

## Channel discovery and subscriptions {icon="compass"}

With **Manage** access, open **Chat info → … → Discoverability** to change who can find the channel.
Choose groups or, when the operator allows it, **Everyone with a Cloud account**.
Set **Read** or **Write** for each audience and choose **Save**.
The audience can read the whole history before subscribing. Existing members keep their access.
Removing every audience makes the channel a chat for its existing members.

To unsubscribe, open the channel's **…** menu and choose **Unsubscribe**.
The channel disappears from your list. Choose **Undo** in the confirmation to subscribe again.
If you are the last person with **Manage** access, choose a successor first.
You can still find and read the channel while you belong to its discovery audience.

## Include agents and service accounts {icon="robot"}

Choose agents and service accounts in the member picker, like people.
They appear with a robot avatar and their name. An agent also has the **Agent** marker.
With **Manage** access, you can change their access or remove them.
The last active account with **Manage** access keeps it until another eligible member takes over.

## Leave a chat {icon="logout"}

Leaving ends your access to the whole chat history. Your messages stay in the chat.
If you also belong through a group, you keep access through that group.
If you belong only through a group, archive the chat instead of leaving.
You cannot leave a chat with no other direct member.

:::steps
1. Open **Chat info**.
2. Open the actions menu (**…**) and choose **Leave chat**.
3. If you are the last person with **Manage** access, choose a direct member as your successor.
4. Choose **Leave chat** to confirm.
:::

## Include a group {icon="users"}

:::reference
- A group can contain up to 500 people, including people in nested groups. Group members can read and write messages.
- A person who joins the group sees the chat. A person who leaves the group loses access through that group.
- Access through another group or a direct membership stays.
- People who belong through a group cannot leave the chat. They can archive it instead.
:::

## Include guests {icon="user-check"}

:::reference
- A person with **Manage** access can add a guest account directly.
- Guests can add only people they already share a chat with. Those people must be direct members of a shared chat.
- Guests cannot add groups. A shared group is not enough to choose a person.
:::

## Recognize former accounts {icon="history"}

Deleted accounts appear as **Former account**. Their messages stay in the chat.
Deactivated accounts keep their name.

If the last manager's account is deleted, an active member who has been in the
chat longest takes over management. A message explains the change.

## Organize your chats {icon="pin"}

In a chat's list menu, choose **Pin chat** to put it in **Pinned**. Use **Move up** and **Move down**, or drag its grip, to change the order. On the grip, Space starts a move, the arrow keys choose a position, Enter places it, and Escape cancels. More than 15 pins scroll in their section; there is no limit on the number of pins. Collapsing a section stays saved across your devices.

**Archive chat** hides a chat from your list without leaving it. New messages keep it archived. Open **Archive** at the foot of the list and choose **Restore** in its menu to bring it back, including its saved pin position. Archiving changes only your own list.

These controls also apply to subscribed channels. Unpinned channels appear under **Channels**. **All** and **Unread** filter both chats and channels; each section keeps its saved collapsed state. Spaces and Notebooks remain in their own section and cannot be pinned or personally archived.
