export class BalanceResponseDto {
  id: string;
  employeeId: string;
  locationId: string;
  availableDays: number;
  pendingDays: number;
  effectiveBalance: number;
  lastSyncedAt: string | null;
  isStale: boolean;
}
