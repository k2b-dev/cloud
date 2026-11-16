### An unreadable reader schema counted as "takes no container"

- **What happened:** In the #3539 fix (#3554), `readResourcePrincipals` treated a generated readable query whose input schema had no readable `properties` as a reader without a `container` input. A Code event-place check would then have called the provider without a container instead of refusing.
- **Root cause:** One boolean, "the schema has a `container` property", answered two questions. Its `false` mixed "has none" with "cannot tell", and the event-place branch accepted that `false`.
- **Error class:** A permission decision derived from a contract it could not read fell through to a permissive default instead of refusing.
- **Guard:** `packages/cloud/src/capabilities/resource-readers.test.ts` requires `not_configured` with `no_readable`, and no provider call, for missing, null, array, and string `properties` in both the event-place and the container check.
