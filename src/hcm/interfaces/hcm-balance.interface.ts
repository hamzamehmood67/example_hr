export interface HcmBalance {
  employeeId: string;
  locationId: string;
  availableDays: number;
  version: string;
}

export interface HcmDeductionResult {
  success: boolean;
  newBalance?: number;
  version?: string;
  error?: string;
  errorCode?: string;
}

export interface HcmBatchPayload {
  balances: HcmBalance[];
  batchId: string;
  timestamp: string;
}
