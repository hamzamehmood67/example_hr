import { IsString, IsNumber, IsOptional } from 'class-validator';

export class WebhookPayloadDto {
  @IsString()
  employeeId: string;

  @IsString()
  locationId: string;

  @IsNumber()
  availableDays: number;

  @IsString()
  @IsOptional()
  version?: string;

  @IsString()
  @IsOptional()
  reason?: string;
}
