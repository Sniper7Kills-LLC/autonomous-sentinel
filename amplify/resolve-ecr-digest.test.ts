import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  let execSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execSyncMock = vi.fn();
  });

  it('returns the digest string from a successful ECR call', () => {
    execSyncMock.mockReturnValue(
      'sha256:28003889af34f040f3960ca5f886dfdfeddde960493633942df65d77f7f80e3c\n',
    );
    const digest = resolveEcrDigest({
      repositoryName: 'autonomous-sentinel/whisper-medium',
      region: 'us-east-1',
      tag: 'latest',
      fallback: 'latest',
      execSync: execSyncMock,
    });
    expect(digest).toBe('sha256:28003889af34f040f3960ca5f886dfdfeddde960493633942df65d77f7f80e3c');
  });

  it('passes repo + region + tag through to aws ecr describe-images', () => {
    execSyncMock.mockReturnValue('sha256:deadbeef\n');
    resolveEcrDigest({
      repositoryName: 'autonomous-sentinel/whisper-medium',
      region: 'us-east-1',
      tag: 'latest',
      fallback: 'latest',
      execSync: execSyncMock,
    });
    const firstCall = execSyncMock.mock.calls[0];
    if (!firstCall) throw new Error('execSync was not invoked');
    const cmd = firstCall[0] as string;
    expect(cmd).toContain('aws ecr describe-images');
    expect(cmd).toContain('--region us-east-1');
    expect(cmd).toContain('--repository-name autonomous-sentinel/whisper-medium');
    expect(cmd).toContain('imageTag=latest');
    expect(cmd).toContain('--query');
    expect(cmd).toContain('imageDigest');
    expect(cmd).toContain('--output text');
  });

  it('falls back to the fallback tag when execSync throws (no creds, network out, ECR error)', () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('Unable to locate credentials');
    });
    const digest = resolveEcrDigest({
      repositoryName: 'autonomous-sentinel/whisper-medium',
      region: 'us-east-1',
      tag: 'latest',
      fallback: 'latest',
      execSync: execSyncMock,
    });
    expect(digest).toBe('latest');
  });

  it('falls back when stdout is empty (e.g. image not pushed yet)', () => {
    execSyncMock.mockReturnValue('');
    const digest = resolveEcrDigest({
      repositoryName: 'autonomous-sentinel/whisper-medium',
      region: 'us-east-1',
      tag: 'latest',
      fallback: 'latest',
      execSync: execSyncMock,
    });
    expect(digest).toBe('latest');
  });

  it('falls back when stdout is the literal string "None" (aws CLI sentinel for missing query result)', () => {
    execSyncMock.mockReturnValue('None\n');
    const digest = resolveEcrDigest({
      repositoryName: 'autonomous-sentinel/whisper-medium',
      region: 'us-east-1',
      tag: 'latest',
      fallback: 'latest',
      execSync: execSyncMock,
    });
    expect(digest).toBe('latest');
  });

  it('rejects stdout that does not look like a sha256 digest (defends against malformed CLI output)', () => {
    execSyncMock.mockReturnValue('not-a-digest\n');
    const digest = resolveEcrDigest({
      repositoryName: 'autonomous-sentinel/whisper-medium',
      region: 'us-east-1',
      tag: 'latest',
      fallback: 'latest',
      execSync: execSyncMock,
    });
    expect(digest).toBe('latest');
  });

  it('trims whitespace around the returned digest', () => {
    execSyncMock.mockReturnValue(
      '   sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abcd   \n',
    );
    const digest = resolveEcrDigest({
      repositoryName: 'autonomous-sentinel/whisper-medium',
      region: 'us-east-1',
      tag: 'latest',
      fallback: 'latest',
      execSync: execSyncMock,
    });
    expect(digest).toBe('sha256:abc123def456abc123def456abc123def456abc123def456abc123def456abcd');
  });
});
