# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/footprint-pdf run dev` — run footprint-pdf (Vite + Express via concurrently)

## Footprint PDF

PDF navigation tool at `artifacts/footprint-pdf/`. Plain JavaScript React + Vite frontend (in `web/`) and a TypeScript Express backend (in `server/`). Uses `multer` + `pdf-parse` for upload/text extraction and `pdfjs-dist` for in-browser viewing. Vite serves the frontend on the artifact port and proxies `/pdf-api` to Express on internal port 4001 in development. In production, Express serves both the API and the built frontend.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
