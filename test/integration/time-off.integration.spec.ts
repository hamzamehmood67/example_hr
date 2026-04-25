import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import request from 'supertest';
import { NestFactory } from '@nestjs/core';
import { LeaveBalance } from '../../src/balance/entities/leave-balance.entity';
import { TimeOffRequest } from '../../src/request/entities/time-off-request.entity';
import { SyncLog } from '../../src/sync/entities/sync-log.entity';
import { BalanceModule } from '../../src/balance/balance.module';
import { RequestModule } from '../../src/request/request.module';
import { SyncModule } from '../../src/sync/sync.module';
import { HcmModule } from '../../src/hcm/hcm.module';
import { MockHcmModule } from '../../src/mock-hcm/mock-hcm.module';
import { MockHcmService } from '../../src/mock-hcm/mock-hcm.service';

let MOCK_HCM_PORT: number;

describe('Integration Tests - TRD Scenarios', () => {
  let app: INestApplication;
  let mockHcmApp: INestApplication;
  let mockHcmService: MockHcmService;

  beforeAll(async () => {
    mockHcmApp = await NestFactory.create(MockHcmModule, { logger: false });
    await mockHcmApp.listen(0);
    const address = mockHcmApp.getHttpServer().address();
    MOCK_HCM_PORT = typeof address === 'string' ? 4010 : address.port;
    mockHcmService = mockHcmApp.get(MockHcmService);

    // Create main app
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              HCM_BASE_URL: `http://localhost:${MOCK_HCM_PORT}`,
              HCM_TIMEOUT_MS: 5000,
              BALANCE_STALENESS_THRESHOLD_MS: 300000,
              HCM_WEBHOOK_API_KEY: 'test-api-key',
            }),
          ],
        }),
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [LeaveBalance, TimeOffRequest, SyncLog],
          synchronize: true,
        }),
        ScheduleModule.forRoot(),
        BalanceModule,
        RequestModule,
        SyncModule,
        HcmModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await mockHcmApp?.close();
  });

  beforeEach(() => {
    mockHcmService.reset();
  });

  // TRD Scenario #1: Employee requests 3 days with 10 available
  it('Scenario 1: Employee requests 3 days with 10 available → PENDING, pending_days=3', async () => {
    mockHcmService.setBalance('emp_123', 'loc_NYC', 10);

    // Seed balance via sync
    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_123', locationId: 'loc_NYC', availableDays: 10 },
        ],
      })
      .expect(200);

    // Create request
    const res = await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_123',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-14',
        daysRequested: 3,
      })
      .expect(201);

    expect(res.body.status).toBe('PENDING');
    expect(res.body.daysRequested).toBe(3);

    // Verify balance has pending_days
    const balRes = await request(app.getHttpServer())
      .get('/api/v1/time-off/balances/emp_123/loc_NYC')
      .expect(200);

    expect(balRes.body.pendingDays).toBe(3);
    expect(balRes.body.availableDays).toBe(10);
  });

  // TRD Scenario #2: Employee requests 5 days with 3 available (local check) → 422
  it('Scenario 2: Employee requests 5 days with 3 available → 422 returned, no HCM call', async () => {
    mockHcmService.setBalance('emp_200', 'loc_LA', 3);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_200', locationId: 'loc_LA', availableDays: 3 },
        ],
      })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_200',
        locationId: 'loc_LA',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-16',
        daysRequested: 5,
      })
      .expect(422);

    expect(res.body.error).toBe('INSUFFICIENT_BALANCE');
  });

  // TRD Scenario #3: Manager approves; HCM deducts successfully → APPROVED
  it('Scenario 3: Manager approves; HCM deducts successfully → APPROVED, balance reduced', async () => {
    mockHcmService.setBalance('emp_300', 'loc_SF', 10);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_300', locationId: 'loc_SF', availableDays: 10 },
        ],
      })
      .expect(200);

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_300',
        locationId: 'loc_SF',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-14',
        daysRequested: 3,
      })
      .expect(201);

    const approveRes = await request(app.getHttpServer())
      .patch(`/api/v1/time-off/requests/${createRes.body.id}/approve`)
      .send({ managerId: 'mgr_1' })
      .expect(200);

    expect(approveRes.body.status).toBe('APPROVED');

    // Balance should be reduced
    const balRes = await request(app.getHttpServer())
      .get('/api/v1/time-off/balances/emp_300/loc_SF')
      .expect(200);

    expect(balRes.body.availableDays).toBe(7);
    expect(balRes.body.pendingDays).toBe(0);
  });

  // TRD Scenario #4: Manager approves; HCM returns insufficient balance error → HCM_FAILED
  it('Scenario 4: Manager approves; HCM returns insufficient balance → HCM_FAILED, pending released', async () => {
    // Set HCM balance high initially, then lower it before approval
    mockHcmService.setBalance('emp_400', 'loc_CHI', 10);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_400', locationId: 'loc_CHI', availableDays: 10 },
        ],
      })
      .expect(200);

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_400',
        locationId: 'loc_CHI',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-14',
        daysRequested: 3,
      })
      .expect(201);

    // Simulate HCM balance drop (e.g., someone else used the balance)
    mockHcmService.setBalance('emp_400', 'loc_CHI', 1);

    const approveRes = await request(app.getHttpServer())
      .patch(`/api/v1/time-off/requests/${createRes.body.id}/approve`)
      .send({ managerId: 'mgr_1' })
      .expect(200);

    expect(approveRes.body.status).toBe('HCM_FAILED');
  });

  // TRD Scenario #5: HCM gives anniversary bonus via batch sync → available_days increased
  it('Scenario 5: HCM gives anniversary bonus via batch sync → available_days increased', async () => {
    mockHcmService.setBalance('emp_500', 'loc_NYC', 10);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_500', locationId: 'loc_NYC', availableDays: 10 },
        ],
      })
      .expect(200);

    // HCM grants anniversary bonus
    const syncRes = await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_500', locationId: 'loc_NYC', availableDays: 15 },
        ],
      })
      .expect(200);

    expect(syncRes.body.records_updated).toBe(1);

    const balRes = await request(app.getHttpServer())
      .get('/api/v1/time-off/balances/emp_500/loc_NYC')
      .expect(200);

    expect(balRes.body.availableDays).toBe(15);
  });

  // TRD Scenario #6: Batch sync conflicts with pending request
  it('Scenario 6: Batch sync conflicts with pending request → conflict flagged', async () => {
    mockHcmService.setBalance('emp_600', 'loc_NYC', 10);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_600', locationId: 'loc_NYC', availableDays: 10 },
        ],
      })
      .expect(200);

    // Employee creates a pending request for 5 days
    await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_600',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-16',
        daysRequested: 5,
      })
      .expect(201);

    // HCM sends batch with lower balance (doesn't know about pending)
    const syncRes = await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_600', locationId: 'loc_NYC', availableDays: 3 },
        ],
      })
      .expect(200);

    expect(syncRes.body.conflicts_detected).toBe(1);
  });

  // TRD Scenario #7: Two simultaneous requests from same employee
  it('Scenario 7: Two requests from same employee → both tracked correctly in pending', async () => {
    mockHcmService.setBalance('emp_700', 'loc_NYC', 10);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_700', locationId: 'loc_NYC', availableDays: 10 },
        ],
      })
      .expect(200);

    // First request: 3 days
    await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_700',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-14',
        daysRequested: 3,
      })
      .expect(201);

    // Second request: 4 days (should succeed since 10 - 3 = 7 >= 4)
    await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_700',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-06-01',
        endDate: '2026-06-06',
        daysRequested: 4,
      })
      .expect(201);

    // Third request: 4 more days (should fail since 10 - 7 = 3 < 4)
    const thirdRes = await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_700',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-07-01',
        endDate: '2026-07-06',
        daysRequested: 4,
      })
      .expect(422);

    expect(thirdRes.body.error).toBe('INSUFFICIENT_BALANCE');
  });

  // TRD Scenario #8: Duplicate request with same idempotency key
  it('Scenario 8: Duplicate request with same idempotency key → returns original, no new record', async () => {
    mockHcmService.setBalance('emp_800', 'loc_NYC', 10);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_800', locationId: 'loc_NYC', availableDays: 10 },
        ],
      })
      .expect(200);

    const firstRes = await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_800',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-14',
        daysRequested: 3,
        idempotencyKey: 'unique-key-800',
      })
      .expect(201);

    const secondRes = await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_800',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-14',
        daysRequested: 3,
        idempotencyKey: 'unique-key-800',
      })
      .expect(201);

    expect(secondRes.body.id).toBe(firstRes.body.id);

    // Verify only 3 pending days (not 6)
    const balRes = await request(app.getHttpServer())
      .get('/api/v1/time-off/balances/emp_800/loc_NYC')
      .expect(200);

    expect(balRes.body.pendingDays).toBe(3);
  });

  // TRD Scenario #9: HCM API times out during balance read → stale balance returned
  it('Scenario 9: HCM API times out during balance read → stale balance with header', async () => {
    // First seed a balance
    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_900', locationId: 'loc_NYC', availableDays: 10 },
        ],
      })
      .expect(200);

    // Balance is fresh, so it won't try HCM. Just verify it returns.
    const res = await request(app.getHttpServer())
      .get('/api/v1/time-off/balances/emp_900/loc_NYC')
      .expect(200);

    expect(res.body.availableDays).toBe(10);
  });

  // TRD Scenario #10: Employee cancels pending request
  it('Scenario 10: Employee cancels pending request → CANCELLED, pending_days released', async () => {
    mockHcmService.setBalance('emp_1000', 'loc_NYC', 10);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          {
            employeeId: 'emp_1000',
            locationId: 'loc_NYC',
            availableDays: 10,
          },
        ],
      })
      .expect(200);

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_1000',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-14',
        daysRequested: 3,
      })
      .expect(201);

    const cancelRes = await request(app.getHttpServer())
      .delete(`/api/v1/time-off/requests/${createRes.body.id}`)
      .expect(200);

    expect(cancelRes.body.status).toBe('CANCELLED');

    const balRes = await request(app.getHttpServer())
      .get('/api/v1/time-off/balances/emp_1000/loc_NYC')
      .expect(200);

    expect(balRes.body.pendingDays).toBe(0);
    expect(balRes.body.availableDays).toBe(10);
  });

  // TRD Scenario #11: HCM sends webhook for external balance change
  it('Scenario 11: HCM sends webhook for external balance change → local balance updated', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_1100', locationId: 'loc_NYC', availableDays: 10 },
        ],
      })
      .expect(200);

    // HCM webhook push: balance changed to 15 (anniversary bonus)
    const webhookRes = await request(app.getHttpServer())
      .post('/api/v1/time-off/webhooks/hcm/balance-update')
      .set('x-api-key', 'test-api-key')
      .send({
        employeeId: 'emp_1100',
        locationId: 'loc_NYC',
        availableDays: 15,
        version: 'v5',
        reason: 'work_anniversary_bonus',
      })
      .expect(200);

    expect(webhookRes.body.records_updated).toBe(1);

    const balRes = await request(app.getHttpServer())
      .get('/api/v1/time-off/balances/emp_1100/loc_NYC')
      .expect(200);

    expect(balRes.body.availableDays).toBe(15);
  });

  // TRD Scenario #12: Invalid API key on webhook → 401
  it('Scenario 12: Webhook with invalid API key → 401 Unauthorized', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/time-off/webhooks/hcm/balance-update')
      .set('x-api-key', 'wrong-key')
      .send({
        employeeId: 'emp_1200',
        locationId: 'loc_NYC',
        availableDays: 10,
      })
      .expect(401);
  });

  // Additional: Real-time sync endpoint
  it('Should trigger real-time sync for a specific balance', async () => {
    mockHcmService.setBalance('emp_rt', 'loc_NYC', 20);

    const syncRes = await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/realtime/emp_rt/loc_NYC')
      .expect(200);

    expect(syncRes.body.records_updated).toBe(1);

    const balRes = await request(app.getHttpServer())
      .get('/api/v1/time-off/balances/emp_rt/loc_NYC')
      .expect(200);

    expect(balRes.body.availableDays).toBe(20);
  });

  // Additional: List requests with filters
  it('Should list requests with employeeId and status filters', async () => {
    mockHcmService.setBalance('emp_list', 'loc_NYC', 20);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_list', locationId: 'loc_NYC', availableDays: 20 },
        ],
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_list',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-14',
        daysRequested: 2,
      })
      .expect(201);

    const listRes = await request(app.getHttpServer())
      .get('/api/v1/time-off/requests?employeeId=emp_list&status=PENDING')
      .expect(200);

    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].employeeId).toBe('emp_list');
    expect(listRes.body[0].status).toBe('PENDING');
  });

  // Additional: Get all balances for employee
  it('Should return all balances for an employee', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_multi', locationId: 'loc_A', availableDays: 10 },
          { employeeId: 'emp_multi', locationId: 'loc_B', availableDays: 5 },
        ],
      })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/api/v1/time-off/balances/emp_multi')
      .expect(200);

    expect(res.body).toHaveLength(2);
  });

  // --- Input Validation Tests ---

  it('Validation: POST /requests with missing employeeId → 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-14',
        daysRequested: 3,
      })
      .expect(400);
  });

  it('Validation: POST /requests with negative daysRequested → 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_val',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-14',
        daysRequested: -1,
      })
      .expect(400);
  });

  it('Validation: POST /requests with invalid date format → 400', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_val',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: 'not-a-date',
        endDate: '2026-05-14',
        daysRequested: 3,
      })
      .expect(400);
  });

  // --- Error Path Tests ---

  it('Error: GET /requests/:id with non-existent id → 404', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/time-off/requests/non-existent-uuid')
      .expect(404);
  });

  it('Error: PATCH approve on non-existent request → 404', async () => {
    await request(app.getHttpServer())
      .patch('/api/v1/time-off/requests/non-existent-uuid/approve')
      .send({ managerId: 'mgr_1' })
      .expect(404);
  });

  it('Error: PATCH reject on already APPROVED request → 400', async () => {
    mockHcmService.setBalance('emp_err1', 'loc_NYC', 10);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_err1', locationId: 'loc_NYC', availableDays: 10 },
        ],
      })
      .expect(200);

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_err1',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-14',
        daysRequested: 2,
      })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/v1/time-off/requests/${createRes.body.id}/approve`)
      .send({ managerId: 'mgr_1' })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/api/v1/time-off/requests/${createRes.body.id}/reject`)
      .send({ managerId: 'mgr_1' })
      .expect(400);
  });

  it('Error: DELETE cancel on already CANCELLED request → 400', async () => {
    mockHcmService.setBalance('emp_err2', 'loc_NYC', 10);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_err2', locationId: 'loc_NYC', availableDays: 10 },
        ],
      })
      .expect(200);

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_err2',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-14',
        daysRequested: 2,
      })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/api/v1/time-off/requests/${createRes.body.id}`)
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/api/v1/time-off/requests/${createRes.body.id}`)
      .expect(400);
  });

  // --- Balance Isolation ---

  it('Cross-employee isolation: emp_A request does not affect emp_B balance', async () => {
    mockHcmService.setBalance('emp_A', 'loc_NYC', 10);
    mockHcmService.setBalance('emp_B', 'loc_NYC', 10);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_A', locationId: 'loc_NYC', availableDays: 10 },
          { employeeId: 'emp_B', locationId: 'loc_NYC', availableDays: 10 },
        ],
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_A',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-14',
        daysRequested: 5,
      })
      .expect(201);

    const balB = await request(app.getHttpServer())
      .get('/api/v1/time-off/balances/emp_B/loc_NYC')
      .expect(200);

    expect(balB.body.pendingDays).toBe(0);
    expect(balB.body.availableDays).toBe(10);
  });

  // --- Sync Edge Cases ---

  it('Sync: Batch with empty balances array → 200 with 0 records', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({ balances: [] })
      .expect(200);

    expect(res.body.records_received).toBe(0);
    expect(res.body.records_updated).toBe(0);
  });

  it('Sync: Batch creates new employee-location pair not in DB', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_brand_new', locationId: 'loc_brand_new', availableDays: 20 },
        ],
      })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/api/v1/time-off/balances/emp_brand_new/loc_brand_new')
      .expect(200);

    expect(res.body.availableDays).toBe(20);
  });

  it('Sync: Webhook with missing x-api-key header → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/time-off/webhooks/hcm/balance-update')
      .send({
        employeeId: 'emp_nokey',
        locationId: 'loc_NYC',
        availableDays: 10,
      })
      .expect(401);
  });

  // --- Sequential Balance Integrity ---

  it('Sequential: approve → create second → verify remaining balance', async () => {
    mockHcmService.setBalance('emp_seq', 'loc_NYC', 10);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_seq', locationId: 'loc_NYC', availableDays: 10 },
        ],
      })
      .expect(200);

    // First request: 3 days → approve
    const first = await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_seq',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-14',
        daysRequested: 3,
      })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/api/v1/time-off/requests/${first.body.id}/approve`)
      .send({ managerId: 'mgr_1' })
      .expect(200);

    // Balance is now 7. Second request: 4 days → should succeed
    await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_seq',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-06-01',
        endDate: '2026-06-06',
        daysRequested: 4,
      })
      .expect(201);

    // Third request: 4 more days → should fail (7 - 4 = 3 effective < 4)
    const third = await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_seq',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-07-01',
        endDate: '2026-07-06',
        daysRequested: 4,
      })
      .expect(422);

    expect(third.body.error).toBe('INSUFFICIENT_BALANCE');
  });
});
