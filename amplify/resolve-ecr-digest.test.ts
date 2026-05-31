import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { resolveEcrDigest } from './resolve-ecr-digest';

/**
 * Behaviour tests for the ECR digest resolver (#442).
 *
 * The resolver runs at CDK synth time and asks ECR what digest
 * the configured tag points at right now. That digest is what
 * we hand to `DockerImageCode.fromEcr` so CFN sees a fresh
 * `Code.ImageUri` value on every deploy that follows a new
 * image push.
 */

describe('resolveEcrDigest', () => {
  let execFileSyncMock: Mock<(file: string, args: readonly string[]) => string>;

  beforeEach(() => {
    execFileSyncMock = vi.fn<(file: string, args: readonly string[]) => string>();
  });

  it('returns the digest string from a successful ECR call', () => {
    execFileSyncMock.mockReturnValue(
      'sha256:28003889af34f040f3960ca5f886dfdfeddde960493633942df65d77f7f80e3c\n',
    );
    const digest = resolveEcrDigest({
      repositoryName: 'autonomous-sentinel/whisper-medium',
      region: 'us-east-1',
      tag: 'latest',
      fallback: 'latest',
      execFileSync: execFileSyncMock,
    });
    expect(digest).toBe('sha256:28003889af34f040f3960ca5f886dfdfeddde960493633942df65d77f7f80e3c');
  });

  it('shells `aws` directly with an argv array so values never reach a shell parser', () => {
    execFileSyncMock.mockReturnValue('sha256:deadbeef\n');
    resolveEcrDigest({
      repositoryName: 'autonomous-sentinel/whisper-medium',
      region: 'us-east-1',
      tag: 'latest',
      fallback: 'latest',
      execFileSync: execFileSyncMock,
    });
    const firstCall = execFileSyncMock.mock.calls[0];
    if (!firstCall) throw new Error('execFileSync was not invoked');
    const [file, args] = firstCall;
    expect(file).toBe('aws');
    expect(args).toContain('ecr');
    expect(args).toContain('describe-images');
    expect(args).toContain('--region');
    expect(args).toContain('us-east-1');
    expect(args).toContain('--repository-name');
    expect(args).toContain('autonomous-sentinel/whisper-medium');
    expect(args).toContain('--image-ids');
    expect(args).toContain('imageTag=latest');
    expect(args).toContain('--query');
    expect(args).toContain('imageDetails[0].imageDigest');
    expect(args).toContain('--output');
    expect(args).toContain('text');
  });

  it('treats argv values as literal — shell metacharacters in the tag are passed through unparsed', () => {
    // Defensive test: a hostile tag like `foo; rm -rf /` must reach
    // the aws CLI as a single argv value, not get interpreted by a
    // shell. With execFileSync + argv array this is automatic; the
    // assertion makes the property visible to future readers.
    execFileSyncMock.mockReturnValue('None\n');
    resolveEcrDigest({
      repositoryName: 'autonomous-sentinel/whisper-medium',
      region: 'us-east-1',
      tag: 'foo; rm -rf /',
      fallback: 'latest',
      execFileSync: execFileSyncMock,
    });
    const firstCall = execFileSyncMock.mock.calls[0];
    if (!firstCall) throw new Error('execFileSync was not invoked');
    const [, args] = firstCall;
    expect(args).toContain('imageTag=foo; rm -rf /');
  });

  it('falls back to the fallback tag when execFileSync throws (no creds, network out, ECR error)', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('Unable to locate credentials');
    });
    const digest = resolveEcrDigest({
      repositoryName: 'autonomous-sentinel/whisper-medium',
      region: 'us-east-1',
      tag: 'latest',
      fallback: 'latest',
      execFileSync: execFileSyncMock,
    });
    expect(digest).toBe('latest');
  });

  it('falls back when stdout is empty (e.g. image not pushed yet)', () => {
    execFileSyncMock.mockReturnValue('');
    const digest = resolveEcrDigest({
      repositoryName: 'autonomous-sentinel/whisper-medium',
      region: 'us-east-1',
      tag: 'latest',
      fallback: 'latest',
      execFileSync: execFileSyncMock,
    });
    expect(digest).toBe('latest');
  });

  it('falls back when stdout is the literal string "None" (aws CLI sentinel for missing query result)', () => {
    execFileSyncMock.mockReturnValue('None\n');
    const digest = resolveEcrDigest({
      repositoryName: 'autonomous-sentinel/whisper-medium',
      region: 'us-east-1',
      tag: 'latest',
      fallback: 'latest',
      execFileSync: execFileSyncMock,
    });
    expect(digest).toBe('latest');
  });

  it('rejects stdout that does not look like a sha256 digest (defends against malformed CLI output)', () => {
    execFileSyncMock.mockReturnValue('not-a-digest\n');
    const digest = resolveEcrDigest({
      repositoryName: 'autonomous-sentinel/whisper-medium',
      region: 'us-east-1',
      tag: 'latest',
      fallback: 'latest',
      execFileSync: execFileSyncMock,
    });
    expect(digest).toBe('latest');
  });

  it('trims whitespace around the returned digest', () => {
    execFileSyncMock.mockReturnValue(
      '   sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abcd   \n',
    );
    const digest = resolveEcrDigest({
      repositoryName: 'autonomous-sentinel/whisper-medium',
      region: 'us-east-1',
      tag: 'latest',
      fallback: 'latest',
      execFileSync: execFileSyncMock,
    });
    expect(digest).toBe('sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abcd');
  });
});
