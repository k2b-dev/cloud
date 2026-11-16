### A fix shown in the preview never reached its target branch

- **What happened:** The box "In this chat" showed "0 B" for Gustav's key figures again after the preview was rebuilt, although an earlier preview had shown "Key figures" there.
- **Root cause:** The fix that names a delivered view by what it shows lived only on a port branch and was cherry-picked into one preview build; it never landed on `feat/code`, so the next preview built from `feat/code` lost it.
- **Error class:** A change verified in an integration build but never merged into the branch the next build starts from.
- **Guard:** The box model test `a view says what it shows with its own sign, never a size` now runs on `feat/code` and names key figures; preview fixes are listed in the integration notes until their pull request has landed.
