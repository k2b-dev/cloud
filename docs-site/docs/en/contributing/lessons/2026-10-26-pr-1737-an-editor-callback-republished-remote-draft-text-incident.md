### An editor callback republished remote draft text

- **What happened:** A remote body change could be inserted again when CodeMirror reported it before the shared document projected its complete content to the composer.
- **Root cause:** Both the Yjs projection and the editor callback wrote the shared body through the application's local edit path.
- **Error class:** Feeding a remote projection back into a local writer.
- **Guard:** The actual shared-composer DOM regression asserts zero publications for remote input, then exactly one publication for a local edit with the exact merged body. Shared bodies now project only through Yjs; exclusive drafts retain the editor callback.
