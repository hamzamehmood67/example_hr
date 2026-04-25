import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  UnprocessableEntityException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { RequestService } from './request.service';
import {
  TimeOffRequest,
  RequestStatus,
} from './entities/time-off-request.entity';
import { BalanceService } from '../balance/balance.service';
import { HcmService } from '../hcm/hcm.service';
import { LeaveBalance } from '../balance/entities/leave-balance.entity';

describe('RequestService', () => {
  let service: RequestService;
  let repo: Repository<TimeOffRequest>;
  let balanceService: Record<string, jest.Mock>;
  let hcmService: Record<string, jest.Mock>;
  let moduleRef: TestingModule;

  const mockBalance: Partial<LeaveBalance> = {
    id: 'bal-1',
    employee_id: 'emp_1',
    location_id: 'loc_1',
    available_days: 10,
    pending_days: 3,
    hcm_version: 'v1',
  };

  beforeAll(async () => {
    balanceService = {
      reservePendingDays: jest.fn().mockResolvedValue(mockBalance),
      releasePendingDays: jest.fn().mockResolvedValue(mockBalance),
      confirmDeduction: jest.fn().mockResolvedValue(mockBalance),
      getBalance: jest.fn().mockResolvedValue({
        balance: mockBalance,
        isStale: false,
      }),
    };

    hcmService = {
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
          entities: [TimeOffRequest],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([TimeOffRequest]),
      ],
      providers: [
        RequestService,
        { provide: BalanceService, useValue: balanceService },
        { provide: HcmService, useValue: hcmService },
      ],
    }).compile();

    service = moduleRef.get(RequestService);
    repo = moduleRef.get(getRepositoryToken(TimeOffRequest));
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  beforeEach(async () => {
    await repo.clear();
    jest.clearAllMocks();

    balanceService.reservePendingDays.mockResolvedValue(mockBalance);
    balanceService.releasePendingDays.mockResolvedValue(mockBalance);
    balanceService.confirmDeduction.mockResolvedValue(mockBalance);
    balanceService.getBalance.mockResolvedValue({
      balance: mockBalance,
      isStale: false,
    });
    hcmService.submitDeduction.mockResolvedValue({
      success: true,
      newBalance: 7,
      version: 'v2',
    });
  });

  const baseDto = {
    employeeId: 'emp_1',
    locationId: 'loc_1',
    leaveType: 'annual',
    startDate: '2026-05-10',
    endDate: '2026-05-14',
    daysRequested: 3,
  };

  describe('createRequest', () => {
    it('should create a PENDING request and reserve balance', async () => {
      const result = await service.createRequest(baseDto);
      expect(result.status).toBe(RequestStatus.PENDING);
      expect(result.daysRequested).toBe(3);
      expect(balanceService.reservePendingDays).toHaveBeenCalledWith(
        'emp_1',
        'loc_1',
        3,
      );
    });

    it('should return 422 when balance is insufficient', async () => {
      const error: any = new Error('Insufficient');
      error.code = 'INSUFFICIENT_BALANCE';
      error.availableBalance = 2;
      error.requestedDays = 5;
      balanceService.reservePendingDays.mockRejectedValue(error);

      await expect(
        service.createRequest({ ...baseDto, daysRequested: 5 }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should handle idempotency key - return existing on duplicate', async () => {
      const idempotencyKey = 'idem-key-123';
      const first = await service.createRequest({
        ...baseDto,
        idempotencyKey,
      });

      balanceService.reservePendingDays.mockClear();

      const second = await service.createRequest({
        ...baseDto,
        idempotencyKey,
      });

      expect(second.id).toBe(first.id);
      expect(balanceService.reservePendingDays).not.toHaveBeenCalled();
    });
  });

  describe('approveRequest', () => {
    it('should approve and deduct via HCM', async () => {
      const created = await service.createRequest(baseDto);

      const result = await service.approveRequest(created.id, 'mgr_1');
      expect(result.status).toBe(RequestStatus.APPROVED);
      expect(result.managerId).toBe('mgr_1');
      expect(hcmService.submitDeduction).toHaveBeenCalled();
      expect(balanceService.confirmDeduction).toHaveBeenCalled();
    });

    it('should set HCM_FAILED when HCM rejects deduction', async () => {
      hcmService.submitDeduction.mockResolvedValue({
        success: false,
        error: 'Insufficient balance',
        errorCode: 'HCM_422',
      });

      const created = await service.createRequest(baseDto);
      const result = await service.approveRequest(created.id, 'mgr_1');
      expect(result.status).toBe(RequestStatus.HCM_FAILED);
      expect(balanceService.releasePendingDays).toHaveBeenCalled();
    });

    it('should set HCM_FAILED when HCM times out', async () => {
      const error: any = new Error('HCM service timeout');
      error.code = 'HCM_TIMEOUT';
      hcmService.submitDeduction.mockRejectedValue(error);

      const created = await service.createRequest(baseDto);
      const result = await service.approveRequest(created.id, 'mgr_1');
      expect(result.status).toBe(RequestStatus.HCM_FAILED);
    });

    it('should reject approval of non-PENDING request', async () => {
      const created = await service.createRequest(baseDto);
      await service.approveRequest(created.id, 'mgr_1');

      await expect(
        service.approveRequest(created.id, 'mgr_1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('rejectRequest', () => {
    it('should reject and release pending days', async () => {
      const created = await service.createRequest(baseDto);

      const result = await service.rejectRequest(created.id, 'mgr_1', 'Not needed');
      expect(result.status).toBe(RequestStatus.REJECTED);
      expect(balanceService.releasePendingDays).toHaveBeenCalled();
    });
  });

  describe('cancelRequest', () => {
    it('should cancel a PENDING request and release pending days', async () => {
      const created = await service.createRequest(baseDto);

      const result = await service.cancelRequest(created.id);
      expect(result.status).toBe(RequestStatus.CANCELLED);
      expect(balanceService.releasePendingDays).toHaveBeenCalled();
    });

    it('should fail to cancel an already REJECTED request', async () => {
      const created = await service.createRequest(baseDto);
      await service.rejectRequest(created.id, 'mgr_1');

      await expect(service.cancelRequest(created.id)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getRequest', () => {
    it('should return a request by id', async () => {
      const created = await service.createRequest(baseDto);
      const result = await service.getRequest(created.id);
      expect(result.id).toBe(created.id);
    });

    it('should throw NotFoundException for unknown id', async () => {
      await expect(service.getRequest('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listRequests', () => {
    it('should filter by employeeId', async () => {
      await service.createRequest(baseDto);
      await service.createRequest({ ...baseDto, employeeId: 'emp_2' });

      const result = await service.listRequests({ employeeId: 'emp_1' });
      expect(result).toHaveLength(1);
      expect(result[0].employeeId).toBe('emp_1');
    });

    it('should filter by status', async () => {
      const created = await service.createRequest(baseDto);
      await service.rejectRequest(created.id, 'mgr_1');

      const pending = await service.listRequests({
        status: RequestStatus.PENDING,
      });
      expect(pending).toHaveLength(0);

      const rejected = await service.listRequests({
        status: RequestStatus.REJECTED,
      });
      expect(rejected).toHaveLength(1);
    });
  });
});
