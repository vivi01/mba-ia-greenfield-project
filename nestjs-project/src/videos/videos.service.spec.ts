import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  UnsupportedVideoFormatException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import type { InitUploadDto } from './dto/init-upload.dto';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

describe('VideosService (unit)', () => {
  let service: VideosService;
  let videoRepository: { create: jest.Mock; save: jest.Mock };
  let channelsService: { findByOwner: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    presignUploadParts: jest.Mock;
  };

  const config = { uploadMaxBytes: 10_737_418_240, uploadPartSize: 104_857_600 };

  const validDto: InitUploadDto = {
    filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 52_428_800,
  };

  beforeEach(async () => {
    videoRepository = {
      create: jest.fn((entity: Partial<Video>) => entity),
      save: jest.fn((entity: Video) => Promise.resolve(entity)),
    };
    channelsService = { findByOwner: jest.fn() };
    storage = {
      createMultipartUpload: jest.fn(),
      presignUploadParts: jest.fn(),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storage },
        { provide: storageConfig.KEY, useValue: config },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  it('resolves the channel, creates a draft and opens a multipart upload', async () => {
    channelsService.findByOwner.mockResolvedValue({ id: 'channel-1' });
    storage.createMultipartUpload.mockResolvedValue('upload-123');
    storage.presignUploadParts.mockResolvedValue([
      { part_number: 1, url: 'http://minio/part-1' },
    ]);

    const result = await service.initUpload('user-1', validDto);

    expect(channelsService.findByOwner).toHaveBeenCalledWith('user-1');

    // draft persisted under the caller's channel, as 'draft'
    const draft = videoRepository.create.mock.calls[0][0] as Partial<Video>;
    expect(draft.channel_id).toBe('channel-1');
    expect(draft.status).toBe('draft');
    expect(draft.title).toBe('clip.mp4');
    expect(draft.public_id).toHaveLength(21);

    // multipart opened against the derived storage key
    const [storageKey, contentType] =
      storage.createMultipartUpload.mock.calls[0];
    expect(storageKey).toMatch(/^videos\/[^/]+\/original\.mp4$/);
    expect(contentType).toBe('video/mp4');

    // returned shape
    expect(result).toMatchObject({
      status: 'draft',
      upload_id: 'upload-123',
      storage_key: storageKey,
      part_size: config.uploadPartSize,
      parts: [{ part_number: 1, url: 'http://minio/part-1' }],
    });
    expect(result.public_id).toBe(draft.public_id);

    // saved once as draft, then again to persist upload_id
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
