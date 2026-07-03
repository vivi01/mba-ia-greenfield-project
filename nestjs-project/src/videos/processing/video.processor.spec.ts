import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Job } from 'bullmq';
import type { Repository } from 'typeorm';
import type { StorageService } from '../../storage/storage.service';
import type { Video } from '../entities/video.entity';
import type { ProcessVideoJobData } from '../videos.service';
import { extractThumbnail, probeMetadata } from './ffmpeg.util';
import { VideoProcessingWorker } from './video.processor';

jest.mock('node:fs/promises', () => ({
  mkdtemp: jest.fn().mockResolvedValue('/tmp/video-test'),
  readFile: jest.fn().mockResolvedValue(Buffer.from('jpeg-bytes')),
  rm: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./ffmpeg.util', () => ({
  probeMetadata: jest.fn(),
  extractThumbnail: jest.fn(),
}));

const probeMetadataMock = probeMetadata as jest.MockedFunction<
  typeof probeMetadata
>;
const extractThumbnailMock = extractThumbnail as jest.MockedFunction<
  typeof extractThumbnail
>;
const rmMock = rm as jest.MockedFunction<typeof rm>;
const readFileMock = readFile as jest.MockedFunction<typeof readFile>;

function jobFor(
  data: ProcessVideoJobData,
  overrides: Partial<Job<ProcessVideoJobData>> = {},
): Job<ProcessVideoJobData> {
  return { data, ...overrides } as unknown as Job<ProcessVideoJobData>;
}

describe('VideoProcessingWorker', () => {
  let repository: jest.Mocked<
    Pick<Repository<Video>, 'findOneByOrFail' | 'save' | 'update'>
  >;
  let storage: jest.Mocked<
    Pick<StorageService, 'downloadToFile' | 'putObject'>
  >;
  let worker: VideoProcessingWorker;

  beforeEach(() => {
    jest.clearAllMocks();
    readFileMock.mockResolvedValue(Buffer.from('jpeg-bytes'));
    repository = {
      findOneByOrFail: jest.fn().mockResolvedValue({ id: 'video-1' } as Video),
      save: jest.fn().mockImplementation((v: Video) => Promise.resolve(v)),
      update: jest.fn().mockResolvedValue(undefined),
    };
    storage = {
      downloadToFile: jest.fn().mockResolvedValue(123_456),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    worker = new VideoProcessingWorker(
      repository as unknown as Repository<Video>,
      storage as unknown as StorageService,
    );
  });

  describe('process', () => {
    const data: ProcessVideoJobData = {
      videoId: 'video-1',
      storageKey: 'videos/video-1/original.mp4',
    };

    it('downloads, probes, thumbnails and marks the video ready', async () => {
      const metadata = { format: { duration: '42' }, streams: [] };
      probeMetadataMock.mockResolvedValue({ durationSeconds: 42, metadata });

      await worker.process(jobFor(data));

      expect(storage.downloadToFile).toHaveBeenCalledWith(
        data.storageKey,
        expect.any(String),
      );
      expect(extractThumbnailMock).toHaveBeenCalledTimes(1);
      expect(storage.putObject).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
        expect.any(Buffer),
        'image/jpeg',
      );
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'video-1',
          status: 'ready',
          duration_seconds: 42,
          metadata,
          thumbnail_key: 'videos/video-1/thumbnail.jpg',
          size_bytes: 123_456,
        }),
      );
      expect(rmMock).toHaveBeenCalled();
    });

    it('propagates an ffmpeg failure for retry and does not mark ready', async () => {
      probeMetadataMock.mockRejectedValue(
        new Error('ffprobe exited with code 1'),
      );

      await expect(worker.process(jobFor(data))).rejects.toThrow(
        'ffprobe exited with code 1',
      );
      expect(repository.save).not.toHaveBeenCalled();
      // temp dir is still cleaned up on failure
      expect(rmMock).toHaveBeenCalled();
    });
  });

  describe('onFailed', () => {
    const data: ProcessVideoJobData = {
      videoId: 'video-1',
      storageKey: 'videos/video-1/original.mp4',
    };

    it('marks the video as error once retries are exhausted', async () => {
      const job = jobFor(data, {
        attemptsMade: 3,
        opts: { attempts: 3 },
      });

      await worker.onFailed(job, new Error('processing blew up'));

      expect(repository.update).toHaveBeenCalledWith('video-1', {
        status: 'error',
        error_reason: 'processing blew up',
      });
    });

    it('does not touch the video while retries remain', async () => {
      const job = jobFor(data, {
        attemptsMade: 1,
        opts: { attempts: 3 },
      });

      await worker.onFailed(job, new Error('transient'));

      expect(repository.update).not.toHaveBeenCalled();
    });
  });
});
