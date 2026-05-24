import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Wiring tests for #444 — grant the Amplify Hosting deploy role
 * `ecr:DescribeImages` on the Whisper repo so the synth-time digest
 * resolver from #442 stops falling back to the literal `latest` tag.
 *
 * File-content checks (matches the pattern from
 * `functions/transcribe-whisper/image-identity.test.ts`) because
 * spinning up an isolated synth context for this single Policy
 * attachment would duplicate most of `backend.ts`'s top-level wiring.
 * Drift between the resolver's fail-soft + the IAM grant is exactly
 * what these tests need to catch, and the file-level pin does that.
 */

const HERE = __dirname;

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('Amplify deploy role ECR DescribeImages grant', () => {
  it('imports Policy + Role from aws-cdk-lib/aws-iam in backend.ts', () => {
    const backend = read(join(HERE, 'backend.ts'));
    expect(backend).toMatch(
      /import\s*\{[^}]*\bPolicy\b[^}]*\bRole\b[^}]*\}\s*from\s*['"]aws-cdk-lib\/aws-iam['"]/,
    );
  });

  it('imports the deploy role by name `AutonomousSentinelAmplifyBackendDeploy`', () => {
    const backend = read(join(HERE, 'backend.ts'));
    expect(backend).toMatch(/Role\.fromRoleName\(/);
    expect(backend).toContain("'AutonomousSentinelAmplifyBackendDeploy'");
  });

  it('attaches a Policy named `WhisperEcrDescribeImages` to that role', () => {
    const backend = read(join(HERE, 'backend.ts'));
    expect(backend).toMatch(/new\s+Policy\(/);
    expect(backend).toContain("policyName: 'WhisperEcrDescribeImages'");
  });

  it('grants exactly ecr:DescribeImages — no wildcards, no extra actions', () => {
    const backend = read(join(HERE, 'backend.ts'));
    // Find the WhisperEcrDescribeImagesPolicy block and assert the
    // statement carries only the read action. Broader actions here
    // would expand the deploy role's blast radius without a reason.
    const policyBlock = backend.split('WhisperEcrDescribeImagesPolicy')[1]?.split('});')[0];
    expect(policyBlock).toBeDefined();
    expect(policyBlock).toContain("actions: ['ecr:DescribeImages']");
    expect(policyBlock).not.toContain('ecr:*');
    expect(policyBlock).not.toContain('"*"');
    // Standalone single-quoted wildcard would slip past the
    // `"*"` check above. Catch it explicitly.
    expect(policyBlock).not.toMatch(/actions:\s*\[\s*['"]\*['"]\s*\]/);
  });

  it('scopes the resource to the whisper repo ARN, not a wildcard', () => {
    const backend = read(join(HERE, 'backend.ts'));
    const policyBlock = backend.split('WhisperEcrDescribeImagesPolicy')[1]?.split('});')[0];
    expect(policyBlock).toBeDefined();
    // Resource should come from the imported repo ref, not a literal
    // wildcard — keeps the grant tight even if the repo name moves.
    expect(policyBlock).toContain('whisperRepo.repositoryArn');
  });
});
