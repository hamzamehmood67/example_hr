import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum RequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
  HCM_FAILED = 'HCM_FAILED',
}

@Entity('time_off_request')
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  employee_id: string;

  @Column()
  location_id: string;

  @Column()
  leave_type: string;

  @Column({ type: 'date' })
  start_date: string;

  @Column({ type: 'date' })
  end_date: string;

  @Column('decimal', { precision: 10, scale: 2 })
  days_requested: number;

  @Column({ type: 'varchar', default: RequestStatus.PENDING })
  status: RequestStatus;

  @Column({ type: 'varchar', nullable: true })
  manager_id: string | null;

  @Column({ type: 'datetime', nullable: true })
  hcm_submitted_at: Date | null;

  @Column({ type: 'simple-json', nullable: true })
  hcm_response: Record<string, unknown> | null;

  @Column({ type: 'varchar', nullable: true, unique: true })
  idempotency_key: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
