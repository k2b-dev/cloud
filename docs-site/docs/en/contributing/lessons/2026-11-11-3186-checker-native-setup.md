### Native compilation exhausts a test hook budget

- **What happened:** Under CI load, Code checker setup exceeded the default five-second hook budget. Cleanup then failed with `ENOENT` because compilation had not produced the launcher (#3182).
- **Root cause:** Three test fixtures compiled the same native launcher inside timed setup, and cleanup assumed successful setup.
- **Error class:** Machine-dependent fixture preparation consumes a test or hook deadline, then incomplete setup causes a second cleanup failure.
- **Guard:** The `test-native-compilers` repository check rejects native compiler launches inside functions in test and test-fixture files. Checker consumers prepare one shared, content-hashed launcher at module load through a directly imported helper; atomic publication keeps parallel readers from observing incomplete output. Suite cleanup only removes resources it owns and tolerates setup that never assigned a directory.
