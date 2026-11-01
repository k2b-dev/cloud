# Chat notification preferences

Use a conversation's six-character ID. Commands require current read access and
a participant row. Open a system chat before changing its preferences.

- `cld chat notify <chat>` reads `{level, choice, until, defaultLevel, following}`.
- `cld chat notify <chat> all|mentions|default` saves a choice or resets it.
- `cld chat notify <chat> off [--for 1h|8h|1w]` mutes; omit `--for` for until changed.
- `cld chat follow <chat> <thread>` and `cld chat unfollow <chat> <thread>` set
  following for an item discussion in a system chat and return `{following}`.

Every command supports `--json` and `--jsonl`. These commands store preferences;
they do not send notifications. Explicit choices survive chat growth. Expired
mutes return to the current default. Posting in an item discussion follows it
automatically; reactions and edits do not.
