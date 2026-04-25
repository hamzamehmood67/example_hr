import { Module } from '@nestjs/common';
import { MockHcmController } from './mock-hcm.controller';
import { MockHcmService } from './mock-hcm.service';

@Module({
  controllers: [MockHcmController],
  providers: [MockHcmService],
  exports: [MockHcmService],
})
export class MockHcmModule {}
