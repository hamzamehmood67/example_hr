import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class RejectRequestDto {
  @IsString()
  @IsNotEmpty()
  managerId: string;

  @IsString()
  @IsOptional()
  reason?: string;
}
