# Account CLI

## What Account is

Account is the signed-in person's self-service area for profile data, personal credentials, SSH keys, and account extension.

Use `cld account` to work with the account of the signed-in user. It does not manage other users.

## Inspect and update the profile

```bash
cld account whoami --json
cld account profile show --json
cld account profile set --display-name "Ada Lovelace" --city "Berlin"
cld account activity --days 30 --json
```

Read `cld account profile set --help` for the available contact and address fields.

## Profile picture

```bash
cld account avatar show --json
cld account avatar set hair=curly hairColor=red glasses=round
cld account avatar random
cld account avatar photo ./portrait.webp
cld account avatar use avatar
cld account avatar delete-photo --yes
```

The profile picture is a photo, a built avatar, or initials; exactly one shows. `avatar set` changes parts of the built
avatar and shows it; an unknown part or value lists the choices. `avatar random` keeps the skin tone. `avatar photo`
takes a square PNG, JPEG, or WebP of at most 48 KiB; the web dialog crops larger images. A stored photo stays until
`delete-photo`, even while the avatar or initials show, and only the shown picture is visible to others.

## Personal API keys

```bash
cld account api-keys list --json
cld account api-keys create "Terminal agent" --expires 90d
cld account api-keys create "Transcript cleanup" --access models
cld account api-keys revoke <id-or-prefix-or-name> --yes
```

Creating a key prints its token once. Store it in the user's chosen secret store before continuing; it cannot be displayed again. Revoke only after identifying the exact key with `api-keys list`.

The default `--access full` keeps personal automation access. `--access models`
creates a key that works only at `/api/ai/openai/v1` on this Cloud, with the
Assistant models the person may use. An administrator must enable the
OpenAI-compatible API first. The text list includes an `access` column; JSON
keeps the server credential fields, including `scopes`.

## SSH keys and account actions

```bash
cld account ssh-keys list --json
cld account ssh-keys add --file ~/.ssh/id_ed25519.pub
cld account ssh-keys remove <fingerprint-or-key-prefix>
cld account extend
```

SSH key commands are available for FreeIPA accounts. To change a password, provide both passwords from files rather than putting them in shell history:

```bash
cld account password change \
  --current-password-file ./current-password.txt \
  --new-password-file ./new-password.txt
```

## Complete command catalogue

Run `cld account <command> --help` for flags and argument order.

| Area | Commands |
| --- | --- |
| Current account | `whoami`, `activity`, `extend` |
| Profile | `profile show`, `profile set` |
| Profile picture | `avatar show`, `avatar set`, `avatar random`, `avatar photo`, `avatar use`, `avatar delete-photo` |
| Personal API keys | `api-keys list`, `api-keys create`, `api-keys revoke` |
| SSH keys | `ssh-keys list`, `ssh-keys add`, `ssh-keys remove` |
| Password | `password change` |
