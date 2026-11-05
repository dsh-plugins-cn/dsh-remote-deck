# Security Policy

Remote Deck runs inside your DSH desktop app with your local user privileges and connects to
remote machines over SSH. Please report security issues privately.

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | yes |
| 0.x | no (development snapshots) |

## Reporting a vulnerability

Use **GitHub Security Advisories → "Report a vulnerability"** on this repository. Do not open a
public issue for a security problem.

Please include:

- affected version (`install.ps1 -Doctor` prints it),
- DSH version and platform,
- reproduction steps and expected impact,
- whether credentials, remote files or command execution are involved.

Do not attach private keys, `connections.json`, `secrets.json`, session transcripts or any remote
data. Redact hostnames and paths where possible.

## Scope

In scope:

- credential handling (DSH credential store, `secrets.json`, logs),
- the loopback HTTP API (token checks, DNS-rebinding/CSRF style attacks, exposing terminal or
  forwarding endpoints without the token),
- command injection through connection fields, workspace paths or directory listings,
- path traversal in remote workspace routing,
- writing outside the intended remote paths.

Out of scope:

- vulnerabilities in `sshd`, the remote OS, or the network between you and the host,
- attacks that require a compromised local account with full disk access,
- the documented limitations listed in `README.md` (line-rendered terminal, missing TUI support).

## Disclosure

We aim to acknowledge a report within 7 days and to ship a fix or mitigation as a patch release.
Please give us a reasonable window before public disclosure.
