import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';
import type { VideoStatus } from '../src/videos/entities/video.entity';

describe('videos-delivery (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;

  let counter = 0;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    // AppModule compile + Nest boot cold-compiles the TS graph via ts-jest,
    // which exceeds Jest's 5s default hook timeout on the slow Windows mount.
  }, 60_000);

  afterAll(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await app.close();
  }, 60_000);

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function seedVideo(status: VideoStatus): Promise<Video> {
    counter++;
    const user = await userRepository.save(
      userRepository.create({
        email: `deliv_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `deliv_chan_${counter}`,
        user_id: user.id,
      }),
    );
    const ready = status === 'ready';
    return videoRepository.save(
      videoRepository.create({
        public_id: `pub_deliv_${counter}`.padEnd(21, '0').slice(0, 21),
        channel_id: channel.id,
        title: `Clip ${counter}`,
        original_filename: 'clip.mp4',
        status,
        storage_key: `videos/deliv-${counter}/original.mp4`,
        thumbnail_key: ready ? `videos/deliv-${counter}/thumbnail.jpg` : null,
        duration_seconds: ready ? 12 : null,
      }),
    );
  }

  // 1.1 get-metadata-success (AC #1)
  it('returns 200 with the metadata view for a ready video (anonymous)', async () => {
    const video = await seedVideo('ready');

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}`)
      .expect(200);

    expect(res.body).toMatchObject({
      public_id: video.public_id,
      title: video.title,
      status: 'ready',
      duration_seconds: 12,
    });
    expect(typeof res.body.thumbnail_url).toBe('string');
    expect(typeof res.body.created_at).toBe('string');
  });

  // 1.2 reject-unknown-video (AC #2)
  it('returns 404 VIDEO_NOT_FOUND for an unknown public_id', async () => {
    const res = await request(app.getHttpServer())
      .get(`/videos/${randomUUID()}`)
      .expect(404);

    expect(res.body).toMatchObject({
      statusCode: 404,
      error: 'VIDEO_NOT_FOUND',
    });
    expect(typeof res.body.message).toBe('string');
  });

  // 1.3 stream-ready-redirect (AC #3)
  it('returns 302 to a presigned GET URL for a ready video stream', async () => {
    const video = await seedVideo('ready');

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/stream`)
      .redirects(0)
      .expect(302);

    expect(res.headers.location).toBeDefined();
    expect(res.headers.location).toContain(
      `videos/deliv-${counter}/original.mp4`,
    );
    expect(res.headers.location).toContain('X-Amz-Signature');
  });

  // 1.4 download-ready-redirect (AC #4)
  it('returns 302 to a presigned URL with attachment disposition for download', async () => {
    const video = await seedVideo('ready');

    const res = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/download`)
      .redirects(0)
      .expect(302);

    expect(res.headers.location).toBeDefined();
    expect(res.headers.location).toContain(
      'response-content-disposition=attachment',
    );
  });

  // 1.5 reject-not-ready (AC #5)
  it('returns 409 VIDEO_NOT_READY for stream and download of a non-ready video', async () => {
    const video = await seedVideo('processing');

    const streamRes = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/stream`)
      .redirects(0)
      .expect(409);
    expect(streamRes.body).toMatchObject({
      statusCode: 409,
      error: 'VIDEO_NOT_READY',
    });
    expect(typeof streamRes.body.message).toBe('string');

    const downloadRes = await request(app.getHttpServer())
      .get(`/videos/${video.public_id}/download`)
      .redirects(0)
      .expect(409);
    expect(downloadRes.body).toMatchObject({
      statusCode: 409,
      error: 'VIDEO_NOT_READY',
    });
  });
});
