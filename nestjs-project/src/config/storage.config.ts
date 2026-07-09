import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  bucket: process.env.STORAGE_BUCKET!,
  accessKeyId: process.env.STORAGE_ACCESS_KEY!,
  secretAccessKey: process.env.STORAGE_SECRET_KEY!,
  forcePathStyle: (process.env.STORAGE_FORCE_PATH_STYLE ?? 'true') === 'true',
  uploadMaxBytes: parseInt(process.env.UPLOAD_MAX_BYTES || '10737418240', 10),
  uploadPartSize: parseInt(process.env.UPLOAD_PART_SIZE || '104857600', 10),
}));
