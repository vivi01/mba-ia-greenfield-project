import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

/** A presigned PUT URL the client uploads a single part to. */
export interface PresignedPart {
  part_number: number;
  url: string;
}

/** A part the client has finished uploading, as reported back by storage. */
export interface CompletedPart {
  part_number: number;
  etag: string;
}

export interface PresignedGetOptions {
  expiresIn: number;
  /** e.g. `'attachment'` to force a download; omitted for inline streaming. */
  contentDisposition?: string;
}

const PRESIGNED_PART_TTL_SECONDS = 3600;

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const output = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );

    if (!output.UploadId) {
      throw new Error(
        `S3 did not return an UploadId for multipart upload of "${key}"`,
      );
    }

    return output.UploadId;
  }

  async presignUploadParts(
    key: string,
    uploadId: string,
    partCount: number,
    expiresIn: number = PRESIGNED_PART_TTL_SECONDS,
  ): Promise<PresignedPart[]> {
    const parts: PresignedPart[] = [];

    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const url = await getSignedUrl(
        this.client,
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn },
      );
      parts.push({ part_number: partNumber, url });
    }

    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    const orderedParts = [...parts]
      .sort((a, b) => a.part_number - b.part_number)
      .map((part) => ({ ETag: part.etag, PartNumber: part.part_number }));

    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: orderedParts },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async getPresignedGetUrl(
    key: string,
    options: PresignedGetOptions,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options.contentDisposition,
      }),
      { expiresIn: options.expiresIn },
    );
  }
}
