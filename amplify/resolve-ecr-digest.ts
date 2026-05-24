import { execSync as nodeExecSync } from 'node:child_process';

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
 * Stays sync (execSync + AWS CLI) so it slots cleanly into the
 * sync CDK construction flow in `amplify/backend.ts`. The AWS
 * CLI ships in Amplify Hosting's CodeBuild image, so no extra
 * runtime dependency on the build worker.
 */

export interface ResolveEcrDigestOptions {
  repositoryName: string;
  region: string;
  tag: string;
  /** What to hand back when ECR can't answer. Typically the same value as `tag`. */
  fallback: string;
  /** Injectable for tests. Defaults to node:child_process execSync. */
  execSync?: (cmd: string) => string | Buffer;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;

export function resolveEcrDigest(opts: ResolveEcrDigestOptions): string {
  const exec = opts.execSync ?? nodeExecSync;
  const cmd = [
    'aws ecr describe-images',
    `--region ${opts.region}`,
    `--repository-name ${opts.repositoryName}`,
    `--image-ids imageTag=${opts.tag}`,
    '--query "imageDetails[0].imageDigest"',
    '--output text',
  ].join(' ');

  let raw: string;
  try {
    const out = exec(cmd);
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
