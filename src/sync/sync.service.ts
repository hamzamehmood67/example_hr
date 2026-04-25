import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { SyncLog, SyncType, SyncStatus } from './entities/sync-log.entity';
import { BalanceService } from '../balance/balance.service';
import { HcmService } from '../hcm/hcm.service';
import { BatchBalanceItemDto } from './dto/batch-sync.dto';
import { WebhookPayloadDto } from './dto/webhook-payload.dto';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    @InjectRepository(SyncLog)
    private readonly syncLogRepo: Repository<SyncLog>,
    private readonly balanceService: BalanceService,
    private readonly hcmService: HcmService,
    private readonly configService: ConfigService,
  ) {}

  async batchSync(
    balances: BatchBalanceItemDto[],
    triggeredBy: string = 'SYSTEM',
  ): Promise<SyncLog> {
    const syncLog = this.syncLogRepo.create({
      sync_type: SyncType.BATCH,
      triggered_by: triggeredBy,
      records_received: balances.length,
      records_updated: 0,
      conflicts_detected: 0,
      status: SyncStatus.SUCCESS,
    });

    let updated = 0;
    let conflicts = 0;
    const errors: Record<string, string>[] = [];

    for (const item of balances) {
      try {
        const result = await this.balanceService.updateFromHcm(
          item.employeeId,
          item.locationId,
          item.availableDays,
          item.version ?? null,
        );
        updated++;
        if (result.conflictDetected) {
          conflicts++;
        }
      } catch (error: any) {
        errors.push({
          employeeId: item.employeeId,
          locationId: item.locationId,
          error: error.message,
        });
      }
    }

    syncLog.records_updated = updated;
    syncLog.conflicts_detected = conflicts;
    syncLog.completed_at = new Date();

    if (errors.length > 0 && updated > 0) {
      syncLog.status = SyncStatus.PARTIAL;
      syncLog.error_detail = { errors };
    } else if (errors.length > 0 && updated === 0) {
      syncLog.status = SyncStatus.FAILED;
      syncLog.error_detail = { errors };
    }

    return this.syncLogRepo.save(syncLog);
  }

  async realtimeSync(
    employeeId: string,
    locationId: string,
    triggeredBy: string = 'SYSTEM',
  ): Promise<SyncLog> {
    const syncLog = this.syncLogRepo.create({
      sync_type: SyncType.REALTIME,
      triggered_by: triggeredBy,
      records_received: 1,
      records_updated: 0,
      conflicts_detected: 0,
      status: SyncStatus.SUCCESS,
    });

    try {
      const hcmData = await this.hcmService.getBalance(
        employeeId,
        locationId,
      );
      const result = await this.balanceService.updateFromHcm(
        employeeId,
        locationId,
        hcmData.availableDays,
        hcmData.version,
      );
      syncLog.records_updated = 1;
      if (result.conflictDetected) {
        syncLog.conflicts_detected = 1;
      }
    } catch (error: any) {
      syncLog.status = SyncStatus.FAILED;
      syncLog.error_detail = { error: error.message };
    }

    syncLog.completed_at = new Date();
    return this.syncLogRepo.save(syncLog);
  }

  async handleWebhook(payload: WebhookPayloadDto): Promise<SyncLog> {
    const syncLog = this.syncLogRepo.create({
      sync_type: SyncType.REALTIME,
      triggered_by: 'HCM_WEBHOOK',
      records_received: 1,
      records_updated: 0,
      conflicts_detected: 0,
      status: SyncStatus.SUCCESS,
    });

    try {
      const result = await this.balanceService.updateFromHcm(
        payload.employeeId,
        payload.locationId,
        payload.availableDays,
        payload.version ?? null,
      );
      syncLog.records_updated = 1;
      if (result.conflictDetected) {
        syncLog.conflicts_detected = 1;
      }
    } catch (error: any) {
      syncLog.status = SyncStatus.FAILED;
      syncLog.error_detail = { error: error.message };
    }

    syncLog.completed_at = new Date();
    return this.syncLogRepo.save(syncLog);
  }

  @Cron('0 */15 * * * *')
  async scheduledBatchSync(): Promise<void> {
    this.logger.log('Starting scheduled batch sync');
    try {
      const hcmBalances = await this.hcmService.fetchBatchBalances();
      const items: BatchBalanceItemDto[] = hcmBalances.map((b) => ({
        employeeId: b.employeeId,
        locationId: b.locationId,
        availableDays: b.availableDays,
        version: b.version,
      }));
      await this.batchSync(items, 'SYSTEM');
      this.logger.log('Scheduled batch sync completed');
    } catch (error: any) {
      this.logger.error('Scheduled batch sync failed', error.message);
    }
  }
}
