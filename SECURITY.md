# Security Policy

## Supported versions

Tex Word Studio is pre-1.0; security fixes land on the latest release and the
`main` branch. Please always run the most recent version.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's
[**Report a vulnerability**](https://github.com/yfyang86/tex2word-web/security/advisories/new)
(Security → Advisories) so we can triage and fix it before it's disclosed.

Please include, as far as you can:

- what the issue is and its impact (e.g. auth bypass, RCE, path traversal, SSRF, XSS);
- the affected endpoint, file, or configuration;
- a minimal reproduction (input, request, or steps);
- the version/commit and your environment.

We aim to acknowledge a report within a few days and to keep you updated as we
work on a fix. We'll credit reporters who want it once a fix is released.

## Scope notes

- Document conversion (LaTeX/Markdown → `.docx`, math, figures, citations) is
  handled by the [`tex2word`](https://pypi.org/project/tex2word/) engine. Issues
  rooted in engine parsing/output belong there; issues in this web app (auth,
  the API, file handling, the SPA) belong here.
- Auth (scrypt + RS256 JWT), rate limiting, body-size limits, and project
  ownership are configured in `[auth]`/`[security]` and are **off/permissive by
  default** for local use — harden them before exposing an instance publicly
  (see `config.sample.toml` and `DEVELOPER-MANUAL.md`).
- Never commit real API keys or `config.toml`; use `api_key_env` or a
  gitignored `config.toml`.
