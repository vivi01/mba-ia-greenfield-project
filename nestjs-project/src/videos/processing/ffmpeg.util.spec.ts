import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { probeMetadata, extractThumbnail } from './ffmpeg.util';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

const spawnMock = spawn as jest.MockedFunction<typeof spawn>;

/** Minimal ChildProcess stand-in: stdout/stderr streams + process events. */
interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('ffmpeg.util', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  describe('probeMetadata', () => {
    it('spawns ffprobe with the JSON metadata argument list', async () => {
      const child = createFakeChild();
      spawnMock.mockReturnValue(child as never);

      const promise = probeMetadata('/tmp/video.mp4');
      child.stdout.emit(
        'data',
        Buffer.from(JSON.stringify({ format: { duration: '10' }, streams: [] })),
      );
      child.emit('close', 0);
      await promise;

      expect(spawnMock).toHaveBeenCalledWith('ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        '-show_format',
        '/tmp/video.mp4',
      ]);
    });

    it('parses the ffprobe JSON into rounded durationSeconds and metadata', async () => {
      const child = createFakeChild();
      spawnMock.mockReturnValue(child as never);
      const probeJson = {
        format: { duration: '42.6', bit_rate: '800000' },
        streams: [{ codec_type: 'video', width: 1920, height: 1080 }],
      };

      const promise = probeMetadata('/tmp/video.mp4');
      child.stdout.emit('data', Buffer.from(JSON.stringify(probeJson)));
      child.emit('close', 0);
      const result = await promise;

      expect(result.durationSeconds).toBe(43);
      expect(result.metadata.format).toEqual(probeJson.format);
      expect(result.metadata.streams).toEqual(probeJson.streams);
    });

    it('defaults durationSeconds to 0 when format.duration is absent', async () => {
      const child = createFakeChild();
      spawnMock.mockReturnValue(child as never);

      const promise = probeMetadata('/tmp/video.mp4');
      child.stdout.emit('data', Buffer.from(JSON.stringify({ streams: [] })));
      child.emit('close', 0);
      const result = await promise;

      expect(result.durationSeconds).toBe(0);
      expect(result.metadata).toEqual({ format: {}, streams: [] });
    });

    it('rejects with the stderr detail when ffprobe exits non-zero', async () => {
      const child = createFakeChild();
      spawnMock.mockReturnValue(child as never);

      const promise = probeMetadata('/tmp/missing.mp4');
      child.stderr.emit('data', Buffer.from('No such file or directory'));
      child.emit('close', 1);

      await expect(promise).rejects.toThrow(
        'ffprobe exited with code 1: No such file or directory',
      );
    });

    it('rejects when the ffprobe binary cannot be spawned', async () => {
      const child = createFakeChild();
      spawnMock.mockReturnValue(child as never);

      const promise = probeMetadata('/tmp/video.mp4');
      child.emit('error', new Error('spawn ffprobe ENOENT'));

      await expect(promise).rejects.toThrow(
        'Failed to spawn ffprobe: spawn ffprobe ENOENT',
      );
    });
  });

  describe('extractThumbnail', () => {
    it('spawns ffmpeg with the single-frame JPEG argument list', async () => {
      const child = createFakeChild();
      spawnMock.mockReturnValue(child as never);

      const promise = extractThumbnail('/tmp/video.mp4', '/tmp/thumb.jpg');
      child.emit('close', 0);
      await promise;

      expect(spawnMock).toHaveBeenCalledWith('ffmpeg', [
        '-y',
        '-i',
        '/tmp/video.mp4',
        '-frames:v',
        '1',
        '-q:v',
        '2',
        '/tmp/thumb.jpg',
      ]);
    });

    it('rejects with the stderr detail when ffmpeg exits non-zero', async () => {
      const child = createFakeChild();
      spawnMock.mockReturnValue(child as never);

      const promise = extractThumbnail('/tmp/bad.mp4', '/tmp/thumb.jpg');
      child.stderr.emit('data', Buffer.from('Invalid data found'));
      child.emit('close', 1);

      await expect(promise).rejects.toThrow(
        'ffmpeg exited with code 1: Invalid data found',
      );
    });
  });
});
