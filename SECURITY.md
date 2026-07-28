# Security Policy

## Supported Versions

Security fixes are applied to the latest commit on the `main` branch. This project does not currently maintain multiple release branches.

## Reporting a Vulnerability

Do not disclose a vulnerability, exploit, credential, or private deployment detail in a public GitHub issue or discussion.

Use GitHub Private Vulnerability Reporting from the repository's **Security** tab. If that option is unavailable, open a public issue that asks the maintainer to provide a private contact channel, but do not include vulnerability details or sensitive data in that issue. Include the following only in the private report:

- A concise description and expected impact
- Affected routes, files, or versions
- Reproduction steps using non-sensitive test data
- Relevant request/response details with credentials removed
- A suggested mitigation, if available

You should receive an acknowledgement within seven days. Remediation timelines depend on severity and complexity. Please allow time for a fix and coordinated disclosure before publishing technical details.

## Scope Notes

Uploaded websites intentionally execute inside a restrictive CSP sandbox. Reports that require removing or bypassing the configured sandbox are in scope; expected behavior inside an intact sandbox may not be a vulnerability.

The project accepts any syntactically valid Host header by design. Production operators are responsible for restricting routed domains at their reverse proxy. Credentialed CORS is not enabled.
