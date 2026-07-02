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
