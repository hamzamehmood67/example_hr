import { IsString, IsNotEmpty } from 'class-validator';

export class ApproveRequestDto {
  @IsString()
  @IsNotEmpty()
  managerId: string;
}
