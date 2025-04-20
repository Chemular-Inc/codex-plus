# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build/Test Commands
- Build: `pnpm run build`
- Lint: `pnpm run lint`
- Format check: `pnpm run format`
- Format fix: `pnpm run format:fix`
- Type check: `pnpm run typecheck`
- Run all tests: `pnpm run test`
- Run a single test: `cd codex-cli && npx vitest run tests/path/to/test.test.ts`
- Development: `cd codex-cli && pnpm run build:dev`

## Code Style
- Use TypeScript with strict typing - never use `any` unless in test files
- Import organization: group by type with newlines between groups, alphabetical order
- Formatting: use Prettier with project settings
- React hooks: follow rules-of-hooks and exhaustive deps rules
- Error handling: use explicit error types, avoid throwing generic errors
- Naming: use camelCase for variables/functions, PascalCase for components/classes
- Use curly braces for all control structures
- No console logs in production code
- Exhaustive switch statements required for type safety