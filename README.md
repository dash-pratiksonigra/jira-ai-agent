# RATIFAI Jira Integration (AI Agent)

An AI agent that polls Jira for To-do issues, claims them safely, transitions to In-Progress, executes a configurable workflow (research/code/PR), posts status and clarification questions, and transitions to Ready for review.

## Packages

- `apps/api`: Config API + observability endpoints
- `apps/worker`: Polling worker + agent orchestrator
- `apps/ui`: Configuration UI
- `packages/shared`: Shared config schemas/types/utilities

## Quickstart (dev)

### Prereqs

- Node.js 20+

### Setup

```bash
npm install
```

### Environment

Create `apps/api/.env`:

```bash
PORT=3001
DATABASE_URL="file:../../data/dev.db"
SECRETS_MASTER_KEY="change-me-in-dev"
```

Create `apps/worker/.env`:

```bash
API_BASE_URL="http://localhost:3001"
POLL_INTERVAL_SECONDS=120
```

### Database

```bash
npm run -w apps/api prisma:generate
npm run -w apps/api db:migrate
```

### Run

```bash
npm run -w apps/api dev
npm run -w apps/worker dev
npm run -w apps/ui dev
```

