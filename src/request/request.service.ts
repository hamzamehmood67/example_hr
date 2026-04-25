import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere } from 'typeorm';
import {
  TimeOffRequest,
  RequestStatus,
} from './entities/time-off-request.entity';
import { BalanceService } from '../balance/balance.service';
import { HcmService } from '../hcm/hcm.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { RequestResponseDto } from './dto/request-response.dto';
import { ListRequestsQueryDto } from './dto/list-requests-query.dto';

@Injectable()
export class RequestService {
  private readonly logger = new Logger(RequestService.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    private readonly balanceService: BalanceService,
    private readonly hcmService: HcmService,
  ) {}

  async createRequest(dto: CreateRequestDto): Promise<RequestResponseDto> {
    if (dto.idempotencyKey) {
      const existing = await this.requestRepo.findOne({
        where: { idempotency_key: dto.idempotencyKey },
      });
      if (existing) {
        return this.toDto(existing);
      }
    }

    let balance;
    try {
      balance = await this.balanceService.reservePendingDays(
        dto.employeeId,
        dto.locationId,
        dto.daysRequested,
      );
    } catch (error: any) {
      if (error.code === 'INSUFFICIENT_BALANCE') {
        throw new UnprocessableEntityException({
          error: 'INSUFFICIENT_BALANCE',
          message: error.message,
          availableBalance: error.availableBalance,
          requestedDays: error.requestedDays,
        });
      }
      throw error;
    }

    const request = this.requestRepo.create({
      employee_id: dto.employeeId,
      location_id: dto.locationId,
      leave_type: dto.leaveType,
      start_date: dto.startDate,
      end_date: dto.endDate,
      days_requested: dto.daysRequested,
      status: RequestStatus.PENDING,
      idempotency_key: dto.idempotencyKey || null,
    });

    const saved = await this.requestRepo.save(request);

    const response = this.toDto(saved);
    response.availableBalance = Number(balance.available_days);
    response.pendingAfterRequest =
      Number(balance.available_days) - Number(balance.pending_days);
    response.message = 'Request submitted. Awaiting manager approval.';
    return response;
  }

  async approveRequest(
    requestId: string,
    managerId: string,
  ): Promise<RequestResponseDto> {
    const request = await this.findRequestOrFail(requestId);

    if (request.status !== RequestStatus.PENDING) {
      throw new BadRequestException(
        `Cannot approve request in ${request.status} status`,
      );
    }

    request.manager_id = managerId;

    try {
      const { balance } = await this.balanceService.getBalance(
        request.employee_id,
        request.location_id,
      );

      const result = await this.hcmService.submitDeduction(
        request.employee_id,
        request.location_id,
        Number(request.days_requested),
        balance.hcm_version,
      );

      request.hcm_submitted_at = new Date();
      request.hcm_response = result as unknown as Record<string, unknown>;

      if (result.success) {
        request.status = RequestStatus.APPROVED;
        await this.balanceService.confirmDeduction(
          request.employee_id,
          request.location_id,
          Number(request.days_requested),
        );
      } else {
        request.status = RequestStatus.HCM_FAILED;
        await this.balanceService.releasePendingDays(
          request.employee_id,
          request.location_id,
          Number(request.days_requested),
        );
      }
    } catch (error: any) {
      if (
        error.code === 'HCM_TIMEOUT' ||
        error.code === 'HCM_UNAVAILABLE'
      ) {
        request.status = RequestStatus.HCM_FAILED;
        request.hcm_response = {
          error: error.message,
          code: error.code,
        };
        await this.balanceService.releasePendingDays(
          request.employee_id,
          request.location_id,
          Number(request.days_requested),
        );
      } else {
        throw error;
      }
    }

    const saved = await this.requestRepo.save(request);
    return this.toDto(saved);
  }

  async rejectRequest(
    requestId: string,
    managerId: string,
    reason?: string,
  ): Promise<RequestResponseDto> {
    const request = await this.findRequestOrFail(requestId);

    if (request.status !== RequestStatus.PENDING) {
      throw new BadRequestException(
        `Cannot reject request in ${request.status} status`,
      );
    }

    request.status = RequestStatus.REJECTED;
    request.manager_id = managerId;
    if (reason) {
      request.hcm_response = { rejectionReason: reason };
    }

    await this.balanceService.releasePendingDays(
      request.employee_id,
      request.location_id,
      Number(request.days_requested),
    );

    const saved = await this.requestRepo.save(request);
    return this.toDto(saved);
  }

  async cancelRequest(requestId: string): Promise<RequestResponseDto> {
    const request = await this.findRequestOrFail(requestId);

    if (
      request.status !== RequestStatus.PENDING &&
      request.status !== RequestStatus.APPROVED
    ) {
      throw new BadRequestException(
        `Cannot cancel request in ${request.status} status`,
      );
    }

    const wasPending = request.status === RequestStatus.PENDING;
    request.status = RequestStatus.CANCELLED;

    if (wasPending) {
      await this.balanceService.releasePendingDays(
        request.employee_id,
        request.location_id,
        Number(request.days_requested),
      );
    }

    const saved = await this.requestRepo.save(request);
    return this.toDto(saved);
  }

  async getRequest(id: string): Promise<RequestResponseDto> {
    const request = await this.findRequestOrFail(id);
    return this.toDto(request);
  }

  async listRequests(
    query: ListRequestsQueryDto,
  ): Promise<RequestResponseDto[]> {
    const where: FindOptionsWhere<TimeOffRequest> = {};
    if (query.employeeId) {
      where.employee_id = query.employeeId;
    }
    if (query.status) {
      where.status = query.status;
    }

    const requests = await this.requestRepo.find({
      where,
      order: { created_at: 'DESC' },
    });

    return requests.map((r) => this.toDto(r));
  }

  private async findRequestOrFail(id: string): Promise<TimeOffRequest> {
    const request = await this.requestRepo.findOne({
      where: { id },
    });
    if (!request) {
      throw new NotFoundException(`Request ${id} not found`);
    }
    return request;
  }

  toDto(request: TimeOffRequest): RequestResponseDto {
    return {
      id: request.id,
      employeeId: request.employee_id,
      locationId: request.location_id,
      leaveType: request.leave_type,
      startDate: request.start_date,
      endDate: request.end_date,
      daysRequested: Number(request.days_requested),
      status: request.status,
      managerId: request.manager_id,
      createdAt: request.created_at?.toISOString?.() ?? String(request.created_at),
      updatedAt: request.updated_at?.toISOString?.() ?? String(request.updated_at),
    };
  }
}
