# Cloud CLI scripts

- `build.ts` — compiles the standalone `cld` binaries: `bun packages/cloud-cli/scripts/build.ts` (knobs `CLD_OUTPUT_DIR`, `CLD_VERSION`, `CLD_COMMIT`, `CLD_TARGETS`; see `src/config.ts`).
- `install.sh` — end-user installer for released `cld` binaries: `curl -fsSL <release-url>/install.sh | sh`.
