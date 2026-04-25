import { IsOptional, IsString, IsEnum } from 'class-validator';
import { RequestStatus } from '../entities/time-off-request.entity';

export class ListRequestsQueryDto {
  @IsOptional()
  @IsString()
  employeeId?: string;

  @IsOptional()
  @IsEnum(RequestStatus)
  status?: RequestStatus;
}
