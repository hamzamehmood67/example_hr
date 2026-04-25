import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { LeaveBalance } from '../src/balance/entities/leave-balance.entity';
import { TimeOffRequest } from '../src/request/entities/time-off-request.entity';
import { SyncLog } from '../src/sync/entities/sync-log.entity';
import { MockHcmModule } from '../src/mock-hcm/mock-hcm.module';
import { MockHcmService } from '../src/mock-hcm/mock-hcm.service';

export const entities = [LeaveBalance, TimeOffRequest, SyncLog];

export function createTestDbModule() {
  return TypeOrmModule.forRoot({
    type: 'better-sqlite3',
    database: ':memory:',
    entities,
    synchronize: true,
    dropSchema: true,
  });
}

export function createTestConfigModule() {
  return ConfigModule.forRoot({
    isGlobal: true,
    load: [
      () => ({
        HCM_BASE_URL: 'http://localhost:4001',
        HCM_TIMEOUT_MS: 5000,
        BALANCE_STALENESS_THRESHOLD_MS: 300000,
        HCM_WEBHOOK_API_KEY: 'test-api-key',
      }),
    ],
  });
}

export async function createMockHcmApp(
  port = 4001,
): Promise<{ app: INestApplication; service: MockHcmService }> {
  const app = await NestFactory.create(MockHcmModule, { logger: false });
  await app.listen(port);
  const service = app.get(MockHcmService);
  return { app, service };
}

export async function createTestApp(
  module: TestingModule,
): Promise<INestApplication> {
  const app = module.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  await app.init();
  return app;
}
