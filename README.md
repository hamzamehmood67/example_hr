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
  integration/      # TRD + validation/error/isolation/edge-case tests; HCM contract tests
  e2e/              # End-to-end workflow tests (TRD + extended workflows)
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

- **Unit tests**: 62 across 4 service test suites (`BalanceService`, `RequestService`, `SyncService`, `HcmService`)
- **Integration tests** (`test/integration/time-off.integration.spec.ts`): 27 (12 TRD scenarios + 3 supplemental API checks + 12 beyond-TRD cases listed below)
- **Contract tests** (`test/integration/hcm-contract.spec.ts`): 3 HCM error-response shapes
- **E2E tests** (`test/e2e/time-off-workflow.e2e.spec.ts`): 9
- **Total** (`npm run test:all`): 101 tests

### Key test scenarios (TRD – 12)

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

### Test scenarios beyond TRD

These cover defensive validation, error paths, HCM client behavior, and workflows not spelled out in the 12 TRD cases.

**Unit (service-level)**

| Area | Scenarios |
|------|-----------|
| **Balance** | No local row and HCM fetch fails → `NotFoundException`; stale row when HCM refresh fails → serve stale with `isStale: true`; `getBalances` for multiple locations; `reservePendingDays` at exact effective balance; `confirmDeduction` to zero available/pending; `updateFromHcm` with higher HCM balance (no conflict); `forceRealtimeSync` updates from HCM |
| **Request** | Idempotent duplicate response omits `availableBalance` / `pendingAfterRequest` / `message`; `HCM_UNAVAILABLE` on approve → `HCM_FAILED` + release pending; non-HCM error on approve rethrows; cancel on `APPROVED` (no `releasePendingDays`); `listRequests` with no filters returns all |
| **Sync** | Empty batch array → success with zero records; webhook with conflict → `conflicts_detected`; `scheduledBatchSync` calls fetch + apply; HCM batch fetch failure swallowed (logged) |
| **HCM** | `submitDeduction` on HTTP 500 throws mapped error; `getBalance` on 404 → `HCM_404`; non-Axios error passed through; non-Error input wrapped as `Error` |

**Integration (HTTP + mock HCM)**

- **Input validation**: `POST /requests` missing `employeeId` → 400; invalid `daysRequested` (e.g. negative) → 400; invalid `startDate` → 400
- **Error paths**: `GET /requests/:id` unknown id → 404; `PATCH …/approve` unknown id → 404; `PATCH …/reject` on already `APPROVED` → 400; `DELETE` cancel on already `CANCELLED` → 400
- **Isolation**: Two employees, same location — one’s request does not change the other’s balance
- **Sync edge cases**: Batch with empty `balances` → 200, zero records; batch creates new employee/location row; webhook with no `x-api-key` → 401
- **Sequential integrity**: Approve first request (10→7), second 4-day request OK, third 4-day fails with `INSUFFICIENT_BALANCE`
- **Additional (existing)**: Real-time sync endpoint; list with filters; all balances for one employee

**HCM contract (integration, dedicated file)**

- HCM 500 during approval → `HCM_FAILED`, pending released
- Realtime sync for unknown employee/location in HCM → sync log `FAILED`
- HCM `timeout` failure mode on balance read → sync `FAILED` (short client timeout)

**E2E (extended workflows)**

- Reject first request, create a new request, approve — balance deducted once, pending cleared
- Cancel with idempotency key A, create with key B, approve — two rows, correct final balance
- Pending request, batch sync raises balance (bonus), then approve — deduction against updated HCM balance
- Two employees at same location — parallel create/approve, no cross-contamination

> **Note:** Integration and E2E tests bind the mock HCM to an **ephemeral port** (port `0`) to avoid collisions when `npm run test:all` runs unit tests then e2e in sequence.

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
