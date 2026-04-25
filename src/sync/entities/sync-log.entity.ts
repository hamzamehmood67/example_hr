import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export enum SyncType {
  BATCH = 'BATCH',
  REALTIME = 'REALTIME',
  RECONCILE = 'RECONCILE',
}

export enum SyncStatus {
  SUCCESS = 'SUCCESS',
  PARTIAL = 'PARTIAL',
  FAILED = 'FAILED',
}

@Entity('sync_log')
export class SyncLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  sync_type: SyncType;

  @Column()
  triggered_by: string;

  @Column({ default: 0 })
  records_received: number;

  @Column({ default: 0 })
  records_updated: number;

  @Column({ default: 0 })
  conflicts_detected: number;

  @Column({ type: 'varchar' })
  status: SyncStatus;

  @Column({ type: 'simple-json', nullable: true })
  error_detail: Record<string, unknown> | null;

  @Column({ type: 'datetime', nullable: true })
  completed_at: Date | null;

  @CreateDateColumn()
  created_at: Date;
}
