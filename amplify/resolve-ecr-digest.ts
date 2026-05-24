import { execFileSync as nodeExecFileSync } from 'node:child_process';

/**
 * ECR `:tag` → image digest resolver, evaluated at CDK synth time
 * (#442).
 *
 * `DockerImageCode.fromEcr(repo, { tagOrDigest: 'latest' })` puts
 * the literal string `latest` into the synthesized CFN template
 * every deploy. CloudFormation diffs CFN-property strings; the
 * `Code.ImageUri` value is byte-identical across deploys when the
 * tag is the same, so CFN never schedules a Lambda code update —
 * even when the image behind the tag has been re-pushed.
 *
 * Resolving the tag to its current `sha256:...` digest at synth
 * time fixes this: each deploy that follows a new image push
 * sees a different `Code.ImageUri` value and CFN updates the
 * Lambda's image reference automatically.
 *
 * Fail-soft: if ECR can't be reached (no credentials, image not
 * yet pushed, transient network error), return the original tag.
 * Synth still succeeds and the deploy behaves as it did before
 * this helper landed.
 *
 * Synth-determinism caveat: the resolved digest depends on what
 * ECR returns at synth time, so a local-machine `cdk synth`
 * without ECR access produces a different CFN template than
 * Amplify Hosting's CodeBuild (which has ECR access via its
 * exec-role IAM). Only the deploy machine's synth output is
 * authoritative; local synths are advisory.
 *
 * Stays sync + uses `execFileSync` with an argv array so the
 * tag, repo name, and region values never touch a shell parser —
 * the helper's interface accepts arbitrary strings but no caller
 * can slip shell metacharacters past argv quoting. The AWS CLI
 * ships in Amplify Hosting's CodeBuild image, so no extra
 * runtime dependency on the build worker.
 */

export interface ResolveEcrDigestOptions {
  repositoryName: string;
  region: string;
  tag: string;
  /** What to hand back when ECR can't answer. Typically the same value as `tag`. */
  fallback: string;
  /** Injectable for tests. Defaults to node:child_process execFileSync. */
  execFileSync?: (file: string, args: readonly string[]) => string | Buffer;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;

export function resolveEcrDigest(opts: ResolveEcrDigestOptions): string {
  const exec = opts.execFileSync ?? nodeExecFileSync;
  const args = [
    'ecr',
    'describe-images',
    '--region',
    opts.region,
    '--repository-name',
    opts.repositoryName,
    '--image-ids',
    `imageTag=${opts.tag}`,
    '--query',
    'imageDetails[0].imageDigest',
    '--output',
    'text',
  ];

  let raw: string;
  try {
    const out = exec('aws', args);
    raw = (typeof out === 'string' ? out : out.toString('utf8')).trim();
  } catch {
    return opts.fallback;
  }

  // aws CLI prints the string "None" when --query resolves to null
  // (image tag not found, repository empty, etc.).
  if (!raw || raw === 'None') return opts.fallback;
  if (!DIGEST_RE.test(raw)) return opts.fallback;
  return raw;
}
