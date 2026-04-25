export class RequestResponseDto {
  id: string;
  employeeId: string;
  locationId: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  daysRequested: number;
  status: string;
  managerId: string | null;
  availableBalance?: number;
  pendingAfterRequest?: number;
  message?: string;
  createdAt: string;
  updatedAt: string;
}
