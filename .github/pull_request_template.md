<!-- Target `dev`, not `main`, unless a maintainer asked otherwise. -->

## Summary

<!-- What does this change and why? Link the issue or sprint if there is one. -->

## Sprint / issue

<!-- e.g. Closes #123, or Sprint/sprint-16-*.md -->

## Changes

-

## Testing

- [ ] `uv run pytest -q` passes
- [ ] `node --check app/static/app.js` passes
- [ ] New/changed behaviour has tests (bug fixes include a regression test)

## Checklist

- [ ] Document semantics still route through the `tex2word` engine (no re-implementation)
- [ ] No secrets, API keys, or `config.toml` committed
- [ ] Sprint/roadmap docs updated if this ships a scoped feature
