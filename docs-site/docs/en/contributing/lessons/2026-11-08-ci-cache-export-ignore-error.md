### A cache export failed after the image build succeeded

- **What happened:** The docs job on PR #2954 failed after building the image because GitHub Actions cache export returned `error writing layer blob: not_found`.
- **Root cause:** The build step's `cache-to` exporter omitted `ignore-error=true`, so BuildKit treated the cache service failure as a build failure. Registry cache exports had the same omission.
- **Error class:** Optional cache export treated as a build failure.
- **Guard:** The `ci-image-builds` repository check requires `ignore-error=true` on every workflow cache export. Its tests cover GHA and conditional registry exports, invalid flag values, and multiple exporters.
