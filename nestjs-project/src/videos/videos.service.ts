import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  UnsupportedVideoFormatException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import type { PresignedPart } from '../storage/storage.service';
import { StorageService } from '../storage/storage.service';
import type { InitUploadDto } from './dto/init-upload.dto';
import { Video } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import {
  MAX_PUBLIC_ID_RETRIES,
  SUPPORTED_VIDEO_MIME_TYPES,
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
