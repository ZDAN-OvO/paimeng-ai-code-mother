# paimeng-ai-code-mother

AI web-app generator: users describe what they want in natural language; the platform generates, validates, previews and publishes the site.

## Layering

```
/
├── AGENTS.md               # this file: repo navigation; each subdirectory has its own
├── PRODUCT.md              # product scope, users, stack, prototype lifecycle
├── GLOSSARY.md             # domain terms; `_Avoid_` lines list the synonyms not to use
├── docs/
│   └── agents/             # engineering-skill config: issue tracker, triage labels, domain docs
├── archive/                # old Java + Vue code, read-only reference; never current truth
└── paimeng-ai-code-agent/  # the product (Next.js + TS); its own AGENTS.md takes over
```

This file covers the root level only. Layout, commands and code conventions for `paimeng-ai-code-agent/` live in its own `AGENTS.md` and in the `AGENTS.md` files below it, and must not be duplicated here.

## Artifact locality

Artifacts follow ownership: project-specific docs, specs, plans and prototypes belong under that project's `docs/`; root `docs/` is for repository-wide concerns. Follow the owning directory's `AGENTS.md` for placement and lifecycle; keep root instructions navigational, with detailed rules in the owning project.

## Pull request evidence

Evidence is what a reviewer can see, not what a command printed. In a pull request, evidence is a screenshot or a screen recording only; command output, logs, test summaries and JSON dumps may accompany it but never stand in for it.

- Put screenshots inline, in the description or in a comment on the pull request.
- A recording plays inline only when it was uploaded as a GitHub attachment. A video file linked from a branch renders as a broken image, whatever its format. Playwright writes `.webm`, so embed a GIF copy (under 10 MB) and link the original, or attach the video through the GitHub web UI. The `verify-paimeng` skill writes that GIF next to every recording, at half speed, because machine-speed UI is not reviewable.
- Say which state each recording shows.
- A branch used only to host evidence is fine. Keep it out of the change under review and do not merge it.
- When a change has no visible surface, say so in the pull request instead of substituting terminal output.
