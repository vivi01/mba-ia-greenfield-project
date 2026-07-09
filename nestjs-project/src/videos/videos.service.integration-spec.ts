import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let queue: Queue;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;

  // multipart uploads opened but not completed — aborted in afterAll
  const pendingUploads: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);

    const config = storageConfig();
    storage = new StorageService(config);
    const { host, port } = queueConfig();
    queue = new Queue(VIDEO_PROCESSING_QUEUE, { connection: { host, port } });
    const channelsService = new ChannelsService(dataSource);
    service = new VideosService(
      videoRepository,
      channelsService,
      storage,
      config,
      queue,
    );
    // DataSource init + Redis connection under cold ts-jest compile exceeds
    // Jest's 5s default hook timeout on the slow Windows bind mount.
  }, 60_000);

  afterAll(async () => {
    for (const upload of pendingUploads) {
      await storage
        .abortMultipartUpload(upload.key, upload.uploadId)
        .catch(() => undefined);
    }
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.destroy();
  }, 60_000);

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true }).catch(() => undefined);
  });

  let counter = 0;
  async function seedChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `vid_svc_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `vid_svc_chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  /** Seeds a `ready` video with its original (and optional thumbnail) in MinIO. */
  async function seedReadyVideo(
    channel: Channel,
    originalBody: Buffer,
    withThumbnail = true,
  ): Promise<Video> {
    const saved = await videoRepository.save(
      videoRepository.create({
        public_id: `deliv_${++counter}`.padEnd(21, '0').slice(0, 21),
        channel_id: channel.id,
        title: 'Delivered Clip',
        original_filename: 'clip.mp4',
        status: 'ready',
        storage_key: `videos/deliv-${counter}/original.mp4`,
        thumbnail_key: withThumbnail
          ? `videos/deliv-${counter}/thumbnail.jpg`
          : null,
        duration_seconds: 12,
      }),
    );
    await storage.putObject(saved.storage_key, originalBody, 'video/mp4');
    if (saved.thumbnail_key) {
      await storage.putObject(
        saved.thumbnail_key,
        Buffer.from('fake-thumbnail'),
        'image/jpeg',
      );
    }
    return saved;
  }

  describe('initUpload', () => {
    it('persists a draft with status draft, storage_key and upload_id', async () => {
      const channel = await seedChannel();

      const result = await service.initUpload(channel.user_id, {
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 52_428_800,
      });
      pendingUploads.push({
        key: result.storage_key,
        uploadId: result.upload_id,
      });

      const persisted = await videoRepository.findOneByOrFail({
        id: result.id,
      });
      expect(persisted.status).toBe('draft');
      expect(persisted.channel_id).toBe(channel.id);
      expect(persisted.storage_key).toBe(result.storage_key);
      expect(persisted.storage_key).toMatch(/^videos\/[^/]+\/original\.mp4$/);
      expect(persisted.upload_id).toBe(result.upload_id);
      expect(persisted.upload_id).toBeTruthy();
      expect(persisted.public_id).toHaveLength(21);
    });
  });

  describe('completeUpload', () => {
    it('transitions the video to processing and publishes a process-video job', async () => {
      const channel = await seedChannel();

      // open the multipart upload and upload a single (last) small part
      const init = await service.initUpload(channel.user_id, {
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
      });
      const body = new TextEncoder().encode('hello streamtube');
      const putResponse = await fetch(init.parts[0].url, {
        method: 'PUT',
        body,
      });
      expect(putResponse.status).toBe(200);
      const etag = putResponse.headers.get('etag');
      expect(etag).toBeTruthy();

      const result = await service.completeUpload(channel.user_id, init.id, {
        parts: [{ part_number: 1, etag: etag! }],
      });

      expect(result.status).toBe('processing');

      const persisted = await videoRepository.findOneByOrFail({ id: init.id });
      expect(persisted.status).toBe('processing');
      expect(persisted.upload_id).toBeNull();

      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      const jobForVideo = jobs.find(
        (job) => (job.data as { videoId: string }).videoId === init.id,
      );
      expect(jobForVideo).toBeDefined();
      expect(jobForVideo!.data).toMatchObject({
        videoId: init.id,
        storageKey: init.storage_key,
      });
    });
  });

  describe('getPublicView', () => {
    it('returns metadata by public_id with a working presigned thumbnail URL', async () => {
      const channel = await seedChannel();
      const video = await seedReadyVideo(
        channel,
        Buffer.from('original-bytes'),
      );

      const view = await service.getPublicView(video.public_id);

      expect(view).toMatchObject({
        public_id: video.public_id,
        title: 'Delivered Clip',
        status: 'ready',
        duration_seconds: 12,
      });
      expect(typeof view.thumbnail_url).toBe('string');

      const thumbResponse = await fetch(view.thumbnail_url!);
      expect(thumbResponse.status).toBe(200);
    });
  });

  describe('getDeliveryUrl', () => {
    it('produces a presigned URL that downloads the original object', async () => {
      const channel = await seedChannel();
      const body = 'streamtube-delivery-body';
      const video = await seedReadyVideo(channel, Buffer.from(body), false);

      const url = await service.getDeliveryUrl(video.public_id);
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
    });

    it('carries an attachment Content-Disposition when requested', async () => {
      const channel = await seedChannel();
      const video = await seedReadyVideo(channel, Buffer.from('x'), false);

      const url = await service.getDeliveryUrl(video.public_id, {
        disposition: 'attachment',
      });

      expect(url).toContain('response-content-disposition=attachment');
    });
  });
});
