# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub security advisories on this repository (Security tab, "Report a vulnerability"). Do not open a public issue for security problems.

Include what you found, how to reproduce it, and the plugin and `agy` versions. You can expect an acknowledgement and a fix plan as soon as the maintainer is able.

## Scope and notes

- Code and diffs are sent to Google through `agy`; that is by design and documented in the README.
- The plugin never uses `--dangerously-skip-permissions`. Reports of any path that widens `agy` permissions beyond the documented allow-list are in scope.
