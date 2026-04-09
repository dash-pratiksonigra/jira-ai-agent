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

# Atlassian Jira MCP (preferred)
ATLASSIAN_MCP_URL="https://mcp.atlassian.com/v1/mcp"
ATLASSIAN_CLOUD_ID_OR_SITE_URL="https://your-domain.atlassian.net"

# If Atlassian MCP returns "invalid_token", configure auth headers (JSON string).
# Use ONE of:
# - Personal API token (Basic): Authorization: Basic base64(email:api_token)
# - Service account API key (Bearer): Authorization: Bearer <api_key>
# ATLASSIAN_MCP_HEADERS_JSON='{"Authorization":"Basic BASE64_ENCODED_EMAIL_AND_TOKEN"}'
# ATLASSIAN_MCP_HEADERS_JSON='{"Authorization":"Bearer YOUR_SERVICE_ACCOUNT_API_KEY"}'

# If API-token auth doesn't expose Jira tools in the worker, use OAuth 2.1:
# ATLASSIAN_MCP_USE_OAUTH=true
# ATLASSIAN_MCP_OAUTH_CACHE_PATH="apps/worker/.atlassian-mcp-oauth.json"
# ATLASSIAN_MCP_OAUTH_REDIRECT_URL="http://127.0.0.1:3344/callback"
# Then run once:
#   node "apps/worker/dist/mcpOauthLogin.js"

# Code changes + PR automation (optional)
# REPO_ROOT="C:/Users/PratikSonigra/Projects/RATIFAI Jira Integration"
PR_BASE_BRANCH="develop"
PR_REMOTE="origin"
# RUN_TESTS_COMMAND="npm test"
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

