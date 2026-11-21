import { z } from "zod";
import { HttpScope, type SecretSave, SecretView } from "./http-contracts";
export async function chatCodeRequest(path: string, body: unknown, signal?: AbortSignal, method = "POST") {
  const response = await fetch(`/api/assistant/chat-code/runtime/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ message: z.string().optional(), code: z.string().optional() }).catch({}).parse(value);
    throw Object.assign(new Error(error.message ?? `HTTP ${response.status}`), { code: error.code });
  }
  return value;
}
export const chatCodeClient = {
  secrets: async (scope: z.infer<typeof HttpScope>) =>
    z.array(SecretView).parse(await chatCodeRequest("secrets/list", HttpScope.parse(scope))),
  saveSecret: async (scope: z.infer<typeof HttpScope>, secret: z.infer<typeof SecretSave>) =>
    SecretView.parse(await chatCodeRequest("secrets", { scope, secret }, undefined, "PUT")),
  removeSecret: async (scope: z.infer<typeof HttpScope>, name: string, revision: string) => {
    await chatCodeRequest("secrets/remove", { scope, name, revision });
  },
};
