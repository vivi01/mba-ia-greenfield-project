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

// The BullMQ processor runs ONLY in the dedicated worker container (per
// `phase-03-videos/TD-06`); the entrypoint sets VIDEO_WORKER=true. The API and
// the test AppModule leave it unset, so they enqueue jobs but never consume
// them — keeping FFmpeg processing (and its Redis worker connection) out of the
// request path and out of the test process.
const isVideoWorker = process.env.VIDEO_WORKER === 'true';

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
  providers: [VideosService, ...(isVideoWorker ? [VideoProcessingWorker] : [])],
  exports: [TypeOrmModule],
})
export class VideosModule {}
