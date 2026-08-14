import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { workerEnvironmentSchema } from './config/worker-environment.schema';
import { WorkerEventsService } from './events/worker-events.service';
import { ImageCompressorService } from './pipeline/image-compressor.service';
import { QueueConsumerService } from './queue/queue-consumer.service';
import { workerSqsClientProvider } from './queue/worker-sqs.client';
import { WorkerObjectStorageService } from './storage/worker-object-storage.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: workerEnvironmentSchema,
      validationOptions: {
        abortEarly: false,
        allowUnknown: true,
      },
    }),
  ],
  providers: [
    workerSqsClientProvider,
    ImageCompressorService,
    QueueConsumerService,
    WorkerEventsService,
    WorkerObjectStorageService,
  ],
})
export class AppModule {}
