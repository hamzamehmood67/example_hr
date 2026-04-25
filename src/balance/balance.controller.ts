import {
  Controller,
  Get,
  Param,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { BalanceService } from './balance.service';

@Controller('api/v1/time-off/balances')
export class BalanceController {
  constructor(private readonly balanceService: BalanceService) {}

  @Get(':employeeId')
  async getBalances(
    @Param('employeeId') employeeId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { balances, isStale } =
      await this.balanceService.getBalances(employeeId);

    if (isStale) {
      res.setHeader('X-Balance-Stale', 'true');
    }

    return balances.map((b) =>
      this.balanceService.toDto(b, isStale),
    );
  }

  @Get(':employeeId/:locationId')
  async getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { balance, isStale } =
      await this.balanceService.getBalance(employeeId, locationId);

    if (isStale) {
      res.setHeader('X-Balance-Stale', 'true');
    }

    return this.balanceService.toDto(balance, isStale);
  }
}
