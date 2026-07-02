import { nanoid } from 'nanoid';

/** Length of a video's public URL id; matches `videos.public_id` varchar(21). */
export const PUBLIC_ID_LENGTH = 21;

/**
 * Generates a short, URL-safe, collision-resistant public id for a video.
 *
 * Uses nanoid's secure default RNG and URL-safe alphabet (`A-Za-z0-9_-`) — no
 * characters that require URL encoding. Final uniqueness is guaranteed by the
 * `videos.public_id` unique constraint with regenerate-on-conflict in
 * `VideosService`.
 *
 * nanoid is pinned to v3 (CommonJS `require`-compatible) so it imports cleanly
 * under the project's CommonJS build; v5 is ESM-only.
 */
export function generatePublicId(): string {
  return nanoid(PUBLIC_ID_LENGTH);
}
