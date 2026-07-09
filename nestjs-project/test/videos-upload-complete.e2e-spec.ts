import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';

interface InitResponse {
  id: string;
  storage_key: string;
  upload_id: string;
  parts: { part_number: number; url: string }[];
}

describe('videos-upload-complete (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let throttlerStorage: ThrottlerStorageService;

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
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    // AppModule compile + Nest boot cold-compiles the TS graph via ts-jest,
    // which exceeds Jest's 5s default hook timeout on the slow Windows mount.
  }, 60_000);

  afterAll(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await queue.obliterate({ force: true }).catch(() => undefined);
    await app.close();
  }, 60_000);

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true }).catch(() => undefined);
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

  async function initDraft(accessToken: string): Promise<InitResponse> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
      })
      .expect(201);
    return res.body as InitResponse;
  }

  async function jobsForVideo(videoId: string) {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    return jobs.filter(
      (job) => (job.data as { videoId: string }).videoId === videoId,
    );
  }

  // 1.1 complete-upload-success (AC #1)
  it('returns 202, sets processing and enqueues one process-video job', async () => {
    const accessToken = await registerConfirmAndLogin('completer@example.com');
    const init = await initDraft(accessToken);

    // upload the single (last) small part and capture its ETag
    const put = await fetch(init.parts[0].url, {
      method: 'PUT',
      body: new TextEncoder().encode('hello streamtube'),
    });
    expect(put.status).toBe(200);
    const etag = put.headers.get('etag');
    expect(etag).toBeTruthy();

    const res = await request(app.getHttpServer())
      .post(`/videos/${init.id}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ part_number: 1, etag: etag! }] })
      .expect(202);

    expect(res.body).toMatchObject({ id: init.id, status: 'processing' });
    expect(res.body.public_id).toBeDefined();

    const row = await videoRepository.findOneByOrFail({ id: init.id });
    expect(row.status).toBe('processing');
    expect(row.upload_id).toBeNull();

    const jobs = await jobsForVideo(init.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toMatchObject({
      videoId: init.id,
      storageKey: init.storage_key,
    });
  });

  // 1.2 reject-unknown-video (AC #2)
  it('returns 404 VIDEO_NOT_FOUND for an unknown id', async () => {
    const accessToken = await registerConfirmAndLogin('unknown@example.com');
    const missingId = randomUUID();

    const res = await request(app.getHttpServer())
      .post(`/videos/${missingId}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ part_number: 1, etag: '"abc"' }] })
      .expect(404);

    expect(res.body).toMatchObject({
      statusCode: 404,
      error: 'VIDEO_NOT_FOUND',
    });
    expect(typeof res.body.message).toBe('string');
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(0);
  });

  // 1.3 reject-non-owner (AC #3)
  it('returns 403 VIDEO_NOT_OWNED when another user completes the draft', async () => {
    const ownerToken = await registerConfirmAndLogin('owner3@example.com');
    const otherToken = await registerConfirmAndLogin('other3@example.com');
    const init = await initDraft(ownerToken);

    const res = await request(app.getHttpServer())
      .post(`/videos/${init.id}/complete`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ parts: [{ part_number: 1, etag: '"abc"' }] })
      .expect(403);

    expect(res.body).toMatchObject({
      statusCode: 403,
      error: 'VIDEO_NOT_OWNED',
    });

    const row = await videoRepository.findOneByOrFail({ id: init.id });
    expect(row.status).toBe('draft');
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(0);
  });

  // 1.4 reject-invalid-state (AC #4)
  it('returns 409 INVALID_UPLOAD_STATE when not awaiting completion', async () => {
    const accessToken = await registerConfirmAndLogin('state4@example.com');
    const init = await initDraft(accessToken);
    await videoRepository.update({ id: init.id }, { status: 'processing' });

    const res = await request(app.getHttpServer())
      .post(`/videos/${init.id}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ part_number: 1, etag: '"abc"' }] })
      .expect(409);

    expect(res.body).toMatchObject({
      statusCode: 409,
      error: 'INVALID_UPLOAD_STATE',
    });
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(0);
  });

  // 1.5 reject-invalid-parts (AC #5)
  it('returns 400 VALIDATION_ERROR for an empty parts array', async () => {
    const accessToken = await registerConfirmAndLogin('parts5@example.com');
    const init = await initDraft(accessToken);

    const res = await request(app.getHttpServer())
      .post(`/videos/${init.id}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [] })
      .expect(400);

    expect(res.body).toMatchObject({
      statusCode: 400,
      error: 'VALIDATION_ERROR',
    });
    expect(Array.isArray(res.body.message)).toBe(true);

    const row = await videoRepository.findOneByOrFail({ id: init.id });
    expect(row.status).toBe('draft');
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(0);
  });
});
