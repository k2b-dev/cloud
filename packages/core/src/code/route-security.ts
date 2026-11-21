import { createHmac, timingSafeEqual } from "node:crypto";
import { getAppSecret } from "@k2b/cloud/services/settings/crypto";
/** Non-public forms bind to the authenticated session token, which remains server-only. Public forms need no token. */
export const codeCsrf = (binding: string, codeId: string): string =>
  createHmac("sha256", binding).update(`cloud-code-page:v1:${codeId}`).digest("hex");
export function checkCodeCsrf(binding: string | undefined, codeId: string, received: string | undefined): boolean {
  if (!binding || !received || !/^[a-f0-9]{64}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(codeCsrf(binding, codeId), "hex"), Buffer.from(received, "hex"));
}

/**
 * The opaque value of the version a page was delivered with, for its label's card. It binds to no session, because
 * public pages have none, but to the installation secret every replica shares, so it neither names the version nor
 * can be made up for one. The card sends it back; a different running version answers `code_page_changed`.
 */
export const codePageVersionValue = (codeId: string, versionId: string): string =>
  createHmac("sha256", `cloud-code-page-version:v1:${getAppSecret()}`).update(`${codeId}\n${versionId}`).digest("base64url");
export function checkCodePageVersionValue(codeId: string, versionId: string, received: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(codePageVersionValue(codeId, versionId)), Buffer.from(received));
}
