import {
  Controller,
  Post,
  Param,
  Body,
  Headers,
  UnauthorizedException,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SyncService } from './sync.service';
import { BatchSyncDto } from './dto/batch-sync.dto';
import { WebhookPayloadDto } from './dto/webhook-payload.dto';

@Controller('api/v1/time-off')
export class SyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly configService: ConfigService,
  ) {}

  @Post('balances/sync/batch')
  @HttpCode(HttpStatus.OK)
  async batchSync(@Body() dto: BatchSyncDto) {
    return this.syncService.batchSync(dto.balances, 'MANUAL');
  }

  @Post('balances/sync/realtime/:employeeId/:locationId')
  @HttpCode(HttpStatus.OK)
  async realtimeSync(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ) {
    return this.syncService.realtimeSync(employeeId, locationId, 'MANUAL');
  }

  @Post('webhooks/hcm/balance-update')
  @HttpCode(HttpStatus.OK)
  async webhook(
    @Body() payload: WebhookPayloadDto,
    @Headers('x-api-key') apiKey: string,
  ) {
    const expectedKey = this.configService.get<string>(
      'HCM_WEBHOOK_API_KEY',
      'test-api-key',
    );
    if (apiKey !== expectedKey) {
      throw new UnauthorizedException('Invalid API key');
    }
    return this.syncService.handleWebhook(payload);
  }
}
