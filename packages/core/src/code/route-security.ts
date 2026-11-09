import { createHmac, timingSafeEqual } from "node:crypto";
/** Non-public forms bind to the authenticated session token, which remains server-only. Public forms need no token. */
export const codeCsrf = (binding: string, codeId: string): string =>
  createHmac("sha256", binding).update(`cloud-code-page:v1:${codeId}`).digest("hex");
export function checkCodeCsrf(binding: string | undefined, codeId: string, received: string | undefined): boolean {
  if (!binding || !received || !/^[a-f0-9]{64}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(codeCsrf(binding, codeId), "hex"), Buffer.from(received, "hex"));
}
