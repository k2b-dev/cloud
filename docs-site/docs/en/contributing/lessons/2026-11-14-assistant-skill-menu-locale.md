### Skill menu descriptions ignored the interface language

- **What happened:** Built-in Skills showed English descriptions in the German chat slash menu.
- **Root cause:** The menu rendered model-facing Skill names and descriptions directly instead of resolving human-facing copy from Assistant's message catalog.
- **Error class:** Model discovery text reused as localized interface copy.
- **Guard:** Assistant command and rendered-menu tests cover German, unchanged English, and custom Skill fallback, including recently used Skills and administrator edits. A catalog test discovers every shipped Skill declaration and requires menu copy in every Assistant locale; the message-contract test rejects missing locale keys.
