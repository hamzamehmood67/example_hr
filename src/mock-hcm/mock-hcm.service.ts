import { Injectable } from '@nestjs/common';

export interface BalanceRecord {
  employeeId: string;
  locationId: string;
  availableDays: number;
  version: string;
}

type FailureMode =
  | 'none'
  | 'timeout'
  | 'server_error'
  | 'malformed';

@Injectable()
export class MockHcmService {
  private balances = new Map<string, BalanceRecord>();
  private failureMode: FailureMode = 'none';
  private failureDelay = 0;
  private versionCounter = 1;

  private key(employeeId: string, locationId: string): string {
    return `${employeeId}:${locationId}`;
  }

  setBalance(
    employeeId: string,
    locationId: string,
    availableDays: number,
  ): BalanceRecord {
    const version = `v${this.versionCounter++}`;
    const record: BalanceRecord = {
      employeeId,
      locationId,
      availableDays,
      version,
    };
    this.balances.set(this.key(employeeId, locationId), record);
    return record;
  }

  getBalance(
    employeeId: string,
    locationId: string,
  ): BalanceRecord | null {
    return this.balances.get(this.key(employeeId, locationId)) ?? null;
  }

  deductBalance(
    employeeId: string,
    locationId: string,
    days: number,
  ): { success: boolean; newBalance?: number; version?: string; error?: string; errorCode?: string } {
    const record = this.balances.get(this.key(employeeId, locationId));
    if (!record) {
      return {
        success: false,
        error: `No balance found for ${employeeId}/${locationId}`,
        errorCode: 'BALANCE_NOT_FOUND',
      };
    }

    if (record.availableDays < days) {
      return {
        success: false,
        error: `Insufficient balance: ${record.availableDays} < ${days}`,
        errorCode: 'INSUFFICIENT_BALANCE',
      };
    }

    record.availableDays -= days;
    record.version = `v${this.versionCounter++}`;
    return {
      success: true,
      newBalance: record.availableDays,
      version: record.version,
    };
  }

  getAllBalances(): BalanceRecord[] {
    return Array.from(this.balances.values());
  }

  setFailureMode(mode: FailureMode, delayMs = 0): void {
    this.failureMode = mode;
    this.failureDelay = delayMs;
  }

  getFailureMode(): { mode: FailureMode; delay: number } {
    return { mode: this.failureMode, delay: this.failureDelay };
  }

  reset(): void {
    this.balances.clear();
    this.failureMode = 'none';
    this.failureDelay = 0;
    this.versionCounter = 1;
  }
}
