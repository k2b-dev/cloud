### A shared chart contract changed the runner image inputs

- **What happened:** The runner image could no longer bundle its checker after the main sync.
- **Root cause:** Its Docker build copied only the editor chart schema. The schema now imports locale validation and the public chart core entry, whose package exports require a UI build.
- **Error class:** A selective image source copy omits newly transitive build dependencies.
- **Guard:** The runner Docker build uses the existing public UI build recipe and copies both chart contract files. The image build and runner test-image build in CI exercise this dependency closure. The image-rule fixture also includes the runner Dockerfile when describing a complete release-image gate.
