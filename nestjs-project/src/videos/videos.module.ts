import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoProcessingWorker } from './processing/video.processor';
import {
  PROCESS_VIDEO_BACKOFF_MS,
  PROCESS_VIDEO_MAX_ATTEMPTS,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    StorageModule,
    BullModule.registerQueue({
      name: VIDEO_PROCESSING_QUEUE,
      defaultJobOptions: {
        attempts: PROCESS_VIDEO_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: PROCESS_VIDEO_BACKOFF_MS },
      },
    }),
  ],
  controllers: [VideosController],
  providers: [VideosService, VideoProcessingWorker],
  exports: [TypeOrmModule],
})
export class VideosModule {}
