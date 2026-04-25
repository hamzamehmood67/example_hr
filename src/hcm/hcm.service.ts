import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';
import {
  HcmBalance,
  HcmDeductionResult,
} from './interfaces/hcm-balance.interface';

@Injectable()
export class HcmService {
  private readonly logger = new Logger(HcmService.name);
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.baseUrl = this.configService.get<string>(
      'HCM_BASE_URL',
      'http://localhost:3001',
    );
    this.timeout = this.configService.get<number>('HCM_TIMEOUT_MS', 3000);
  }

  async getBalance(
    employeeId: string,
    locationId: string,
  ): Promise<HcmBalance> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<HcmBalance>(
          `${this.baseUrl}/hcm/balances/${employeeId}/${locationId}`,
          { timeout: this.timeout },
        ),
      );
      return data;
    } catch (error) {
      this.logger.error(
        `Failed to fetch HCM balance: ${employeeId}/${locationId}`,
      );
      throw this.mapError(error);
    }
  }

  async submitDeduction(
    employeeId: string,
    locationId: string,
    days: number,
    hcmVersion?: string | null,
  ): Promise<HcmDeductionResult> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.post<HcmDeductionResult>(
          `${this.baseUrl}/hcm/balances/${employeeId}/${locationId}`,
          { days, version: hcmVersion },
          { timeout: this.timeout },
        ),
      );
      return data;
    } catch (error) {
      if (error instanceof AxiosError && error.response) {
        const status = error.response.status;
        if (status === 409 || status === 422) {
          return {
            success: false,
            error:
              error.response.data?.message || 'HCM rejected deduction',
            errorCode:
              error.response.data?.errorCode || `HCM_${status}`,
          };
        }
      }
      this.logger.error(
        `Failed to submit deduction to HCM: ${employeeId}/${locationId}`,
      );
      throw this.mapError(error);
    }
  }

  async fetchBatchBalances(): Promise<HcmBalance[]> {
    try {
      const { data } = await firstValueFrom(
        this.httpService.get<HcmBalance[]>(
          `${this.baseUrl}/hcm/balances/batch`,
          { timeout: this.timeout * 10 },
        ),
      );
      return data;
    } catch (error) {
      this.logger.error('Failed to fetch batch balances from HCM');
      throw this.mapError(error);
    }
  }

  private mapError(error: unknown): Error {
    if (error instanceof AxiosError) {
      if (
        error.code === 'ECONNABORTED' ||
        error.code === 'ETIMEDOUT'
      ) {
        const err: any = new Error('HCM service timeout');
        err.code = 'HCM_TIMEOUT';
        return err;
      }
      if (!error.response) {
        const err: any = new Error('HCM service unavailable');
        err.code = 'HCM_UNAVAILABLE';
        return err;
      }
      const err: any = new Error(
        error.response.data?.message || 'HCM error',
      );
      err.code = `HCM_${error.response.status}`;
      err.status = error.response.status;
      return err;
    }
    if (error instanceof Error) return error;
    return new Error(String(error));
  }
}
