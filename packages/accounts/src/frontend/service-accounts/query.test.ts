import { describe, expect, test } from "bun:test";
import { legacyApiKeysHref } from "./query";

const params = (text: string) => new URLSearchParams(text);

describe("where the API key list leads in the account list", () => {
  test("the kind of account a key belonged to and the search carry over", () => {
    expect(legacyApiKeysHref(params("kind=user_delegated&search=ada"))).toBe("/app/accounts/users?kind=person&q=ada");
    expect(legacyApiKeysHref(params("kind=agent&q=export"))).toBe("/app/accounts/users?kind=agent&q=export");
    expect(legacyApiKeysHref(params("kind=standalone"))).toBe("/app/accounts/users?kind=agent");
    expect(legacyApiKeysHref(params("kind=resource_bound&q=mail box"))).toBe("/app/accounts/users?kind=api-key&q=mail+box");
  });

  test("what describes keys, not accounts, and an unknown kind are left out", () => {
    expect(legacyApiKeysHref(params("status=revoked&automatic=1&page=4"))).toBe("/app/accounts/users");
    expect(legacyApiKeysHref(params("kind=robot&search=%20"))).toBe("/app/accounts/users");
  });
});
