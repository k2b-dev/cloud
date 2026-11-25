import { describe, expect, test } from "bun:test";
import { apiKeysHref, apiKeysQuery, legacyApiKeyListHref, legacyApiKeysHref, parseApiKeysAddress } from "./query";

const query = apiKeysQuery("de");
const params = (text: string) => new URLSearchParams(text);

describe("the API key list's address", () => {
  test("keeps the parameters of the list before v2: kind, status, automatic=1 and page", () => {
    const address = parseApiKeysAddress(query, params("kind=agent&status=revoked&automatic=1&q=export&page=2"));
    expect(address.issues).toEqual([]);
    expect(address.page).toBe(2);
    expect(address.state.filters).toEqual({ kind: "agent", status: "revoked", automatic: "1" });
    expect(address.state.search).toBe("export");
    expect(apiKeysHref(query, address.state, address.page)).toBe(
      "/app/accounts/api-keys?kind=agent&status=revoked&automatic=1&q=export&page=2",
    );
  });

  test("active is the default status and stays out of the address", () => {
    const address = parseApiKeysAddress(query, params(""));
    expect(address.state.filters.status).toBe("active");
    expect(apiKeysHref(query, address.state)).toBe("/app/accounts/api-keys");
  });

  test("drops what does not apply and says so", () => {
    const address = parseApiKeysAddress(query, params(`kind=robot&page=0&q=${"x".repeat(201)}`));
    expect(address.state.filters.kind).toBeUndefined();
    expect(address.state.search).toBeUndefined();
    expect(address.page).toBe(1);
    expect(address.issues.map((issue) => issue.param).sort()).toEqual(["kind", "page", "q"]);
  });

  test("an address from before v2 leads to the same list in the v2 address", () => {
    expect(legacyApiKeyListHref(params("search=ci&kind=standalone&status=revoked&page=3"))).toBe(
      "/app/accounts/api-keys?kind=agent&status=revoked&page=3&q=ci",
    );
    expect(legacyApiKeyListHref(params("kind=agent&q=ci"))).toBeNull();
  });
});

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
