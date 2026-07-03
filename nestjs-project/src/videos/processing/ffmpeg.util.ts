import { spawn } from 'node:child_process';

/** Binaries provided by the worker image (per `phase-03-videos/TD-06`/`TD-07`). */
const FFPROBE_BIN = 'ffprobe';
const FFMPEG_BIN = 'ffmpeg';

/** Result of probing a media file for duration and raw metadata. */
export interface ProbeResult {
  /** Duration in whole seconds, matching the `videos.duration_seconds` int column. */
  durationSeconds: number;
  /**
   * Subset of the `ffprobe` JSON (`{ format, streams }`) persisted as-is in the
   * `videos.metadata` jsonb column — hence typed to match that column.
   */
  metadata: Record<string, unknown>;
}

/** Shape of the JSON emitted by `ffprobe -print_format json`. */
interface FfprobeJson {
  format?: { duration?: string } & Record<string, unknown>;
  streams?: Record<string, unknown>[];
}

/**
 * Spawns a binary, buffers stdout/stderr, and resolves with stdout on a clean
 * exit. Rejects (never resolves silently — per `.claude/rules/nestjs-services.md`)
 * on a non-zero exit code or on a spawn failure (e.g., binary not found).
 */
function runBinary(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to spawn ${command}: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `${command} exited with code ${code ?? 'null'}${
            stderr.trim() ? `: ${stderr.trim()}` : ''
          }`,
        ),
      );
    });
  });
}

/**
 * Extracts duration and metadata from a media file via
 * `ffprobe -print_format json -show_streams -show_format` (per
 * `phase-03-videos/TD-07`). Rejects on a non-zero exit or unparseable output.
 */
export async function probeMetadata(filePath: string): Promise<ProbeResult> {
  const stdout = await runBinary(FFPROBE_BIN, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_streams',
    '-show_format',
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as FfprobeJson;
  const durationSeconds =
    Math.round(Number.parseFloat(parsed.format?.duration ?? '')) || 0;

  return {
    durationSeconds,
    metadata: {
      format: parsed.format ?? {},
      streams: parsed.streams ?? [],
    },
  };
}

/**
 * Captures a single frame from a media file and writes it as a JPEG at
 * `outPath` via `ffmpeg` (per `phase-03-videos/TD-07`). Rejects on a non-zero
 * exit.
 */
export async function extractThumbnail(
  filePath: string,
  outPath: string,
): Promise<void> {
  await runBinary(FFMPEG_BIN, [
    '-y',
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    outPath,
  ]);
}
