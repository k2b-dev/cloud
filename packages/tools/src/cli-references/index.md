# Tools CLI

## What Tools is

Tools is a collection of small generators, encoders, security utilities, media tools, and network tests for everyday work.

Use `cld tools` for local utilities. Most commands run without a Cloud server or profile. They are appropriate for everyday terminal tasks and local transformations.

## Discover and format output

```bash
cld tools help
cld tools password random --help
cld tools color "#2563eb"
cld tools color "#2563eb" --json
```

Use `--json` when another command or agent will consume the result. Use normal text output for direct terminal use.

## Passwords and identifiers

```bash
cld tools password random --length 24 --symbols
cld tools password memorable --words 4 --capitalize --number
cld tools password strength "a passphrase to assess"
cld tools uuid --count 3
```

Generated passwords are printed to stdout. Do not place real passwords in shell history when checking their strength; use `--stdin` when the input is sensitive.

## Text, hashes, and links

```bash
printf %s "hello" | cld tools encode base64 --stdin
cld tools decode base64 aGVsbG8=
printf %s "message" | cld tools hash sha256 --stdin
cld tools lorem --paragraphs 2
cld tools mailto --to team@example.org --subject "Update" --body "Ready"
```

Text commands accept positional text or `--stdin`, but not both. `lorem` requires exactly one of `--paragraphs`, `--sentences`, or `--words`.

## QR codes and encryption

```bash
cld tools qr text "https://example.org" --out link.svg
cld tools qr wifi --ssid "Guest WiFi" --encryption WPA --out wifi.svg
printf %s "secret" | cld tools encrypt symmetric --stdin --key-file ./key.txt
```

QR commands write SVG when `--out` is supplied, otherwise they print SVG. For encryption keys, prefer `--key-file`, `--public-key-file`, or `--private-key-file` over shell arguments. Generate an asymmetric key pair with `cld tools encrypt keypair`; read the corresponding command help before encrypting or decrypting data.

## Network diagnostic

```bash
cld tools speedtest --server https://cloud.example.org
```

The speedtest contacts the specified Cloud instance. It is the only Tools command in this reference that needs a Cloud URL.

Document to Markdown and Markdown to PDF intentionally have no dedicated local
`cld tools` commands. Use the signed-in Tools pages, or call their authenticated
Tools-owned endpoints from an integration. To inspect those HTTP contracts,
use `cld api-docs operations tools` against a Cloud installation that
advertises the Tools OpenAPI description.

## Complete command catalogue

Run `cld tools <command> --help` for the accepted input and flags.

| Area | Commands |
| --- | --- |
| Passwords | `password random`, `password memorable`, `password pin`, `password strength` |
| IDs | `uuid` |
| Encoding | `encode base32`, `encode base64`, `encode hex`, `decode base32`, `decode base64`, `decode hex` |
| Hashes | `hash sha256`, `hash fnv1a` |
| Text and color | `lorem`, `color`, `mailto` |
| QR codes | `qr text`, `qr wifi` |
| Encryption | `encrypt symmetric`, `decrypt symmetric`, `encrypt keypair`, `encrypt asymmetric`, `decrypt asymmetric` |
| Network | `speedtest` |
