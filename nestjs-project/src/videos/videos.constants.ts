/** MIME types accepted by the upload endpoint (per `#### Validation Rules — Upload`). */
export const SUPPORTED_VIDEO_MIME_TYPES: readonly string[] = [
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
];

/** Max regeneration attempts when a generated `public_id` collides on save. */
export const MAX_PUBLIC_ID_RETRIES = 5;

/** BullMQ queue that carries video-processing jobs (per `phase-03-videos/TD-01`). */
export const VIDEO_PROCESSING_QUEUE = 'video-processing';

/** Job name enqueued on upload completion, consumed by the worker (SI-03.8). */
export const PROCESS_VIDEO_JOB = 'process-video';

/** Total processing attempts before a video transitions to `error` (per `phase-03-videos/TD-01`, `TD-05`). */
export const PROCESS_VIDEO_MAX_ATTEMPTS = 3;

/** Base delay (ms) for the exponential backoff between processing retries. */
export const PROCESS_VIDEO_BACKOFF_MS = 1000;

/** Storage key of a video's generated thumbnail (per `phase-03-videos/TD-02`, `TD-07`). */
export function thumbnailKey(videoId: string): string {
  return `videos/${videoId}/thumbnail.jpg`;
}
