import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { RequestService } from './request.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { ListRequestsQueryDto } from './dto/list-requests-query.dto';
import { ApproveRequestDto } from './dto/approve-request.dto';
import { RejectRequestDto } from './dto/reject-request.dto';

@Controller('api/v1/time-off/requests')
export class RequestController {
  constructor(private readonly requestService: RequestService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateRequestDto) {
    return this.requestService.createRequest(dto);
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    return this.requestService.getRequest(id);
  }

  @Get()
  async list(@Query() query: ListRequestsQueryDto) {
    return this.requestService.listRequests(query);
  }

  @Patch(':id/approve')
  async approve(
    @Param('id') id: string,
    @Body() dto: ApproveRequestDto,
  ) {
    return this.requestService.approveRequest(id, dto.managerId);
  }

  @Patch(':id/reject')
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectRequestDto,
  ) {
    return this.requestService.rejectRequest(
      id,
      dto.managerId,
      dto.reason,
    );
  }

  @Delete(':id')
  async cancel(@Param('id') id: string) {
    return this.requestService.cancelRequest(id);
  }
}
