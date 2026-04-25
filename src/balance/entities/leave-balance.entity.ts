import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';

@Entity('leave_balance')
@Unique(['employee_id', 'location_id'])
export class LeaveBalance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  employee_id: string;

  @Column()
  location_id: string;

  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  available_days: number;

  @Column('decimal', { precision: 10, scale: 2, default: 0 })
  pending_days: number;

  @Column({ type: 'datetime', nullable: true })
  last_synced_at: Date | null;

  @Column({ type: 'varchar', nullable: true })
  hcm_version: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
