import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  InvalidUploadStateException,
  UnsupportedVideoFormatException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import type { PresignedPart } from '../storage/storage.service';
import { StorageService } from '../storage/storage.service';
import type { CompleteUploadDto } from './dto/complete-upload.dto';
import type { InitUploadDto } from './dto/init-upload.dto';
import { Video } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import {
  ATTACHMENT_DISPOSITION,
  DELIVERY_URL_TTL_SECONDS,
  MAX_PUBLIC_ID_RETRIES,
  PROCESS_VIDEO_JOB,
  SUPPORTED_VIDEO_MIME_TYPES,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';

/** Result of initiating an upload — returned to the client of `POST /videos`. */
export interface InitUploadResult {
  id: string;
  public_id: string;
  status: string;
  upload_id: string;
  storage_key: string;
  part_size: number;
  parts: PresignedPart[];
}

/** Result of completing an upload — returned to the client of `POST /videos/:id/complete`. */
export interface CompleteUploadResult {
  id: string;
  public_id: string;
  status: string;
}

/** Payload of the `process-video` job (per `### Events/Messages`). */
export interface ProcessVideoJobData {
  videoId: string;
  storageKey: string;
}

/** Public metadata view returned by `GET /videos/:publicId`. */
export interface PublicVideoView {
  public_id: string;
  title: string;
  status: string;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  created_at: Date;
}

/** Options for building a delivery URL. */
export interface DeliveryUrlOptions {
  /** When `'attachment'`, the presigned URL forces a download. */
  disposition?: typeof ATTACHMENT_DISPOSITION;
}

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(column)
  );
}

/** Lowercased file extension used to build the storage key (e.g. `clip.mp4` → `mp4`). */
function deriveExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === filename.length - 1) return 'bin';
  return filename.slice(dotIndex + 1).toLowerCase();
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storage: StorageService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<ProcessVideoJobData>,
  ) {}

  async initUpload(
    userId: string,
    dto: InitUploadDto,
  ): Promise<InitUploadResult> {
    const channel = await this.channelsService.findByOwner(userId);

    if (!SUPPORTED_VIDEO_MIME_TYPES.includes(dto.content_type)) {
      throw new UnsupportedVideoFormatException();
    }
    if (dto.size_bytes > this.config.uploadMaxBytes) {
      throw new FileTooLargeException();
    }

    const id = randomUUID();
    const storageKey = `videos/${id}/original.${deriveExtension(dto.filename)}`;

    const draft = await this.persistDraft(id, channel.id, dto, storageKey);

    const uploadId = await this.storage.createMultipartUpload(
      storageKey,
      dto.content_type,
    );
    const partSize = this.config.uploadPartSize;
    const partCount = Math.max(1, Math.ceil(dto.size_bytes / partSize));
    const parts = await this.storage.presignUploadParts(
      storageKey,
      uploadId,
      partCount,
    );

    draft.upload_id = uploadId;
    await this.videoRepository.save(draft);

    return {
      id: draft.id,
      public_id: draft.public_id,
      status: draft.status,
      upload_id: uploadId,
      storage_key: storageKey,
      part_size: partSize,
      parts,
    };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const channel = await this.channelsService.findByOwner(userId);
    if (video.channel_id !== channel.id) {
      throw new VideoNotOwnedException();
    }

    // Awaiting completion == still a draft with an open multipart upload.
    if (video.status !== 'draft' || !video.upload_id) {
      throw new InvalidUploadStateException();
    }

    await this.storage.completeMultipartUpload(
      video.storage_key,
      video.upload_id,
      dto.parts,
    );

    video.upload_id = null;
    video.status = 'processing';
    await this.videoRepository.save(video);

    await this.processingQueue.add(PROCESS_VIDEO_JOB, {
      videoId: video.id,
      storageKey: video.storage_key,
    });

    return {
      id: video.id,
      public_id: video.public_id,
      status: video.status,
    };
  }

  /**
   * Public read of a video's status/metadata by `public_id` (per `TD-08`).
   * `thumbnail_url` is a short-lived presigned GET URL, or `null` until the
   * thumbnail has been generated by processing.
   */
  async getPublicView(publicId: string): Promise<PublicVideoView> {
    const video = await this.videoRepository.findOneBy({ public_id: publicId });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const thumbnailUrl = video.thumbnail_key
      ? await this.storage.getPresignedGetUrl(video.thumbnail_key, {
          expiresIn: DELIVERY_URL_TTL_SECONDS,
        })
      : null;

    return {
      public_id: video.public_id,
      title: video.title,
      status: video.status,
      duration_seconds: video.duration_seconds,
      thumbnail_url: thumbnailUrl,
      created_at: video.created_at,
    };
  }

  /**
   * Issues a short-lived presigned GET URL for streaming or download (per
   * `TD-09`). Only `ready` videos are delivered; `attachment` disposition
   * forces a download.
   */
  async getDeliveryUrl(
    publicId: string,
    options: DeliveryUrlOptions = {},
  ): Promise<string> {
    const video = await this.videoRepository.findOneBy({ public_id: publicId });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== 'ready') {
      throw new VideoNotReadyException();
    }

    return this.storage.getPresignedGetUrl(video.storage_key, {
      expiresIn: DELIVERY_URL_TTL_SECONDS,
      contentDisposition:
        options.disposition === ATTACHMENT_DISPOSITION
          ? ATTACHMENT_DISPOSITION
          : undefined,
    });
  }

  /**
   * Persists the draft row, regenerating `public_id` on the (rare) unique
   * collision. The DB constraint is the source of truth for uniqueness.
   */
  private async persistDraft(
    id: string,
    channelId: string,
    dto: InitUploadDto,
    storageKey: string,
  ): Promise<Video> {
    for (let attempt = 0; attempt <= MAX_PUBLIC_ID_RETRIES; attempt++) {
      const draft = this.videoRepository.create({
        id,
        public_id: generatePublicId(),
        channel_id: channelId,
        title: dto.title ?? dto.filename,
        original_filename: dto.filename,
        status: 'draft',
        storage_key: storageKey,
      });

      try {
        return await this.videoRepository.save(draft);
      } catch (err) {
        if (
          isPgUniqueViolationOnColumn(err, PUBLIC_ID_COLUMN) &&
          attempt < MAX_PUBLIC_ID_RETRIES
        ) {
          continue;
        }
        throw err;
      }
    }

    throw new Error(
      'public_id conflict could not be resolved after max retries',
    );
  }
}
