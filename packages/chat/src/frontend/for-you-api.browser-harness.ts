import { createChatSendsApi } from "./chat-sends";
import { createForYouApi } from "./for-you-api";

declare global {
  interface Window {
    forYouApi: ReturnType<typeof createForYouApi> & { send: ReturnType<typeof createChatSendsApi> };
  }
}
window.forYouApi = { ...createForYouApi(), send: createChatSendsApi() };
