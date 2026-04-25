import { Test } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of, throwError } from 'rxjs';
import { AxiosError, AxiosHeaders, AxiosResponse } from 'axios';
import { HcmService } from './hcm.service';

describe('HcmService', () => {
  let service: HcmService;
  let httpService: { get: jest.Mock; post: jest.Mock };

  beforeEach(async () => {
    httpService = {
      get: jest.fn(),
      post: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        HcmService,
        { provide: HttpService, useValue: httpService },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def: any) => {
              const map: Record<string, any> = {
                HCM_BASE_URL: 'http://localhost:3001',
                HCM_TIMEOUT_MS: 3000,
              };
              return map[key] ?? def;
            }),
          },
        },
      ],
    }).compile();

    service = module.get(HcmService);
  });

  function makeAxiosResponse<T>(data: T): AxiosResponse<T> {
    return {
      data,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: { headers: new AxiosHeaders() },
    };
  }

  describe('getBalance', () => {
    it('should fetch balance from HCM', async () => {
      const balanceData = {
        employeeId: 'emp_1',
        locationId: 'loc_1',
        availableDays: 10,
        version: 'v1',
      };
      httpService.get.mockReturnValue(of(makeAxiosResponse(balanceData)));

      const result = await service.getBalance('emp_1', 'loc_1');
      expect(result).toEqual(balanceData);
    });

    it('should throw mapped error on timeout', async () => {
      const axiosError = new AxiosError(
        'timeout',
        'ECONNABORTED',
      );
      httpService.get.mockReturnValue(throwError(() => axiosError));

      await expect(service.getBalance('emp_1', 'loc_1')).rejects.toThrow(
        'HCM service timeout',
      );
    });

    it('should throw mapped error when HCM is unavailable', async () => {
      const axiosError = new AxiosError('connect error', 'ECONNREFUSED');
      httpService.get.mockReturnValue(throwError(() => axiosError));

      await expect(service.getBalance('emp_1', 'loc_1')).rejects.toThrow(
        'HCM service unavailable',
      );
    });
  });

  describe('submitDeduction', () => {
    it('should submit deduction and return result', async () => {
      const result = { success: true, newBalance: 7, version: 'v2' };
      httpService.post.mockReturnValue(of(makeAxiosResponse(result)));

      const response = await service.submitDeduction('emp_1', 'loc_1', 3, 'v1');
      expect(response).toEqual(result);
    });

    it('should return failure result on 422 from HCM', async () => {
      const axiosError = new AxiosError('error', 'ERR_BAD_REQUEST');
      axiosError.response = {
        status: 422,
        data: { message: 'Insufficient balance', errorCode: 'INSUFFICIENT_BALANCE' },
        statusText: 'Unprocessable Entity',
        headers: {},
        config: { headers: new AxiosHeaders() },
      };
      httpService.post.mockReturnValue(throwError(() => axiosError));

      const response = await service.submitDeduction('emp_1', 'loc_1', 15, 'v1');
      expect(response.success).toBe(false);
      expect(response.errorCode).toBe('INSUFFICIENT_BALANCE');
    });

    it('should return failure result on 409 conflict', async () => {
      const axiosError = new AxiosError('error', 'ERR_BAD_REQUEST');
      axiosError.response = {
        status: 409,
        data: { message: 'Version conflict' },
        statusText: 'Conflict',
        headers: {},
        config: { headers: new AxiosHeaders() },
      };
      httpService.post.mockReturnValue(throwError(() => axiosError));

      const response = await service.submitDeduction('emp_1', 'loc_1', 3, 'v_old');
      expect(response.success).toBe(false);
    });
  });

  describe('submitDeduction - additional errors', () => {
    it('should throw on 500 server error from HCM', async () => {
      const axiosError = new AxiosError('error', 'ERR_BAD_RESPONSE');
      axiosError.response = {
        status: 500,
        data: { message: 'Internal Server Error' },
        statusText: 'Internal Server Error',
        headers: {},
        config: { headers: new AxiosHeaders() },
      };
      httpService.post.mockReturnValue(throwError(() => axiosError));

      await expect(
        service.submitDeduction('emp_1', 'loc_1', 3, 'v1'),
      ).rejects.toThrow('Internal Server Error');
    });
  });

  describe('getBalance - 404 from HCM', () => {
    it('should throw mapped error with HCM_404 code', async () => {
      const axiosError = new AxiosError('error', 'ERR_BAD_REQUEST');
      axiosError.response = {
        status: 404,
        data: { message: 'Employee not found' },
        statusText: 'Not Found',
        headers: {},
        config: { headers: new AxiosHeaders() },
      };
      httpService.get.mockReturnValue(throwError(() => axiosError));

      try {
        await service.getBalance('emp_missing', 'loc_1');
        fail('Should have thrown');
      } catch (err: any) {
        expect(err.message).toBe('Employee not found');
        expect(err.code).toBe('HCM_404');
      }
    });
  });

  describe('fetchBatchBalances', () => {
    it('should fetch all balances', async () => {
      const data = [
        { employeeId: 'emp_1', locationId: 'loc_1', availableDays: 10, version: 'v1' },
        { employeeId: 'emp_2', locationId: 'loc_2', availableDays: 5, version: 'v1' },
      ];
      httpService.get.mockReturnValue(of(makeAxiosResponse(data)));

      const result = await service.fetchBatchBalances();
      expect(result).toHaveLength(2);
    });
  });

  describe('mapError - edge cases', () => {
    it('should handle non-AxiosError by returning it as-is', async () => {
      const plainError = new Error('DB connection failed');
      httpService.get.mockReturnValue(throwError(() => plainError));

      await expect(
        service.getBalance('emp_1', 'loc_1'),
      ).rejects.toThrow('DB connection failed');
    });

    it('should wrap non-Error values in an Error', async () => {
      httpService.get.mockReturnValue(throwError(() => 'string error'));

      await expect(
        service.getBalance('emp_1', 'loc_1'),
      ).rejects.toThrow('string error');
    });
  });
});
