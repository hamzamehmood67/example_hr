import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { SyncService } from './sync.service';
import { SyncLog, SyncStatus } from './entities/sync-log.entity';
import { BalanceService } from '../balance/balance.service';
import { HcmService } from '../hcm/hcm.service';

describe('SyncService', () => {
  let service: SyncService;
  let repo: Repository<SyncLog>;
  let balanceService: Record<string, jest.Mock>;
  let hcmService: Record<string, jest.Mock>;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    balanceService = {
      updateFromHcm: jest.fn().mockResolvedValue({
        balance: { id: 'b1', available_days: 10, pending_days: 0 },
        conflictDetected: false,
      }),
    };

    hcmService = {
      getBalance: jest.fn().mockResolvedValue({
        employeeId: 'emp_1',
        locationId: 'loc_1',
        availableDays: 10,
        version: 'v1',
      }),
      fetchBatchBalances: jest.fn().mockResolvedValue([
        {
          employeeId: 'emp_1',
          locationId: 'loc_1',
          availableDays: 10,
          version: 'v1',
        },
      ]),
    };

    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [SyncLog],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([SyncLog]),
      ],
      providers: [
        SyncService,
        { provide: BalanceService, useValue: balanceService },
        { provide: HcmService, useValue: hcmService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('0 */15 * * * *') },
        },
      ],
    }).compile();

    service = moduleRef.get(SyncService);
    repo = moduleRef.get(getRepositoryToken(SyncLog));
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  beforeEach(async () => {
    await repo.clear();
    jest.clearAllMocks();
    balanceService.updateFromHcm.mockResolvedValue({
      balance: { id: 'b1', available_days: 10, pending_days: 0 },
      conflictDetected: false,
    });
    hcmService.getBalance.mockResolvedValue({
      employeeId: 'emp_1',
      locationId: 'loc_1',
      availableDays: 10,
      version: 'v1',
    });
  });

  describe('batchSync', () => {
    it('should process batch and create sync log', async () => {
      const result = await service.batchSync(
        [
          { employeeId: 'emp_1', locationId: 'loc_1', availableDays: 10 },
          { employeeId: 'emp_2', locationId: 'loc_2', availableDays: 5 },
        ],
        'MANUAL',
      );

      expect(result.status).toBe(SyncStatus.SUCCESS);
      expect(result.records_received).toBe(2);
      expect(result.records_updated).toBe(2);
    });

    it('should report PARTIAL status when some records fail', async () => {
      let callCount = 0;
      balanceService.updateFromHcm.mockImplementation(() => {
        callCount++;
        if (callCount === 2) throw new Error('DB error');
        return { balance: {}, conflictDetected: false };
      });

      const result = await service.batchSync(
        [
          { employeeId: 'emp_1', locationId: 'loc_1', availableDays: 10 },
          { employeeId: 'emp_2', locationId: 'loc_2', availableDays: 5 },
        ],
        'SYSTEM',
      );

      expect(result.status).toBe(SyncStatus.PARTIAL);
      expect(result.records_updated).toBe(1);
    });

    it('should report FAILED status when all records fail', async () => {
      balanceService.updateFromHcm.mockRejectedValue(new Error('DB error'));

      const result = await service.batchSync(
        [{ employeeId: 'emp_1', locationId: 'loc_1', availableDays: 10 }],
        'SYSTEM',
      );

      expect(result.status).toBe(SyncStatus.FAILED);
      expect(result.records_updated).toBe(0);
    });

    it('should detect conflicts during batch sync', async () => {
      balanceService.updateFromHcm.mockResolvedValue({
        balance: {},
        conflictDetected: true,
      });

      const result = await service.batchSync(
        [{ employeeId: 'emp_1', locationId: 'loc_1', availableDays: 3 }],
        'SYSTEM',
      );

      expect(result.conflicts_detected).toBe(1);
    });
  });

  describe('realtimeSync', () => {
    it('should fetch from HCM and update local balance', async () => {
      const result = await service.realtimeSync('emp_1', 'loc_1');
      expect(result.status).toBe(SyncStatus.SUCCESS);
      expect(result.records_updated).toBe(1);
      expect(hcmService.getBalance).toHaveBeenCalledWith('emp_1', 'loc_1');
    });

    it('should record failure when HCM is unavailable', async () => {
      hcmService.getBalance.mockRejectedValue(new Error('HCM timeout'));

      const result = await service.realtimeSync('emp_1', 'loc_1');
      expect(result.status).toBe(SyncStatus.FAILED);
    });
  });

  describe('handleWebhook', () => {
    it('should process webhook payload and update balance', async () => {
      const result = await service.handleWebhook({
        employeeId: 'emp_1',
        locationId: 'loc_1',
        availableDays: 12,
        version: 'v3',
      });

      expect(result.status).toBe(SyncStatus.SUCCESS);
      expect(result.triggered_by).toBe('HCM_WEBHOOK');
      expect(balanceService.updateFromHcm).toHaveBeenCalledWith(
        'emp_1',
        'loc_1',
        12,
        'v3',
      );
    });
  });
});
