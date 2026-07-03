import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video } from '../src/videos/entities/video.entity';

describe('videos-upload-init (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;

  // multipart uploads opened against MinIO during the run, aborted in afterAll
  const pendingUploads: { key: string; uploadId: string }[] = [];

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
    videoRepository = dataSource.getRepository(Video);
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    // Compiling AppModule + booting the Nest app cold-compiles the TS graph via
    // ts-jest, which exceeds Jest's 5s default hook timeout on the slow Windows
    // bind mount. Generous timeout so bootstrap isn't cut off mid-setup.
  }, 60_000);

  afterAll(async () => {
    for (const upload of pendingUploads) {
      await storage
        .abortMultipartUpload(upload.key, upload.uploadId)
        .catch(() => undefined);
    }
    await dataSource.query('DELETE FROM "videos"');
    await app.close();
  }, 60_000);

  beforeEach(async () => {
    // videos references channels — clear it before cleanAllTables (FK order)
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailService = (authService as any).mailService;
    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        confirmationToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token;
  }

  async function countVideos(): Promise<number> {
    return videoRepository.count();
  }

  // 1.1 init-upload-success (AC #1)
  it('returns 201 and creates a draft under the caller channel', async () => {
    const accessToken = await registerConfirmAndLogin('uploader@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 52_428_800,
      })
      .expect(201);
    pendingUploads.push({
      key: res.body.storage_key,
      uploadId: res.body.upload_id,
    });

    expect(res.body).toMatchObject({
      status: 'draft',
    });
    expect(res.body.id).toBeDefined();
    expect(res.body.public_id).toBeDefined();
    expect(res.body.upload_id).toBeDefined();
    expect(res.body.storage_key).toBeDefined();
    expect(typeof res.body.part_size).toBe('number');
    expect(Array.isArray(res.body.parts)).toBe(true);
    expect(res.body.parts.length).toBeGreaterThan(0);
    expect(res.body.parts[0]).toMatchObject({
      part_number: expect.any(Number),
      url: expect.any(String),
    });

    const user = await userRepository.findOneByOrFail({
      email: 'uploader@example.com',
    });
    const channel = await channelRepository.findOneByOrFail({
      user_id: user.id,
    });
    const row = await videoRepository.findOneByOrFail({ id: res.body.id });
    expect(row.status).toBe('draft');
    expect(row.channel_id).toBe(channel.id);
    expect(row.upload_id).toBeTruthy();
  });

  // 1.2 reject-oversize-file (AC #2)
  it('returns 413 FILE_TOO_LARGE for size_bytes above 10GB', async () => {
    const accessToken = await registerConfirmAndLogin('oversize@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        filename: 'huge.mp4',
        content_type: 'video/mp4',
        size_bytes: 10_737_418_241,
      })
      .expect(413);

    expect(res.body).toMatchObject({
      statusCode: 413,
      error: 'FILE_TOO_LARGE',
    });
    expect(typeof res.body.message).toBe('string');
    expect(await countVideos()).toBe(0);
  });

  // 1.3 reject-unsupported-format (AC #3)
  it('returns 415 UNSUPPORTED_VIDEO_FORMAT for a non-video content_type', async () => {
    const accessToken = await registerConfirmAndLogin('badformat@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        filename: 'doc.pdf',
        content_type: 'application/pdf',
        size_bytes: 1024,
      })
      .expect(415);

    expect(res.body).toMatchObject({
      statusCode: 415,
      error: 'UNSUPPORTED_VIDEO_FORMAT',
    });
    expect(typeof res.body.message).toBe('string');
    expect(await countVideos()).toBe(0);
  });

  // 1.4 reject-unauthenticated (AC #4)
  it('returns 401 without an Authorization header', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send({
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 52_428_800,
      })
      .expect(401);

    expect(await countVideos()).toBe(0);
  });

  // 1.5 reject-invalid-body (AC #5)
  it('returns 400 VALIDATION_ERROR for an incomplete body', async () => {
    const accessToken = await registerConfirmAndLogin('invalid@example.com');

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ content_type: 'video/mp4' })
      .expect(400);

    expect(res.body).toMatchObject({
      statusCode: 400,
      error: 'VALIDATION_ERROR',
    });
    expect(Array.isArray(res.body.message)).toBe(true);
    expect(await countVideos()).toBe(0);
  });
});
