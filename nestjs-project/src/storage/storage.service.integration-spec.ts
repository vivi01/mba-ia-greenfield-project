import { randomUUID } from 'crypto';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

/**
 * Exercises the real MinIO service configured for the test container
 * (STORAGE_* env vars via dotenv/config). Uploads are single small parts —
 * S3/MinIO waive the 5MB minimum for the last (here, only) part.
 */
describe('StorageService (integration, MinIO)', () => {
  const config = storageConfig();
  const service = new StorageService(config);
  const rawClient = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  const createdKeys: string[] = [];

  afterAll(async () => {
    await Promise.all(
      createdKeys.map((key) =>
        rawClient
          .send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
          .catch(() => undefined),
      ),
    );
    rawClient.destroy();
  });

  function newKey(): string {
    const key = `test/${randomUUID()}/original.bin`;
    createdKeys.push(key);
    return key;
  }

  async function uploadSingleObject(key: string, body: Buffer): Promise<void> {
    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    const [part] = await service.presignUploadParts(key, uploadId, 1);

    const putResponse = await fetch(part.url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    expect(putResponse.ok).toBe(true);
    const etag = putResponse.headers.get('etag');
    expect(etag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { part_number: part.part_number, etag: etag as string },
    ]);
  }

  it('create → presign → PUT → complete persists a readable object', async () => {
    const key = newKey();
    const body = Buffer.from('hello multipart world '.repeat(64));

    await uploadSingleObject(key, body);

    const getUrl = await service.getPresignedGetUrl(key, { expiresIn: 300 });
    const getResponse = await fetch(getUrl);

    expect(getResponse.ok).toBe(true);
    const downloaded = Buffer.from(await getResponse.arrayBuffer());
    expect(downloaded.equals(body)).toBe(true);
  }, 30000);

  it('getPresignedGetUrl with attachment forces a download disposition', async () => {
    const key = newKey();
    await uploadSingleObject(key, Buffer.from('downloadable payload'));

    const url = await service.getPresignedGetUrl(key, {
      expiresIn: 300,
      contentDisposition: 'attachment',
    });
    const response = await fetch(url);

    expect(response.ok).toBe(true);
    expect(response.headers.get('content-disposition')).toContain('attachment');
  }, 30000);

  it('abortMultipartUpload discards a pending upload, leaving no object', async () => {
    const key = newKey();
    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    const [part] = await service.presignUploadParts(key, uploadId, 1);
    await fetch(part.url, {
      method: 'PUT',
      body: new TextEncoder().encode('partial data'),
    });

    await service.abortMultipartUpload(key, uploadId);

    const getUrl = await service.getPresignedGetUrl(key, { expiresIn: 300 });
    const response = await fetch(getUrl);
    expect(response.status).toBe(404);
  }, 30000);
});
