### Model contract changes must include newly merged callers

- **What happened:** Newly merged application tasks still requested removed model profile fields. Scheduled chat tasks overrode stored choices, and unrelated setting version keys could enter conflict responses.
- **Root cause:** The model migration missed callers added on the main branch, scheduled tasks supplied an explicit fast request, and version preconditions were not restricted to the saved keys.
- **Error class:** Contract drift across callers and validation boundaries.
- **Guard:** Focused application-task, scheduled chat selection, settings version, provider revision, and image metadata response tests; inventory removed names again after merging the main branch.
