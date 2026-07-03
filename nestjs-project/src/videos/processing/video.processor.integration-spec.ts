import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import storageConfig from '../../config/storage.config';
import { StorageService } from '../../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import type { ProcessVideoJobData } from '../videos.service';
import { VideoProcessingWorker } from './video.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

/** Generates a 1s test clip with ffmpeg's synthetic `testsrc` source. */
function generateTestVideo(outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=128x96:rate=15',
      '-pix_fmt',
      'yuv420p',
      outPath,
    ]);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      code === 0
        ? resolve()
        : reject(new Error(`ffmpeg fixture generation failed: ${stderr}`));
    });
  });
}

describe('VideoProcessingWorker (integration)', () => {
  const config = storageConfig();
  let dataSource: DataSource;
  let storage: StorageService;
  let worker: VideoProcessingWorker;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let rawClient: S3Client;

  const createdKeys: string[] = [];

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);

    storage = new StorageService(config);
    worker = new VideoProcessingWorker(videoRepository, storage);
    rawClient = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    // DataSource init under cold ts-jest compile exceeds Jest's 5s hook default.
  }, 60_000);

  afterAll(async () => {
    await Promise.all(
      createdKeys.map((key) =>
        rawClient
          .send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
          .catch(() => undefined),
      ),
    );
    rawClient.destroy();
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.destroy();
  }, 60_000);

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  async function seedProcessingVideo(): Promise<Video> {
    const user = await userRepository.save(
      userRepository.create({
        email: `worker_${randomUUID()}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: 'Worker Channel',
        nickname: `worker_${randomUUID().slice(0, 8)}`,
        user_id: user.id,
      }),
    );
    const id = randomUUID();
    const storageKey = `videos/${id}/original.mp4`;
    createdKeys.push(storageKey);
    return videoRepository.save(
      videoRepository.create({
        id,
        public_id: randomUUID().slice(0, 21),
        channel_id: channel.id,
        title: 'clip',
        original_filename: 'clip.mp4',
        status: 'processing',
        storage_key: storageKey,
      }),
    );
  }

  it('processes a video to ready with duration, metadata and thumbnail', async () => {
    const video = await seedProcessingVideo();

    // upload a real (tiny) original so the worker can download + probe it
    const workDir = await mkdtemp(join(tmpdir(), 'video-fixture-'));
    const fixturePath = join(workDir, 'original.mp4');
    await generateTestVideo(fixturePath);
    const originalBytes = await readFile(fixturePath);
    await storage.putObject(video.storage_key, originalBytes, 'video/mp4');
    await rm(workDir, { recursive: true, force: true });

    const job = {
      data: { videoId: video.id, storageKey: video.storage_key },
    } as unknown as Job<ProcessVideoJobData>;
    await worker.process(job);

    const persisted = await videoRepository.findOneByOrFail({ id: video.id });
    expect(persisted.status).toBe('ready');
    expect(persisted.duration_seconds).toBeGreaterThanOrEqual(1);
    expect(persisted.size_bytes).toBeGreaterThan(0);
    expect(persisted.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    expect(persisted.metadata).toBeTruthy();
    expect(persisted.metadata?.streams).toBeDefined();

    // the thumbnail object was really uploaded
    createdKeys.push(persisted.thumbnail_key!);
    const checkDir = await mkdtemp(join(tmpdir(), 'video-thumb-'));
    const thumbPath = join(checkDir, 'thumb.jpg');
    const thumbBytes = await storage.downloadToFile(
      persisted.thumbnail_key!,
      thumbPath,
    );
    expect(thumbBytes).toBeGreaterThan(0);
    await rm(checkDir, { recursive: true, force: true });
  }, 60_000);
});
