import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BalanceService } from './balance.service';
import { LeaveBalance } from './entities/leave-balance.entity';
import { HcmService } from '../hcm/hcm.service';

describe('BalanceService', () => {
  let service: BalanceService;
  let repo: Repository<LeaveBalance>;
  let hcmService: Record<string, jest.Mock>;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    hcmService = {
      getBalance: jest.fn().mockResolvedValue({
        employeeId: 'emp_1',
        locationId: 'loc_1',
        availableDays: 10,
        version: 'v1',
      }),
      submitDeduction: jest.fn().mockResolvedValue({
        success: true,
        newBalance: 7,
        version: 'v2',
      }),
    };

    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: [LeaveBalance],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([LeaveBalance]),
        ConfigModule.forRoot({
          isGlobal: true,
          load: [() => ({ BALANCE_STALENESS_THRESHOLD_MS: 300000 })],
        }),
      ],
      providers: [
        BalanceService,
        { provide: HcmService, useValue: hcmService },
      ],
    }).compile();

    service = moduleRef.get(BalanceService);
    repo = moduleRef.get(getRepositoryToken(LeaveBalance));
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  beforeEach(async () => {
    await repo.clear();
    jest.clearAllMocks();
    hcmService.getBalance.mockResolvedValue({
      employeeId: 'emp_1',
      locationId: 'loc_1',
      availableDays: 10,
      version: 'v1',
    });
  });

  describe('reservePendingDays', () => {
    it('should reserve pending days when balance is sufficient', async () => {
      await repo.save(
        repo.create({
          employee_id: 'emp_1',
          location_id: 'loc_1',
          available_days: 10,
          pending_days: 0,
          last_synced_at: new Date(),
        }),
      );

      const result = await service.reservePendingDays('emp_1', 'loc_1', 3);
      expect(Number(result.pending_days)).toBe(3);
      expect(Number(result.available_days)).toBe(10);
    });

    it('should reject when balance is insufficient', async () => {
      await repo.save(
        repo.create({
          employee_id: 'emp_1',
          location_id: 'loc_1',
          available_days: 2,
          pending_days: 0,
          last_synced_at: new Date(),
        }),
      );

      await expect(
        service.reservePendingDays('emp_1', 'loc_1', 5),
      ).rejects.toThrow();
    });

    it('should account for existing pending days', async () => {
      await repo.save(
        repo.create({
          employee_id: 'emp_1',
          location_id: 'loc_1',
          available_days: 10,
          pending_days: 8,
          last_synced_at: new Date(),
        }),
      );

      await expect(
        service.reservePendingDays('emp_1', 'loc_1', 5),
      ).rejects.toThrow();
    });

    it('should throw for non-existent balance', async () => {
      await expect(
        service.reservePendingDays('emp_999', 'loc_999', 1),
      ).rejects.toThrow();
    });
  });

  describe('releasePendingDays', () => {
    it('should release pending days', async () => {
      await repo.save(
        repo.create({
          employee_id: 'emp_1',
          location_id: 'loc_1',
          available_days: 10,
          pending_days: 3,
          last_synced_at: new Date(),
        }),
      );

      const result = await service.releasePendingDays('emp_1', 'loc_1', 3);
      expect(Number(result.pending_days)).toBe(0);
    });

    it('should not go below zero', async () => {
      await repo.save(
        repo.create({
          employee_id: 'emp_1',
          location_id: 'loc_1',
          available_days: 10,
          pending_days: 1,
          last_synced_at: new Date(),
        }),
      );

      const result = await service.releasePendingDays('emp_1', 'loc_1', 5);
      expect(Number(result.pending_days)).toBe(0);
    });
  });

  describe('confirmDeduction', () => {
    it('should deduct from available and clear pending', async () => {
      await repo.save(
        repo.create({
          employee_id: 'emp_1',
          location_id: 'loc_1',
          available_days: 10,
          pending_days: 3,
          last_synced_at: new Date(),
        }),
      );

      const result = await service.confirmDeduction('emp_1', 'loc_1', 3);
      expect(Number(result.available_days)).toBe(7);
      expect(Number(result.pending_days)).toBe(0);
    });
  });

  describe('updateFromHcm', () => {
    it('should create a new balance if none exists', async () => {
      const { balance, conflictDetected } = await service.updateFromHcm(
        'emp_new',
        'loc_new',
        15,
        'v1',
      );
      expect(Number(balance.available_days)).toBe(15);
      expect(conflictDetected).toBe(false);
    });

    it('should update existing balance', async () => {
      await repo.save(
        repo.create({
          employee_id: 'emp_1',
          location_id: 'loc_1',
          available_days: 10,
          pending_days: 0,
          last_synced_at: new Date(),
          hcm_version: 'v1',
        }),
      );

      const { balance } = await service.updateFromHcm('emp_1', 'loc_1', 12, 'v2');
      expect(Number(balance.available_days)).toBe(12);
      expect(balance.hcm_version).toBe('v2');
    });

    it('should detect conflict when HCM balance is lower with pending requests', async () => {
      await repo.save(
        repo.create({
          employee_id: 'emp_1',
          location_id: 'loc_1',
          available_days: 10,
          pending_days: 3,
          last_synced_at: new Date(),
        }),
      );

      const { conflictDetected } = await service.updateFromHcm(
        'emp_1',
        'loc_1',
        5,
        'v2',
      );
      expect(conflictDetected).toBe(true);
    });
  });

  describe('getBalance', () => {
    it('should fetch from HCM if not found locally', async () => {
      const result = await service.getBalance('emp_1', 'loc_1');
      expect(result.balance).toBeDefined();
      expect(Number(result.balance.available_days)).toBe(10);
      expect(hcmService.getBalance).toHaveBeenCalled();
    });

    it('should return local balance if fresh', async () => {
      await repo.save(
        repo.create({
          employee_id: 'emp_1',
          location_id: 'loc_1',
          available_days: 8,
          pending_days: 0,
          last_synced_at: new Date(),
        }),
      );

      const result = await service.getBalance('emp_1', 'loc_1');
      expect(Number(result.balance.available_days)).toBe(8);
      expect(result.isStale).toBe(false);
      expect(hcmService.getBalance).not.toHaveBeenCalled();
    });

    it('should refresh from HCM if stale', async () => {
      const oldDate = new Date(Date.now() - 600000);
      await repo.save(
        repo.create({
          employee_id: 'emp_1',
          location_id: 'loc_1',
          available_days: 8,
          pending_days: 0,
          last_synced_at: oldDate,
        }),
      );

      const result = await service.getBalance('emp_1', 'loc_1');
      expect(Number(result.balance.available_days)).toBe(10);
      expect(hcmService.getBalance).toHaveBeenCalled();
    });
  });

  describe('toDto', () => {
    it('should map entity to response DTO', () => {
      const balance = new LeaveBalance();
      balance.id = 'uuid-1';
      balance.employee_id = 'emp_1';
      balance.location_id = 'loc_1';
      balance.available_days = 10;
      balance.pending_days = 3;
      balance.last_synced_at = new Date('2026-01-01');

      const dto = service.toDto(balance, false);
      expect(dto.employeeId).toBe('emp_1');
      expect(dto.effectiveBalance).toBe(7);
      expect(dto.isStale).toBe(false);
    });
  });
});
