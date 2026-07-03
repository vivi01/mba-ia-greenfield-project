import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitUploadDto } from './dto/init-upload.dto';
import { ATTACHMENT_DISPOSITION } from './videos.constants';
import {
  VideosService,
  type CompleteUploadResult,
  type InitUploadResult,
  type PublicVideoView,
} from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      "Pre-registers a draft video under the caller's channel, opens a multipart upload in object storage, and returns presigned part URLs the client uploads directly to storage.",
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated; draft created',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        status: { type: 'string', example: 'draft' },
        upload_id: { type: 'string' },
        storage_key: { type: 'string' },
        part_size: { type: 'integer' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part_number: { type: 'integer' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'File exceeds the 10GB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Unsupported video format',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitUploadDto,
  ): Promise<InitUploadResult> {
    return this.videosService.initUpload(user.sub, dto);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload in storage and enqueues the processing job, transitioning the video from draft to processing. Only the owner may complete.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed; processing enqueued',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: 'Video belongs to another channel',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Upload is not awaiting completion',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(user.sub, id, dto);
  }

  @Get(':publicId')
  @Public()
  @ApiOperation({
    summary: 'Get a video',
    description:
      "Public read of a video's status and metadata, keyed by its public_id. Used to poll processing status and render metadata.",
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata',
    schema: {
      properties: {
        public_id: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string', example: 'ready' },
        duration_seconds: { type: 'integer', nullable: true },
        thumbnail_url: { type: 'string', nullable: true },
        created_at: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(
    @Param('publicId') publicId: string,
  ): Promise<PublicVideoView> {
    return this.videosService.getPublicView(publicId);
  }

  @Get(':publicId/stream')
  @Public()
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Issues a short-lived presigned GET URL and redirects (302); object storage serves Range/206 natively. Only ready videos are delivered.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned GET URL for the original object',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for delivery',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async streamVideo(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getDeliveryUrl(publicId);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Get(':publicId/download')
  @Public()
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Same presigned-redirect mechanism as streaming, with the signed URL carrying an attachment Content-Disposition. Only ready videos are delivered.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned GET URL with attachment disposition',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for delivery',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async downloadVideo(
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getDeliveryUrl(publicId, {
      disposition: ATTACHMENT_DISPOSITION,
    });
    return { url, statusCode: HttpStatus.FOUND };
  }
}
