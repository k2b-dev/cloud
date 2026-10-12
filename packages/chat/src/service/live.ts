import { defineLive } from "@k2b/cloud/events";
import { ChatLiveEventSchema } from "./contracts";

export const chatLive = defineLive({ appId: "chat", event: ChatLiveEventSchema });
