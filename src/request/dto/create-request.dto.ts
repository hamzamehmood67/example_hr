import { IsString, IsNotEmpty, IsNumber, IsPositive, IsDateString, IsOptional } from 'class-validator';

export class CreateRequestDto {
  @IsString()
  @IsNotEmpty()
  employeeId: string;

  @IsString()
  @IsNotEmpty()
  locationId: string;

  @IsString()
  @IsNotEmpty()
  leaveType: string;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsNumber()
  @IsPositive()
  daysRequested: number;

  @IsString()
  @IsOptional()
  idempotencyKey?: string;
}
