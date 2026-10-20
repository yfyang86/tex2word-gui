# TikZ editor embed shell

Builds [DominikPeters/tikz-editor](https://github.com/DominikPeters/tikz-editor)
(MIT) as a bundle that tex2word-web shows in an iframe. Not built from here
directly: `scripts/build_tikz_editor.sh` copies `index.html`, `vite.config.ts`,
`tsconfig.json` and `src/` into a checkout of the upstream repository as
`apps/embed`, applies `patches/`, and runs `vite build`.

- `src/main.tsx` — boots the upstream app like `apps/web/src/main.tsx`.
- `src/bridge.ts` — the postMessage protocol with the host page.
- `patches/` — fixes applied to the pinned upstream commit.

See `Sprint/live-editing/sprint-06-tikz-editor.md`.
