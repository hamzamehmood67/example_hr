# Time-Off Microservice

A NestJS microservice that manages employee time-off requests and keeps leave balances synchronized with an external Human Capital Management (HCM) system.

## Tech Stack

- **Framework**: NestJS 11 (TypeScript)
- **Database**: SQLite via TypeORM (better-sqlite3)
- **HTTP Client**: Axios via @nestjs/axios
- **Scheduling**: @nestjs/schedule (cron-based batch sync)
- **Validation**: class-validator + class-transformer
- **Testing**: Jest + Supertest

## Quick Start

```bash
# Install dependencies
npm install

# Start the main service (port 3000)
npm run start:dev

# In a separate terminal, start the mock HCM server (port 3001)
npm run start:mock-hcm
```

## Project Structure

```
src/
  balance/          # Leave balance management (per employee per location)
  request/          # Time-off request lifecycle (PENDING → APPROVED/REJECTED/CANCELLED)
  sync/             # HCM synchronization (batch, real-time, webhook)
  hcm/              # HCM HTTP client wrapper
  mock-hcm/         # Mock HCM server for testing and development
test/
  integration/      # Full HTTP integration tests (12 TRD scenarios)
  e2e/              # End-to-end workflow tests
```

## API Endpoints

All endpoints are prefixed with `/api/v1/time-off`.

### Leave Balances

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/balances/:employeeId` | Get all balances for an employee |
| GET | `/balances/:employeeId/:locationId` | Get balance for a specific employee + location |

### Time-Off Requests

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/requests` | Create a new time-off request |
| GET | `/requests/:id` | Get a specific request |
| GET | `/requests?employeeId=&status=` | List requests with filters |
| PATCH | `/requests/:id/approve` | Manager approves a request |
| PATCH | `/requests/:id/reject` | Manager rejects a request |
| DELETE | `/requests/:id` | Employee cancels a request |

### HCM Sync

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/balances/sync/batch` | Trigger batch sync from HCM |
| POST | `/balances/sync/realtime/:employeeId/:locationId` | Force real-time refresh |
| POST | `/webhooks/hcm/balance-update` | Receive HCM webhook (requires `x-api-key` header) |

## Running Tests

```bash
# Unit tests
npm test

# Unit tests with coverage
npm run test:cov

# Integration + E2E tests (starts mock HCM server automatically)
npm run test:e2e

# All tests
npm run test:all
```

## Test Coverage

- **Unit tests**: 42 tests across 4 service test suites
- **Integration tests**: 15 tests covering all 12 TRD scenarios + additional edge cases
- **E2E tests**: 5 full workflow tests (happy path, failure path, batch sync, webhooks, rejections)

### Key Test Scenarios (from TRD)

1. Employee requests 3 days with 10 available → PENDING
2. Employee requests 5 days with 3 available → 422 rejected
3. Manager approves, HCM deducts → APPROVED
4. Manager approves, HCM rejects → HCM_FAILED
5. Anniversary bonus via batch sync → balance increased
6. Batch sync conflicts with pending request → conflict flagged
7. Two simultaneous requests → pending tracked correctly
8. Duplicate idempotency key → original returned
9. HCM timeout → stale balance served
10. Employee cancels pending request → balance released
11. HCM webhook updates balance → local balance updated
12. Invalid webhook API key → 401

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Service port |
| `DB_PATH` | `:memory:` | SQLite database path |
| `HCM_BASE_URL` | `http://localhost:3001` | HCM API base URL |
| `HCM_TIMEOUT_MS` | 3000 | HCM API timeout |
| `BALANCE_STALENESS_THRESHOLD_MS` | 300000 | Balance staleness threshold (5 min) |
| `HCM_WEBHOOK_API_KEY` | `test-api-key` | API key for webhook authentication |

## Architecture Decisions

- **Optimistic locking**: Uses `hcm_version` token to detect concurrent modifications
- **Dual balance tracking**: `available_days` (confirmed) + `pending_days` (in-flight) to prevent race conditions
- **Defensive validation**: Always validates locally before calling HCM; never trusts HCM success alone
- **Graceful degradation**: Serves stale balances with `X-Balance-Stale` header when HCM is down
- **Idempotency**: Duplicate requests with the same key return the original response
- **Conflict detection**: Batch sync flags conflicts when HCM balance doesn't match expected local state
