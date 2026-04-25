import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpException,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { MockHcmService } from './mock-hcm.service';

@Controller()
export class MockHcmController {
  constructor(private readonly hcmService: MockHcmService) {}

  @Get('hcm/balances/:employeeId/:locationId')
  async getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
  ) {
    await this.applyFailureMode();

    const balance = this.hcmService.getBalance(employeeId, locationId);
    if (!balance) {
      throw new HttpException(
        {
          message: `Balance not found for ${employeeId}/${locationId}`,
          errorCode: 'BALANCE_NOT_FOUND',
        },
        HttpStatus.NOT_FOUND,
      );
    }
    return balance;
  }

  @Post('hcm/balances/:employeeId/:locationId')
  @HttpCode(HttpStatus.OK)
  async submitDeduction(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Body() body: { days: number; version?: string },
  ) {
    await this.applyFailureMode();

    const result = this.hcmService.deductBalance(
      employeeId,
      locationId,
      body.days,
    );

    if (!result.success) {
      throw new HttpException(
        {
          message: result.error,
          errorCode: result.errorCode,
        },
        result.errorCode === 'BALANCE_NOT_FOUND'
          ? HttpStatus.NOT_FOUND
          : HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return result;
  }

  @Get('hcm/balances/batch')
  async getBatchBalances() {
    await this.applyFailureMode();
    return this.hcmService.getAllBalances();
  }

  // --- Test-only control endpoints ---

  @Post('hcm-mock/set-balance')
  @HttpCode(HttpStatus.OK)
  setBalance(
    @Body()
    body: {
      employeeId: string;
      locationId: string;
      availableDays: number;
    },
  ) {
    return this.hcmService.setBalance(
      body.employeeId,
      body.locationId,
      body.availableDays,
    );
  }

  @Post('hcm-mock/set-failure-mode')
  @HttpCode(HttpStatus.OK)
  setFailureMode(
    @Body() body: { mode: string; delayMs?: number },
  ) {
    this.hcmService.setFailureMode(
      body.mode as any,
      body.delayMs ?? 0,
    );
    return { status: 'ok', mode: body.mode };
  }

  @Post('hcm-mock/reset')
  @HttpCode(HttpStatus.OK)
  reset() {
    this.hcmService.reset();
    return { status: 'ok' };
  }

  private async applyFailureMode(): Promise<void> {
    const { mode, delay } = this.hcmService.getFailureMode();

    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    switch (mode) {
      case 'timeout':
        await new Promise((resolve) => setTimeout(resolve, 30000));
        break;
      case 'server_error':
        throw new HttpException(
          'Internal Server Error',
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
      case 'malformed':
        throw new HttpException(
          'x{invalid-json-response',
          HttpStatus.OK,
        );
      default:
        break;
    }
  }
}
