import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import type { ProcessVideoJobData } from '../videos.service';
import {
  PROCESS_VIDEO_MAX_ATTEMPTS,
  VIDEO_PROCESSING_QUEUE,
  thumbnailKey,
} from '../videos.constants';
import { extractThumbnail, probeMetadata } from './ffmpeg.util';

const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

/**
 * Consumes `process-video` jobs on the isolated worker container (per
 * `phase-03-videos/TD-06`): downloads the original, extracts duration/metadata
 * via `ffprobe`, generates a thumbnail via `ffmpeg`, uploads it, and moves the
 * video to `ready`. On exhausted retries it moves the video to `error` (per
 * `phase-03-videos/TD-05`).
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingWorker extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingWorker.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId, storageKey } = job.data;
    const workDir = await mkdtemp(join(tmpdir(), 'video-'));
    const originalPath = join(workDir, 'original');
    const thumbnailPath = join(workDir, 'thumbnail.jpg');

    try {
      const sizeBytes = await this.storage.downloadToFile(
        storageKey,
        originalPath,
      );
      const { durationSeconds, metadata } = await probeMetadata(originalPath);
      await extractThumbnail(originalPath, thumbnailPath);

      const key = thumbnailKey(videoId);
      const thumbnail = await readFile(thumbnailPath);
      await this.storage.putObject(key, thumbnail, THUMBNAIL_CONTENT_TYPE);

      // Load-mutate-save (not `update`): assigning the jsonb `metadata` field
      // directly type-checks cleanly, unlike TypeORM's QueryDeepPartialEntity.
      const video = await this.videoRepository.findOneByOrFail({ id: videoId });
      video.status = 'ready';
      video.duration_seconds = durationSeconds;
      video.metadata = metadata;
      video.thumbnail_key = key;
      video.size_bytes = sizeBytes;
      await this.videoRepository.save(video);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Fires on every failed attempt. Only once the retries are exhausted does the
   * video transition to `error` — transient failures stay out of the status
   * enum (per `phase-03-videos/TD-01`, `TD-05`). Never rethrows: an event
   * handler that throws would crash the worker (per `.claude/rules/nestjs-services.md`).
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>, error: Error): Promise<void> {
    const maxAttempts = job.opts.attempts ?? PROCESS_VIDEO_MAX_ATTEMPTS;
    if (job.attemptsMade < maxAttempts) {
      return;
    }

    try {
      await this.videoRepository.update(job.data.videoId, {
        status: 'error',
        error_reason: error.message,
      });
    } catch (updateError) {
      this.logger.error(
        `Failed to mark video ${job.data.videoId} as error`,
        updateError instanceof Error ? updateError.stack : undefined,
      );
    }
  }
}
