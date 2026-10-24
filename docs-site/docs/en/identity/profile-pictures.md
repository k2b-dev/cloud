---
title: Profile pictures and built avatars
navTitle: Profile pictures
section: Identity and access
order: 353
description: How people choose a photo, a built avatar, or initials, how agents get robots, and how applications show every picture through one URL.
tags: [identity, profile, avatars, agents, service-accounts]
updated: 2026-10-23
---

# Profile pictures and built avatars

Every account has one picture that others see. A person shows a photo, a
built avatar, or initials. A service account, for example an agent, shows a
photo or a robot; it never shows a bare icon. Applications do not need to know
which kind is active: they show the picture through one URL.

## What a person can choose

| Kind | What others see | Stored |
| --- | --- | --- |
| `photo` | The uploaded photo, cropped to a square | PNG, JPEG, or WebP data URL, at most 48 KiB, metadata stripped |
| `built` | A flat comic avatar drawn from a small config | Config of part ids, at most 1 KiB |
| `initials` | Initials from the display name | Nothing |

Exactly one kind is active. A stored photo stays stored while the built avatar
or initials show, so switching back needs no new upload. Only the active
picture is ever served; an inactive photo is not reachable through any URL.
Deleting the photo while it shows switches to initials. Profile pictures are
visible to every user-backed signed-in actor of the installation.

## Agents and other service accounts get robots

Every service account shows a robot drawn from its account ID. The ID is fixed
when the account is created, so the robot never changes by itself, and existing
accounts have one from the first start of this version on. For a standalone
service account or agent, an administrator can change the robot's parts or
replace it with a photo; deleting the photo shows the robot again. A robot uses its own shape set: head, antenna, eyes, mouth,
body, and colours, without skin tones, hair, beards, or headwear. People stay
round and service accounts stay square wherever an avatar appears.

## The shape set

A built avatar is a config of stable ids, one per part:

```json
{ "v": 1, "kind": "person", "face": "oval", "skin": "s2", "hair": "bob", "hairColor": "red",
  "eyes": "ovals", "brows": "arched", "mouth": "smile", "beard": "none", "glasses": "round",
  "head": "none", "extra": "freckles", "bg": "sky" }
```

The schemas are `PersonAvatarSchema` and `RobotAvatarSchema` from
`@k2b/cloud/contracts/avatar`. Ids are never removed or renamed, so every
stored config keeps rendering; new options only add ids. `v` changes only when
the schema itself breaks, and each version keeps its own schema and drawing.

Server and browser draw the same SVG with `renderAvatarSvg(config)` from
`@k2b/cloud/shared`. The output is a 96 × 96 flat drawing with its own
background, so it reads the same on light and dark surfaces. It contains only
shapes drawn from fixed ids: no text, links, scripts, or values from the
config. When a drawing changes, Cloud raises the renderer revision and
re-hashes stored avatars at startup, so every client fetches the new image.

The drawings follow fixed rules, each guarded by a test: eyes and mouth reach
3:1 contrast against every skin tone; every hairstyle passed a human review and
none has a hard side parting; the moustache is always wider than the mouth;
the random choice never changes the skin tone and never picks religious
headwear.

## Show a picture in an application

Use `CloudAvatar` from `@k2b/cloud/account/ui` with the account ID and, for
people, the `avatarHash` from the user contract:

```tsx
<CloudAvatar username={user.displayName} userId={user.id} avatarHash={user.avatarHash} />
```

The picture lives at `/api/accounts/users/<id>/avatar?rev=<avatarHash>`.
`avatarHash` always identifies the active picture and is `null` while a person
shows initials; `CloudAvatar` then draws the initials itself.

| Request | Response |
| --- | --- |
| `rev` matches the active picture | `200` with `Cache-Control: private, max-age=31536000, immutable` |
| No `rev`, or an outdated one | `200` with `Cache-Control: private, no-cache`; revalidate with the ETag |
| `If-None-Match` with the current ETag | `304` |
| A person showing initials | `404` |

Built avatars are served as `image/svg+xml` with
`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`
and `X-Content-Type-Options: nosniff`.

## API

| Route | Who | Purpose |
| --- | --- | --- |
| `GET /api/me/avatar` | The signed-in person | Active kind, stored built avatar, whether a photo is stored, active hash |
| `PUT /api/me/avatar` | The signed-in person | `{ "dataUrl" }`, `{ "built" }`, or `{ "use": "photo" \| "built" \| "initials" }` |
| `DELETE /api/me/avatar` | The signed-in person | Delete the stored photo |
| `GET/PUT/DELETE /api/admin/identity/service-accounts/<id>/avatar` | Administrators | The same for a standalone service account or agent; `use` takes `photo` or `built` |

`PUT` stores and shows in one step and answers with the new state. Showing a
picture that is not stored answers `409`. A config that does not match the
account's shape set answers `400`. Administrators can still replace another
person's photo through the Accounts app; every change is audited.

## Operations

Core's startup migration adds `avatar_kind` and `avatar_config` to
`auth.users` and the avatar columns to `auth.service_accounts`. It replaces
the photo-only `users_avatar_hash_check` with checks for every kind; each check
is added `NOT VALID` first and validated in a separate statement, so reads and
writes continue during the upgrade. Existing rows keep working unchanged: a
stored photo stays active, everyone else shows initials, and every service
account shows its robot. At each start Core re-hashes stored built avatars
whose hash belongs to an older renderer revision, in batches of 500, without
overwriting a save that happens at the same time.

## CLI

```bash
cld account avatar show --json
cld account avatar set hair=curly hairColor=red
cld account avatar use initials
cld admin agents avatar set "Release agent" head=round color=teal
```

See `cld account avatar --help` and `cld admin agents avatar --help` for every
command. An unknown part or value lists the choices.
