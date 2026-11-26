import ChatFrameV2 from "./ChatFrameV2";
import { ChatDeviceNoticeV2, default as ChatListV2, ChatSearchV2 } from "./ChatListV2";
import { DiscoverChannelsPaneV2, ForYouPaneV2, ThreadsPaneV2 } from "./chat-v2-deferred";
import { chatV2Messages } from "./chat-v2-messages";
import { threadMenu } from "./chat-v2-threads";

/**
 * Chat's v2 frame as parts the shared workspace controller draws with. Only the v2 island imports them, so the panel
 * and the Cloud app, which keep v1's frame, load none of @k2b/ui v2.
 */
export const chatV2Parts = {
  ChatFrameV2,
  ChatListV2,
  ChatSearchV2,
  ChatDeviceNoticeV2,
  ForYouPaneV2,
  DiscoverChannelsPaneV2,
  ThreadsPaneV2,
  threadMenu,
  chatV2Messages,
};
export type ChatV2Parts = typeof chatV2Parts;
