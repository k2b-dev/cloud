### Photo export defaults and crop choices belong to the saved state

- **What happened:** The editor displayed quality 0.9 while an unchanged export passed no quality to the browser encoder. Crop aspect and orientation lived outside the edit history, so undo could restore crop geometry without restoring its controls.
- **Root cause:** A displayed default was not applied at the encoder boundary, and part of the editing state was stored separately from history entries.
- **Error class:** Divergent displayed defaults and split undo state.
- **Guard:** The engine browser test intercepts the actual `HTMLCanvasElement.toBlob` format and quality arguments for unchanged JPEG and WebP sources. It checks both an export with no output options (quality 0.9) and an explicit zero. The model guard checks crop aspect and orientation defaults, undo/redo, and unchanged choice metadata across quarter turns. The view owns refitting a locked aspect after a rotation.
