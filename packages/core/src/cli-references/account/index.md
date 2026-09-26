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

## Personal API keys

```bash
cld account api-keys list --json
cld account api-keys create "Terminal agent" --expires 90d
cld account api-keys revoke <id-or-prefix-or-name> --yes
```

Creating a key prints its token once. Store it in the user's chosen secret store before continuing; it cannot be displayed again. Revoke only after identifying the exact key with `api-keys list`.

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
| Personal API keys | `api-keys list`, `api-keys create`, `api-keys revoke` |
| SSH keys | `ssh-keys list`, `ssh-keys add`, `ssh-keys remove` |
| Password | `password change` |
