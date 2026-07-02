import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;

  // multipart uploads opened against MinIO during the run, aborted in afterAll
  const pendingUploads: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);

    const config = storageConfig();
    storage = new StorageService(config);
    const channelsService = new ChannelsService(dataSource);
    service = new VideosService(
      videoRepository,
      channelsService,
      storage,
      config,
    );
  });

  afterAll(async () => {
    for (const upload of pendingUploads) {
      await storage
        .abortMultipartUpload(upload.key, upload.uploadId)
        .catch(() => undefined);
    }
    // videos is not managed by cleanAllTables (see FK ordering note there)
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
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

    const persisted = await videoRepository.findOneByOrFail({ id: result.id });
    expect(persisted.status).toBe('draft');
    expect(persisted.channel_id).toBe(channel.id);
    expect(persisted.storage_key).toBe(result.storage_key);
    expect(persisted.storage_key).toMatch(/^videos\/[^/]+\/original\.mp4$/);
    expect(persisted.upload_id).toBe(result.upload_id);
    expect(persisted.upload_id).toBeTruthy();
    expect(persisted.public_id).toHaveLength(21);
  });
});
