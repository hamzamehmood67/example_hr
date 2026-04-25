import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { LeaveBalance } from './entities/leave-balance.entity';
import { HcmService } from '../hcm/hcm.service';
import { BalanceResponseDto } from './dto/balance-response.dto';

@Injectable()
export class BalanceService {
  private readonly logger = new Logger(BalanceService.name);
  private readonly stalenessThreshold: number;

  constructor(
    @InjectRepository(LeaveBalance)
    private readonly balanceRepo: Repository<LeaveBalance>,
    private readonly hcmService: HcmService,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    this.stalenessThreshold = this.configService.get<number>(
      'BALANCE_STALENESS_THRESHOLD_MS',
      300000,
    );
  }

  async getBalance(
    employeeId: string,
    locationId: string,
  ): Promise<{ balance: LeaveBalance; isStale: boolean }> {
    let balance = await this.balanceRepo.findOne({
      where: { employee_id: employeeId, location_id: locationId },
    });
    let isStale = false;

    if (!balance) {
      balance = await this.fetchAndStoreFromHcm(employeeId, locationId);
    } else if (this.isBalanceStale(balance)) {
      try {
        balance = await this.refreshFromHcm(balance);
      } catch {
        this.logger.warn(
          `HCM unavailable, serving stale balance for ${employeeId}/${locationId}`,
        );
        isStale = true;
      }
    }

    if (!balance) {
      throw new NotFoundException(
        `Balance not found for employee ${employeeId} at location ${locationId}`,
      );
    }

    return { balance, isStale };
  }

  async getBalances(
    employeeId: string,
  ): Promise<{ balances: LeaveBalance[]; isStale: boolean }> {
    const balances = await this.balanceRepo.find({
      where: { employee_id: employeeId },
    });

    let anyStale = false;
    for (const b of balances) {
      if (this.isBalanceStale(b)) {
        anyStale = true;
        break;
      }
    }

    return { balances, isStale: anyStale };
  }

  async reservePendingDays(
    employeeId: string,
    locationId: string,
    days: number,
  ): Promise<LeaveBalance> {
    return this.dataSource.transaction(async (manager) => {
      const balance = await manager.findOne(LeaveBalance, {
        where: { employee_id: employeeId, location_id: locationId },
      });

      if (!balance) {
        throw new NotFoundException(
          `Balance not found for ${employeeId}/${locationId}`,
        );
      }

      const effectiveBalance =
        Number(balance.available_days) - Number(balance.pending_days);
      if (effectiveBalance < days) {
        const error: any = new Error(
          `Employee has ${effectiveBalance.toFixed(1)} days available but requested ${days.toFixed(1)} days.`,
        );
        error.code = 'INSUFFICIENT_BALANCE';
        error.availableBalance = effectiveBalance;
        error.requestedDays = days;
        throw error;
      }

      balance.pending_days = Number(balance.pending_days) + days;
      return manager.save(LeaveBalance, balance);
    });
  }

  async releasePendingDays(
    employeeId: string,
    locationId: string,
    days: number,
  ): Promise<LeaveBalance> {
    return this.dataSource.transaction(async (manager) => {
      const balance = await manager.findOne(LeaveBalance, {
        where: { employee_id: employeeId, location_id: locationId },
      });

      if (!balance) {
        throw new NotFoundException(
          `Balance not found for ${employeeId}/${locationId}`,
        );
      }

      balance.pending_days = Math.max(
        0,
        Number(balance.pending_days) - days,
      );
      return manager.save(LeaveBalance, balance);
    });
  }

  async confirmDeduction(
    employeeId: string,
    locationId: string,
    days: number,
  ): Promise<LeaveBalance> {
    return this.dataSource.transaction(async (manager) => {
      const balance = await manager.findOne(LeaveBalance, {
        where: { employee_id: employeeId, location_id: locationId },
      });

      if (!balance) {
        throw new NotFoundException(
          `Balance not found for ${employeeId}/${locationId}`,
        );
      }

      balance.available_days = Number(balance.available_days) - days;
      balance.pending_days = Math.max(
        0,
        Number(balance.pending_days) - days,
      );
      return manager.save(LeaveBalance, balance);
    });
  }

  async updateFromHcm(
    employeeId: string,
    locationId: string,
    hcmAvailableDays: number,
    hcmVersion: string | null,
  ): Promise<{ balance: LeaveBalance; conflictDetected: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      let balance = await manager.findOne(LeaveBalance, {
        where: { employee_id: employeeId, location_id: locationId },
      });

      let conflictDetected = false;

      if (!balance) {
        balance = manager.create(LeaveBalance, {
          employee_id: employeeId,
          location_id: locationId,
          available_days: hcmAvailableDays,
          pending_days: 0,
          last_synced_at: new Date(),
          hcm_version: hcmVersion,
        });
      } else {
        const expectedTotal =
          Number(balance.available_days) + Number(balance.pending_days);

        if (
          Number(balance.pending_days) > 0 &&
          hcmAvailableDays < expectedTotal - Number(balance.pending_days)
        ) {
          conflictDetected = true;
        }

        balance.available_days = hcmAvailableDays;
        balance.last_synced_at = new Date();
        balance.hcm_version = hcmVersion;
      }

      balance = await manager.save(LeaveBalance, balance);
      return { balance, conflictDetected };
    });
  }

  async forceRealtimeSync(
    employeeId: string,
    locationId: string,
  ): Promise<LeaveBalance> {
    const hcmData = await this.hcmService.getBalance(
      employeeId,
      locationId,
    );
    const { balance } = await this.updateFromHcm(
      employeeId,
      locationId,
      hcmData.availableDays,
      hcmData.version,
    );
    return balance;
  }

  toDto(
    balance: LeaveBalance,
    isStale: boolean,
  ): BalanceResponseDto {
    return {
      id: balance.id,
      employeeId: balance.employee_id,
      locationId: balance.location_id,
      availableDays: Number(balance.available_days),
      pendingDays: Number(balance.pending_days),
      effectiveBalance:
        Number(balance.available_days) - Number(balance.pending_days),
      lastSyncedAt: balance.last_synced_at
        ? balance.last_synced_at.toISOString?.() ??
          String(balance.last_synced_at)
        : null,
      isStale,
    };
  }

  private isBalanceStale(balance: LeaveBalance): boolean {
    if (!balance.last_synced_at) return true;
    const syncedAt =
      balance.last_synced_at instanceof Date
        ? balance.last_synced_at.getTime()
        : new Date(balance.last_synced_at).getTime();
    return Date.now() - syncedAt > this.stalenessThreshold;
  }

  private async fetchAndStoreFromHcm(
    employeeId: string,
    locationId: string,
  ): Promise<LeaveBalance | null> {
    try {
      const hcmData = await this.hcmService.getBalance(
        employeeId,
        locationId,
      );
      const balance = this.balanceRepo.create({
        employee_id: employeeId,
        location_id: locationId,
        available_days: hcmData.availableDays,
        pending_days: 0,
        last_synced_at: new Date(),
        hcm_version: hcmData.version,
      });
      return this.balanceRepo.save(balance);
    } catch {
      this.logger.warn(
        `Could not fetch balance from HCM for ${employeeId}/${locationId}`,
      );
      return null;
    }
  }

  private async refreshFromHcm(
    balance: LeaveBalance,
  ): Promise<LeaveBalance> {
    const hcmData = await this.hcmService.getBalance(
      balance.employee_id,
      balance.location_id,
    );
    balance.available_days = hcmData.availableDays;
    balance.hcm_version = hcmData.version;
    balance.last_synced_at = new Date();
    return this.balanceRepo.save(balance);
  }
}
