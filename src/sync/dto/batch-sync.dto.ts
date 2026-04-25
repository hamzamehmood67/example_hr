import { IsArray, ValidateNested, IsString, IsNumber, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class BatchBalanceItemDto {
  @IsString()
  employeeId: string;

  @IsString()
  locationId: string;

  @IsNumber()
  availableDays: number;

  @IsString()
  @IsOptional()
  version?: string;
}

export class BatchSyncDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchBalanceItemDto)
  balances: BatchBalanceItemDto[];

  @IsString()
  @IsOptional()
  batchId?: string;
}
