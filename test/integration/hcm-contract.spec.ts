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

describe('Contract Tests - HCM Error Responses', () => {
  let app: INestApplication;
  let mockHcmApp: INestApplication;
  let mockHcmService: MockHcmService;

  beforeAll(async () => {
    mockHcmApp = await NestFactory.create(MockHcmModule, { logger: false });
    await mockHcmApp.listen(0);
    const address = mockHcmApp.getHttpServer().address();
    MOCK_HCM_PORT = typeof address === 'string' ? 4030 : address.port;
    mockHcmService = mockHcmApp.get(MockHcmService);

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            () => ({
              HCM_BASE_URL: `http://localhost:${MOCK_HCM_PORT}`,
              HCM_TIMEOUT_MS: 2000,
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

  it('HCM 500 during approval → HCM_FAILED status', async () => {
    mockHcmService.setBalance('emp_c1', 'loc_NYC', 10);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_c1', locationId: 'loc_NYC', availableDays: 10 },
        ],
      })
      .expect(200);

    const createRes = await request(app.getHttpServer())
      .post('/api/v1/time-off/requests')
      .send({
        employeeId: 'emp_c1',
        locationId: 'loc_NYC',
        leaveType: 'annual',
        startDate: '2026-05-10',
        endDate: '2026-05-14',
        daysRequested: 3,
      })
      .expect(201);

    mockHcmService.setFailureMode('server_error');

    const approveRes = await request(app.getHttpServer())
      .patch(`/api/v1/time-off/requests/${createRes.body.id}/approve`)
      .send({ managerId: 'mgr_1' })
      .expect(200);

    expect(approveRes.body.status).toBe('HCM_FAILED');

    const balRes = await request(app.getHttpServer())
      .get('/api/v1/time-off/balances/emp_c1/loc_NYC')
      .expect(200);
    expect(balRes.body.pendingDays).toBe(0);
  });

  it('HCM 404 for unknown employee on realtime sync → sync FAILED', async () => {
    const syncRes = await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/realtime/emp_nonexistent/loc_X')
      .expect(200);

    expect(syncRes.body.status).toBe('FAILED');
  });

  it('HCM timeout during batch sync → sync fails gracefully', async () => {
    mockHcmService.setBalance('emp_c3', 'loc_NYC', 10);

    await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/batch')
      .send({
        balances: [
          { employeeId: 'emp_c3', locationId: 'loc_NYC', availableDays: 10 },
        ],
      })
      .expect(200);

    mockHcmService.setFailureMode('timeout');

    const syncRes = await request(app.getHttpServer())
      .post('/api/v1/time-off/balances/sync/realtime/emp_c3/loc_NYC')
      .expect(200);

    expect(syncRes.body.status).toBe('FAILED');
  });
});
