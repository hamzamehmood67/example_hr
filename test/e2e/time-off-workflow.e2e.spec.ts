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

const MOCK_HCM_PORT = 4020;

describe('E2E: Time-Off Request Full Workflows', () => {
  let app: INestApplication;
  let mockHcmApp: INestApplication;
  let mockHcmService: MockHcmService;

  beforeAll(async () => {
    mockHcmApp = await NestFactory.create(MockHcmModule, { logger: false });
    await mockHcmApp.listen(MOCK_HCM_PORT);
    mockHcmService = mockHcmApp.get(MockHcmService);

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

  describe('Happy Path: Full request lifecycle', () => {
    it('should complete: seed → create request → approve → verify final balance', async () => {
      // 1. Seed HCM with balance
      mockHcmService.setBalance('emp_hp', 'loc_NYC', 15);

      // 2. Batch sync to populate local DB
      await request(app.getHttpServer())
        .post('/api/v1/time-off/balances/sync/batch')
        .send({
          balances: [
            { employeeId: 'emp_hp', locationId: 'loc_NYC', availableDays: 15 },
          ],
        })
        .expect(200);

      // 3. Verify initial balance
      let balRes = await request(app.getHttpServer())
        .get('/api/v1/time-off/balances/emp_hp/loc_NYC')
        .expect(200);
      expect(balRes.body.availableDays).toBe(15);
      expect(balRes.body.pendingDays).toBe(0);

      // 4. Create time-off request
      const createRes = await request(app.getHttpServer())
        .post('/api/v1/time-off/requests')
        .send({
          employeeId: 'emp_hp',
          locationId: 'loc_NYC',
          leaveType: 'annual',
          startDate: '2026-06-01',
          endDate: '2026-06-06',
          daysRequested: 4,
        })
        .expect(201);

      expect(createRes.body.status).toBe('PENDING');
      const requestId = createRes.body.id;

      // 5. Verify pending_days increased
      balRes = await request(app.getHttpServer())
        .get('/api/v1/time-off/balances/emp_hp/loc_NYC')
        .expect(200);
      expect(balRes.body.pendingDays).toBe(4);
      expect(balRes.body.effectiveBalance).toBe(11);

      // 6. Manager approves
      const approveRes = await request(app.getHttpServer())
        .patch(`/api/v1/time-off/requests/${requestId}/approve`)
        .send({ managerId: 'mgr_hp' })
        .expect(200);

      expect(approveRes.body.status).toBe('APPROVED');
      expect(approveRes.body.managerId).toBe('mgr_hp');

      // 7. Verify final balance: available reduced, pending cleared
      balRes = await request(app.getHttpServer())
        .get('/api/v1/time-off/balances/emp_hp/loc_NYC')
        .expect(200);
      expect(balRes.body.availableDays).toBe(11);
      expect(balRes.body.pendingDays).toBe(0);

      // 8. Verify HCM was deducted too
      const hcmBal = mockHcmService.getBalance('emp_hp', 'loc_NYC');
      expect(hcmBal!.availableDays).toBe(11);

      // 9. Verify request is retrievable
      const getRes = await request(app.getHttpServer())
        .get(`/api/v1/time-off/requests/${requestId}`)
        .expect(200);
      expect(getRes.body.status).toBe('APPROVED');
    });
  });

  describe('Failure Path: HCM rejects during approval', () => {
    it('should handle: seed → create → HCM balance drops → approve fails → HCM_FAILED', async () => {
      mockHcmService.setBalance('emp_fp', 'loc_LA', 10);

      await request(app.getHttpServer())
        .post('/api/v1/time-off/balances/sync/batch')
        .send({
          balances: [
            { employeeId: 'emp_fp', locationId: 'loc_LA', availableDays: 10 },
          ],
        })
        .expect(200);

      const createRes = await request(app.getHttpServer())
        .post('/api/v1/time-off/requests')
        .send({
          employeeId: 'emp_fp',
          locationId: 'loc_LA',
          leaveType: 'annual',
          startDate: '2026-06-01',
          endDate: '2026-06-10',
          daysRequested: 8,
        })
        .expect(201);

      // Simulate external balance change in HCM (someone else used balance)
      mockHcmService.setBalance('emp_fp', 'loc_LA', 5);

      const approveRes = await request(app.getHttpServer())
        .patch(`/api/v1/time-off/requests/${createRes.body.id}/approve`)
        .send({ managerId: 'mgr_fp' })
        .expect(200);

      expect(approveRes.body.status).toBe('HCM_FAILED');

      // Balance should be released
      const balRes = await request(app.getHttpServer())
        .get('/api/v1/time-off/balances/emp_fp/loc_LA')
        .expect(200);
      expect(balRes.body.pendingDays).toBe(0);
    });
  });

  describe('Batch Sync with Conflicts', () => {
    it('should reconcile batch sync when pending requests exist', async () => {
      mockHcmService.setBalance('emp_bs', 'loc_NYC', 10);

      await request(app.getHttpServer())
        .post('/api/v1/time-off/balances/sync/batch')
        .send({
          balances: [
            { employeeId: 'emp_bs', locationId: 'loc_NYC', availableDays: 10 },
          ],
        })
        .expect(200);

      // Create pending request
      await request(app.getHttpServer())
        .post('/api/v1/time-off/requests')
        .send({
          employeeId: 'emp_bs',
          locationId: 'loc_NYC',
          leaveType: 'annual',
          startDate: '2026-06-01',
          endDate: '2026-06-06',
          daysRequested: 5,
        })
        .expect(201);

      // HCM sends batch with lower balance (conflict)
      const syncRes = await request(app.getHttpServer())
        .post('/api/v1/time-off/balances/sync/batch')
        .send({
          balances: [
            { employeeId: 'emp_bs', locationId: 'loc_NYC', availableDays: 3 },
          ],
        })
        .expect(200);

      expect(syncRes.body.conflicts_detected).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Webhook-triggered Balance Updates', () => {
    it('should process HCM webhook and reflect new balance', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/time-off/balances/sync/batch')
        .send({
          balances: [
            { employeeId: 'emp_wh', locationId: 'loc_NYC', availableDays: 10 },
          ],
        })
        .expect(200);

      // HCM pushes updated balance via webhook
      await request(app.getHttpServer())
        .post('/api/v1/time-off/webhooks/hcm/balance-update')
        .set('x-api-key', 'test-api-key')
        .send({
          employeeId: 'emp_wh',
          locationId: 'loc_NYC',
          availableDays: 18,
          version: 'v10',
          reason: 'year_reset',
        })
        .expect(200);

      const balRes = await request(app.getHttpServer())
        .get('/api/v1/time-off/balances/emp_wh/loc_NYC')
        .expect(200);

      expect(balRes.body.availableDays).toBe(18);
    });
  });

  describe('Rejection and Cancellation Flows', () => {
    it('should handle manager rejection → balance restored', async () => {
      mockHcmService.setBalance('emp_rej', 'loc_NYC', 10);

      await request(app.getHttpServer())
        .post('/api/v1/time-off/balances/sync/batch')
        .send({
          balances: [
            { employeeId: 'emp_rej', locationId: 'loc_NYC', availableDays: 10 },
          ],
        })
        .expect(200);

      const createRes = await request(app.getHttpServer())
        .post('/api/v1/time-off/requests')
        .send({
          employeeId: 'emp_rej',
          locationId: 'loc_NYC',
          leaveType: 'annual',
          startDate: '2026-06-01',
          endDate: '2026-06-04',
          daysRequested: 3,
        })
        .expect(201);

      const rejectRes = await request(app.getHttpServer())
        .patch(`/api/v1/time-off/requests/${createRes.body.id}/reject`)
        .send({ managerId: 'mgr_rej', reason: 'Team deadline' })
        .expect(200);

      expect(rejectRes.body.status).toBe('REJECTED');

      const balRes = await request(app.getHttpServer())
        .get('/api/v1/time-off/balances/emp_rej/loc_NYC')
        .expect(200);
      expect(balRes.body.pendingDays).toBe(0);
      expect(balRes.body.availableDays).toBe(10);
    });
  });
});
