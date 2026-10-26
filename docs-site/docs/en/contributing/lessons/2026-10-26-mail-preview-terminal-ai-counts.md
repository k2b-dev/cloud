### Mail preview lost AI calls before branch termination

- **What happened:** A preview showed an AI effect inside a matching branch but reported zero AI calls when the branch ended with `succeed` or `fail`.
- **Root cause:** Counting required planned control traversal metadata, which terminal control outcomes omit, and skipped the completed descendants.
- **Error class:** Aggregate calculations discard completed work when a parent terminates early.
- **Guard:** The Mail workflow preview test covers AI calls before terminal actions in known `if`, `switch`, and nested branches.
