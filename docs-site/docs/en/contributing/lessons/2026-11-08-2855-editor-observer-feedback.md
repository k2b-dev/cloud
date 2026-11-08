### Measure editor overlays outside ResizeObserver delivery

- **What happened:** WebKit reported a ResizeObserver loop when an upload error or preview retry changed the editor's save area.
- **Root cause:** The observer measured the pane and save area and synchronously wrote layout values that resized those observed elements during the same notification.
- **Error class:** Layout feedback inside an observer callback.
- **Guard:** The upload-rejection and failed-preview-retry cases in `packages/ui/test/image-editor.browser.test.ts` require an empty page-error list in both Chromium and WebKit. Measurements now run in one cancellable animation frame and write only changed values.
