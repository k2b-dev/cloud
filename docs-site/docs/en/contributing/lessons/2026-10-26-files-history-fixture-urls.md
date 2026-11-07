### Isolated Filegate lease URLs

- **What happened:** The fixture publishes a random host port but advertises port 4000. An explicitly configured local daemon bypasses that setup.
- **Root cause:** Container metadata calls work while issued direct leases target an unreachable port.
- **Error class:** Container metadata calls work while issued direct leases target an unreachable port.
- **Guard:** The isolated fixture chooses one host port for its public URL and Docker mapping. Administrative download and stable-ID history integration tests consume actual issued leases. Evidence: Run the Files history integration suites without `CLOUD_TEST_FILEGATE_URL`, so they start their own daemon and exercise its public URLs.
