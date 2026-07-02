import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import { User } from '../../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
  });

  afterAll(async () => {
    // videos is not managed by the shared cleanAllTables helper (see the FK
    // ordering note there); clear it here so leftover rows don't block other
    // suites' `DELETE FROM channels`.
    await dataSource.query('DELETE FROM "videos"');
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_ent_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `video_ent_chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}): Video {
    return videoRepository.create({
      public_id: `pub_${++counter}`,
      channel_id: channelId,
      title: 'My Video',
      original_filename: 'clip.mp4',
      storage_key: `videos/${counter}/original.mp4`,
      ...overrides,
    });
  }

  it("defaults status to 'draft' when not provided", async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel.id));
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe('draft');
  });

  it('accepts null for all optional fields', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel.id));
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.thumbnail_key).toBeNull();
    expect(found.upload_id).toBeNull();
    expect(found.size_bytes).toBeNull();
    expect(found.duration_seconds).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.error_reason).toBeNull();
  });

  it('enforces a unique constraint on public_id', async () => {
    const channel = await createChannel();
    const publicId = `dup_${Date.now()}`;
    await videoRepository.save(buildVideo(channel.id, { public_id: publicId }));

    await expect(
      videoRepository.save(buildVideo(channel.id, { public_id: publicId })),
    ).rejects.toThrow(QueryFailedError);
  });

  it('enforces the foreign key to channels', async () => {
    const orphanChannelId = '00000000-0000-0000-0000-000000000000';

    await expect(
      videoRepository.save(buildVideo(orphanChannelId)),
    ).rejects.toThrow(QueryFailedError);
  });

  it('rejects a status value outside the enum', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos"
           ("public_id", "channel_id", "title", "original_filename", "status", "storage_key")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          `bad_${Date.now()}`,
          channel.id,
          'Bad status',
          'bad.mp4',
          'archived',
          'videos/x/original.mp4',
        ],
      ),
    ).rejects.toThrow(QueryFailedError);
  });
});
