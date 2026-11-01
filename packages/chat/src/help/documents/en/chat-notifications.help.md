---
id: chat-notifications
title: Choose which chats notify you
icon: ti ti-bell
kind: task
description: Set notifications per chat, follow discussions, and turn on notifications on a device.
order: 125
---

Each chat has one of 3 levels: **All messages**, **Mentions only**, or **Off**. Cloud shows at most 1 notification per chat on a device. A new message replaces the old one, for example "Nora: Thanks! (+5 more)". Resource discussions omit the additional-message count.

## Choose a level {icon="bell"}

:::steps
1. Open the chat and choose **Chat info**. On a phone, Info is its own page.
2. Under **Notifications**, choose a level. It saves at once.
3. For **Off**, choose how long: **1 hour**, **8 hours**, **1 week**, or **Until I change it**.
:::

If the level does not save, Info shows the level that still applies and **Try again**.

:::reference
- **All messages**: every new message notifies you, in all threads.
- **Mentions only**: you get a notification when someone mentions you, replies to you, or writes in an item discussion you follow.
- **Off**: no notifications. Mentions still appear in **For you**.
- **Default** marks the level that applies when you do not choose. Direct messages and chats with up to 20 members use **All messages**. Larger chats use **Mentions only**. In a channel where you can only read, you get **All messages**.
- When you choose a level yourself, it stays when the chat grows. Choose the level marked **Default** to follow the chat's rule again.
:::

## See the level in the list {icon="list"}

:::reference
- **All messages**: the number of unread messages.
- **Mentions only**: **@** with the number of mentions and replies, or a dot for other new messages.
- **Off**: the chat is grey and shows a crossed-out bell. The chat header shows the same bell.
:::

## Follow a discussion {icon="bell-ringing"}

A collection chat defaults to **Mentions only**. When you write in an item discussion, you follow it. New messages there notify you like mentions.

:::steps
1. Open the discussion.
2. Choose **You follow** in its header to stop following. Choose **Follow** to follow again.
:::

**Chat info** lists the discussions you follow.

## Sound and timing {icon="volume"}

:::reference
- The first unread message of a chat comes with sound. Further messages replace the notification without sound until you read the chat.
- Mentions and replies always come with sound.
- You get at most 1 sound every 10 seconds.
- If you read a message within 3 seconds, no notification comes.
- When you read a chat on one device, the other devices remove its notification when you open Cloud there.
:::

Discussion notifications require current access to both the item and its collection. If the owning app cannot check access, Chat retries a limited number of times. After those retries, the notification is dropped. An administrator can inspect failed deliveries from Chat administration.

## Turn on notifications on a device {icon="device-mobile"}

The list asks once per device: **Turn on notifications on this device?** Choose **Turn on** and allow notifications in the browser. **Not now** hides the question on this device.

On iPhone and iPad, notifications work only when Cloud is on the Home Screen:

:::steps
1. Open Cloud in Safari.
2. Choose **Share**, then **Add to Home Screen**.
3. Open Cloud from the Home Screen and turn on notifications there.
:::

If your browser blocks notifications for Cloud, Info says so. Allow them in the browser's site settings.

## Browser, email, and quiet hours {icon="settings"}

Under **Settings › Notifications**, you choose for each kind of Chat notification whether it comes in the browser or by email. **New messages** never come by email. There you also set **Do not disturb** and quiet hours for all apps. While **Do not disturb** is on, the chat list shows it with **End**. Notifications that arrive in that time do not come later.
