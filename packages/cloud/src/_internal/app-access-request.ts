import type { RequestAuthority } from "../server/middleware/auth";

// Request lifetime only. Never put reusable credentials on serializable authority.
const requests = new WeakMap<RequestAuthority, Request>();
const credentials = new WeakMap<RequestAuthority, string>();
export const bindAppAccessRequest = (authority: RequestAuthority, request: Request, selectedCredential?: string): RequestAuthority => {
  requests.set(authority, request);
  if (selectedCredential) credentials.set(authority, selectedCredential);
  return authority;
};
export const appAccessRequest = (authority: RequestAuthority): Request | undefined => requests.get(authority);

export const appAccessCredential = (authority: RequestAuthority): string | undefined => credentials.get(authority);
