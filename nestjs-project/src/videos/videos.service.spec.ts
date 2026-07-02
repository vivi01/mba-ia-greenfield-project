import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  InvalidUploadStateException,
  UnsupportedVideoFormatException,
  VideoNotFoundException,
  VideoNotOwnedException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import type { CompleteUploadDto } from './dto/complete-upload.dto';
import type { InitUploadDto } from './dto/init-upload.dto';
import { Video } from './entities/video.entity';
import { PROCESS_VIDEO_JOB, VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosService } from './videos.service';

describe('VideosService (unit)', () => {
  let service: VideosService;
  let videoRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOneBy: jest.Mock;
  };
  let channelsService: { findByOwner: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    presignUploadParts: jest.Mock;
    completeMultipartUpload: jest.Mock;
  };
  let queue: { add: jest.Mock };

  const config = { uploadMaxBytes: 10_737_418_240, uploadPartSize: 104_857_600 };

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn((entity: Partial<Video>) => entity),
      save: jest.fn((entity: Video) => Promise.resolve(entity)),
      findOneBy: jest.fn(),
    };
    channelsService = { findByOwner: jest.fn() };
    storage = {
      createMultipartUpload: jest.fn(),
      presignUploadParts: jest.fn(),
      completeMultipartUpload: jest.fn(),
    };
    queue = { add: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storage },
        { provide: storageConfig.KEY, useValue: config },
        { provide: getQueueToken(VIDEO_PROCESSING_QUEUE), useValue: queue },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  describe('initUpload', () => {
    const validDto: InitUploadDto = {
      filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 52_428_800,
    };

    it('resolves the channel, creates a draft and opens a multipart upload', async () => {
      channelsService.findByOwner.mockResolvedValue({ id: 'channel-1' });
      storage.createMultipartUpload.mockResolvedValue('upload-123');
      storage.presignUploadParts.mockResolvedValue([
        { part_number: 1, url: 'http://minio/part-1' },
      ]);

      const result = await service.initUpload('user-1', validDto);

      expect(channelsService.findByOwner).toHaveBeenCalledWith('user-1');

      const draft = videoRepository.create.mock.calls[0][0] as Partial<Video>;
      expect(draft.channel_id).toBe('channel-1');
      expect(draft.status).toBe('draft');
      expect(draft.title).toBe('clip.mp4');
      expect(draft.public_id).toHaveLength(21);

      const [storageKey, contentType] =
        storage.createMultipartUpload.mock.calls[0];
      expect(storageKey).toMatch(/^videos\/[^/]+\/original\.mp4$/);
      expect(contentType).toBe('video/mp4');

      expect(result).toMatchObject({
        status: 'draft',
        upload_id: 'upload-123',
        storage_key: storageKey,
        part_size: config.uploadPartSize,
        parts: [{ part_number: 1, url: 'http://minio/part-1' }],
      });
      expect(result.public_id).toBe(draft.public_id);

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      expect(videoRepository.save.mock.calls[1][0].upload_id).toBe('upload-123');
    });

    it('defaults the title to filename when omitted and uses title when provided', async () => {
      channelsService.findByOwner.mockResolvedValue({ id: 'channel-1' });
      storage.createMultipartUpload.mockResolvedValue('upload-123');
      storage.presignUploadParts.mockResolvedValue([]);

      await service.initUpload('user-1', { ...validDto, title: 'My Clip' });

      const draft = videoRepository.create.mock.calls[0][0] as Partial<Video>;
      expect(draft.title).toBe('My Clip');
    });

    it('throws UnsupportedVideoFormatException for a non-video content_type', async () => {
      channelsService.findByOwner.mockResolvedValue({ id: 'channel-1' });

      await expect(
        service.initUpload('user-1', {
          ...validDto,
          content_type: 'application/pdf',
        }),
      ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);

      expect(videoRepository.save).not.toHaveBeenCalled();
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('throws FileTooLargeException when size_bytes exceeds the max', async () => {
      channelsService.findByOwner.mockResolvedValue({ id: 'channel-1' });

      await expect(
        service.initUpload('user-1', {
          ...validDto,
          size_bytes: config.uploadMaxBytes + 1,
        }),
      ).rejects.toBeInstanceOf(FileTooLargeException);

      expect(videoRepository.save).not.toHaveBeenCalled();
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('derives the part count from size_bytes and part_size', async () => {
      channelsService.findByOwner.mockResolvedValue({ id: 'channel-1' });
      storage.createMultipartUpload.mockResolvedValue('upload-123');
      storage.presignUploadParts.mockResolvedValue([]);

      await service.initUpload('user-1', {
        ...validDto,
        size_bytes: config.uploadPartSize * 2 + 1,
      });

      const partCount = storage.presignUploadParts.mock.calls[0][2];
      expect(partCount).toBe(3);
    });
  });

  describe('completeUpload', () => {
    const dto: CompleteUploadDto = {
      parts: [{ part_number: 1, etag: '"abc123"' }],
    };

    function draftVideo(overrides: Partial<Video> = {}): Video {
      return {
        id: 'video-1',
        public_id: 'pub_video_1',
        channel_id: 'channel-1',
        status: 'draft',
        storage_key: 'videos/video-1/original.mp4',
        upload_id: 'upload-123',
        ...overrides,
      } as Video;
    }

    it('completes the upload, sets processing and enqueues one job', async () => {
      videoRepository.findOneBy.mockResolvedValue(draftVideo());
      channelsService.findByOwner.mockResolvedValue({ id: 'channel-1' });

      const result = await service.completeUpload('user-1', 'video-1', dto);

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'upload-123',
        dto.parts,
      );

      const saved = videoRepository.save.mock.calls[0][0] as Video;
      expect(saved.status).toBe('processing');
      expect(saved.upload_id).toBeNull();

      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(PROCESS_VIDEO_JOB, {
        videoId: 'video-1',
        storageKey: 'videos/video-1/original.mp4',
      });

      expect(result).toEqual({
        id: 'video-1',
        public_id: 'pub_video_1',
        status: 'processing',
      });
    });

    it('throws VideoNotFoundException when the video does not exist', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(
        service.completeUpload('user-1', 'missing', dto),
      ).rejects.toBeInstanceOf(VideoNotFoundException);

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('throws VideoNotOwnedException when the caller owns a different channel', async () => {
      videoRepository.findOneBy.mockResolvedValue(draftVideo());
      channelsService.findByOwner.mockResolvedValue({ id: 'other-channel' });

      await expect(
        service.completeUpload('user-2', 'video-1', dto),
      ).rejects.toBeInstanceOf(VideoNotOwnedException);

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('throws InvalidUploadStateException when the video is not awaiting completion', async () => {
      videoRepository.findOneBy.mockResolvedValue(
        draftVideo({ status: 'processing' }),
      );
      channelsService.findByOwner.mockResolvedValue({ id: 'channel-1' });

      await expect(
        service.completeUpload('user-1', 'video-1', dto),
      ).rejects.toBeInstanceOf(InvalidUploadStateException);

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
