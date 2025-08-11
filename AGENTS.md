# Repository Guidelines

## Project Structure & Module Organization

* `src/` — application code (agents, Twitch adapters, API clients, utilities). Prefer feature-based folders (e.g., `src/twitch/`, `src/agents/`, `src/utils/`).
* `tests/` — unit/integration tests mirroring `src/` (`src/foo/bar.ts` → `tests/foo/bar.test.ts`).
* `scripts/` — maintenance and ops scripts (e.g., seeding, local tools).
* `docs/` — architecture notes and ADRs.
* Config: `.eslintrc.json`, `.env.example` (copy to `.env.local`), `package.json`.

## Build, Test, and Development Commands

* `npm i` — install dependencies.
* `npm run dev` — start local dev server / watcher.
* `npm run build` — compile TypeScript and produce distributables.
* `npm test` — run test suite.
* `npm run lint` — check code style; add `--fix` to auto-format.
* `npm run start` — run the compiled app (post-build).

> See `package.json` for the full command list.

## Coding Style & Naming Conventions

* TypeScript, 2-space indent, semicolons on, single quotes.
* Filenames: `kebab-case.ts`. Classes: `PascalCase`. Functions/vars: `camelCase`. Constants: `UPPER_SNAKE_CASE`.
* Keep modules small and focused; prefer pure functions in `src/utils/`.
* Linting via ESLint; formatting via Prettier (invoked by `npm run lint --fix` if configured).

## Testing Guidelines

* Place tests in `tests/` with `*.test.ts`. Group by feature path.
* Write fast, deterministic unit tests; mock external APIs (Twitch, HTTP).
* Aim for meaningful coverage on business logic and agent prompts.
* Run locally with `npm test`; add `--watch` during development.

## Commit & Pull Request Guidelines

* Use Conventional Commits:

  * `feat: add EventSub retry backoff`
  * `fix(twitch): handle 401 token refresh`
* One focused change per PR. Include:

  * Clear description, rationale, and screenshots/logs if UX/dev-tools change.
  * Linked issue (e.g., `Closes #123`), test coverage, and rollout/rollback notes.

## Security & Configuration Tips

* Never commit secrets. Copy `.env.example` → `.env.local`; use environment vars in CI.
* Rotate Twitch/GCP credentials regularly. Limit scopes to least privilege.
* Guard webhooks and verify request signatures.

## Agent-Specific Notes

* Keep agent/system prompts in `src/agents/` with self-contained instructions and examples.
* When adding a new agent, include: purpose, inputs/outputs, failure modes, and a minimal prompt test in `tests/agents/`.
