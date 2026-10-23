---
title: Files machine storage
navTitle: Files machine storage
section: Identity and access
order: 354
description: Give agents and standalone service accounts independent storage and explicit path permissions.
tags: [identity, files, service-accounts, authorization]
updated: 2026-10-23
---

# Files machine storage

Agents and standalone service accounts can own Cloud storage independently of
people. Ownership reserves a storage binding; it does not grant access. An
administrator grants named principals access to that binding and a relative
file or folder path.

## Create storage and grant access

In **Administration → Files → Settings → Machine storage**, choose an agent or
standalone service account, then select **Create storage**. Files creates a
separate directory under the configured Cloud homes location using its existing
Filegate service identity. Machine storage and its human grantees do not require
local Linux identity provisioning. It neither allocates a Unix UID nor uses the
machine account creator's Unix identity.

Open the storage row and add a named principal. An empty **Relative path** grants
access to the whole storage. A nonempty path includes that folder and its
descendants; it does not grant access to parent folders or similarly named
siblings. Use the exact path when addressing a narrower grant through the API
or capabilities.

| Permission | Allowed operations |
| --- | --- |
| Read | Browse, search, preview and download the granted path. |
| Read and write | Read, create, upload, rename, move and change file versions. |
| Read, write and share | Read and write, plus create public download links or upload inboxes. |

Cloud administrators manage storage grants. Removing the last grant is allowed:
this deliberately leaves the storage inaccessible until an administrator grants
access again. The durable binding continues to name its machine owner after the
account is deleted; it is not assigned to another account.

The lower of the current path grant and credential scope applies. Files
recognizes `read`, `write`, `admin`, `filesv2:read`, `filesv2:write`,
`filesv2:admin` and `filesv2:*`. A scope never creates a grant. Resource-bound
accounts do not acquire machine storage through an unrelated application binding.

The administration API lives under `/api/filesv2/admin/machine-storage`:

- `GET /` lists a page; pass the returned `next` as `after`.
- `POST /` accepts `ownerId` and `area: "cloud"`, and creates no grant.
- `GET /:id/grants` lists a page of the binding's named path grants; pass `next` as `after` to continue.
- `POST /:id/grants` accepts `principal`, `path` and `permission` (`read`,
  `write` or `admin`).
- `DELETE /:id/grants/:accessId` revokes that exact grant.

Granting the same principal and path again updates its permission and returns
the same grant ID. Retrying a request does not leave a second grant behind.

Use the returned `baseId` with the existing Files API, file providers and
capabilities. Template permissions are independent: a machine needs a template
read grant and a destination storage write grant to create a file from a template.

## Transfers and revocation

Transfers from machine storage return expiring Cloud URLs. Each download, archive request,
upload segment, session status or renewal request checks the account and its
current storage grant. Upload publication checks them again. Disabling an
account or removing its grant denies the next request, including requests made
with an already issued transfer URL. A revoked public link also denies its
issued transfer URLs.

A request already admitted can finish. Transfer expiry controls admission;
it does not interrupt a response already streaming. Filegate continues to enforce
path confinement, file and archive limits, session deadlines and segment sizes.
Cancellation of the client request cancels the upstream transfer.

Public links owned by machines resolve that machine's current authority.
They do not use the person who created the machine account. A public link needs
the creator's current sharing permission in addition to the read or write
permission its operation needs.

## Recover from unavailable storage

If provisioning fails, check the Filegate connection and retry **Create storage**
with the same owner. Files resumes its existing directory operation rather than
assigning the path to another account. A changed gateway or storage location
requires the operator to restore or reconcile that binding before access resumes.

FreeIPA storage requires an independently provisioned machine Unix identity
and explicit Unix rights. Cloud currently has no supported machine Unix
provisioning contract; Files returns `identity_incomplete` for a machine
FreeIPA binding. Granting Cloud access does not change Unix rights or provision
an identity. Operators must establish that contract before enabling machine
FreeIPA access.

Files records the acting machine, storage binding and request ID for changes.
Authorization audit entries use a path hash and depth. File contents and transfer
bearer URLs do not belong in audit metadata.
