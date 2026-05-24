#!/usr/bin/env bash
# Bootstrap script for the Whisper container image build pipeline.
#
# Per AWS Prescriptive Guidance ("Deploy Lambda functions with
# container images"), the image build is a separate CodeBuild
# project (privilegedMode=true) that pushes to ECR; the Amplify
# Hosting backend deploy just references the existing image via
# `DockerImageCode.fromEcr`.
#
# Why a shell script instead of CDK/CFN: AWS CloudFormation +
# CodeBuild + CodeConnections has an unresolved interaction
# where CFN-mediated `AWS::CodeBuild::Project` creation fails
# with `OAuthProviderException` even though the same payload
# created via direct `aws codebuild create-project` CLI works.
# Direct CLI calls bypass the issue. One-shot bootstrap script
# is the simplest reliable path; resources are idempotent so
# re-running is safe.
#
# Usage:
#   AWS_PROFILE=eamwatch bash infra/whisper-image-pipeline/bootstrap.sh
#
# Re-running: idempotent — checks each resource and creates only
# if missing. ECR repo, IAM role, and CodeBuild project all carry
# the same name on re-run.

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-142915667650}"
GITHUB_OWNER="${GITHUB_OWNER:-Sniper7Kills-LLC}"
GITHUB_REPO="${GITHUB_REPO:-autonomous-sentinel}"
TRIGGER_BRANCH="${TRIGGER_BRANCH:-main}"
ECR_REPO_NAME="${ECR_REPO_NAME:-autonomous-sentinel/whisper-medium}"
CODEBUILD_PROJECT="${CODEBUILD_PROJECT:-autonomous-sentinel-whisper-image}"
CODEBUILD_ROLE="${CODEBUILD_ROLE:-autonomous-sentinel-whisper-build-role}"
CODE_CONNECTION_ARN="${CODE_CONNECTION_ARN:-arn:aws:codeconnections:${AWS_REGION}:${AWS_ACCOUNT_ID}:connection/bab5a874-0586-4054-bddd-11a26b88ab04}"

ECR_REPO_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}"

echo "[bootstrap] account=${AWS_ACCOUNT_ID} region=${AWS_REGION}"
echo "[bootstrap] ECR=${ECR_REPO_URI}"
echo "[bootstrap] CodeBuild project=${CODEBUILD_PROJECT}"

# ---------- 1. ECR repo ------------------------------------------------------

if aws ecr describe-repositories --repository-names "${ECR_REPO_NAME}" --region "${AWS_REGION}" >/dev/null 2>&1; then
  echo "[bootstrap] ECR repo exists — skip create"
else
  echo "[bootstrap] creating ECR repo..."
  aws ecr create-repository \
    --repository-name "${ECR_REPO_NAME}" \
    --image-tag-mutability MUTABLE \
    --image-scanning-configuration scanOnPush=true \
    --region "${AWS_REGION}" >/dev/null
  echo "[bootstrap] ECR repo created"
fi

# Lifecycle policy — keep last 10 images, expire untagged after 14d.
LIFECYCLE_POLICY='{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Expire untagged images after 14 days",
      "selection": { "tagStatus": "untagged", "countType": "sinceImagePushed", "countUnit": "days", "countNumber": 14 },
      "action": { "type": "expire" }
    },
    {
      "rulePriority": 2,
      "description": "Keep last 10 images of any tag",
      "selection": { "tagStatus": "any", "countType": "imageCountMoreThan", "countNumber": 10 },
      "action": { "type": "expire" }
    }
  ]
}'
aws ecr put-lifecycle-policy \
  --repository-name "${ECR_REPO_NAME}" \
  --lifecycle-policy-text "${LIFECYCLE_POLICY}" \
  --region "${AWS_REGION}" >/dev/null
echo "[bootstrap] ECR lifecycle policy applied"

# ---------- 2. IAM role for CodeBuild ---------------------------------------

TRUST_POLICY='{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "codebuild.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}'
if aws iam get-role --role-name "${CODEBUILD_ROLE}" >/dev/null 2>&1; then
  echo "[bootstrap] IAM role exists — skip create"
else
  echo "[bootstrap] creating IAM role..."
  aws iam create-role \
    --role-name "${CODEBUILD_ROLE}" \
    --assume-role-policy-document "${TRUST_POLICY}" >/dev/null
  # IAM eventual consistency.
  sleep 8
  echo "[bootstrap] IAM role created"
fi

# Policy: ECR push + auth, CloudWatch Logs, CodeConnections.
ROLE_POLICY='{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecr:GetAuthorizationToken"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": "arn:aws:ecr:'"${AWS_REGION}"':'"${AWS_ACCOUNT_ID}"':repository/'"${ECR_REPO_NAME}"'"
    },
    {
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:'"${AWS_REGION}"':'"${AWS_ACCOUNT_ID}"':log-group:/aws/codebuild/'"${CODEBUILD_PROJECT}"':*"
    },
    {
      "Effect": "Allow",
      "Action": ["codeconnections:GetConnectionToken", "codeconnections:GetConnection"],
      "Resource": "'"${CODE_CONNECTION_ARN}"'"
    }
  ]
}'
aws iam put-role-policy \
  --role-name "${CODEBUILD_ROLE}" \
  --policy-name WhisperBuildPipelinePolicy \
  --policy-document "${ROLE_POLICY}" >/dev/null
echo "[bootstrap] IAM role policy applied"

ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${CODEBUILD_ROLE}"

# ---------- 3. CodeBuild project --------------------------------------------

# Buildspec inline — cd into the whisper dir, build, push :latest + :<sha>.
# NB: every command is a quoted YAML scalar to avoid colon-in-text
# confusing the YAML re-parser CodeBuild runs at DOWNLOAD_SOURCE
# (`docker build -t img:tag` would otherwise be parsed as a YAML
# mapping). Single quotes inside `'...'` doubled per YAML spec.
BUILDSPEC=$(cat <<'BUILDSPEC_EOF'
version: 0.2
phases:
  pre_build:
    commands:
      - 'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $ECR_REGISTRY'
  build:
    commands:
      - 'cd amplify/functions/transcribe-whisper'
      - 'docker build -t $ECR_REPO_URI:latest -t $ECR_REPO_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION .'
  post_build:
    commands:
      - 'docker push $ECR_REPO_URI:latest'
      - 'docker push $ECR_REPO_URI:$CODEBUILD_RESOLVED_SOURCE_VERSION'
BUILDSPEC_EOF
)

PROJECT_INPUT=$(cat <<JSON_EOF
{
  "name": "${CODEBUILD_PROJECT}",
  "description": "Builds Whisper container Lambda image + pushes to ECR. Webhook-triggered on transcribe-whisper path changes.",
  "source": {
    "type": "GITHUB",
    "location": "https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}.git",
    "buildspec": $(echo "$BUILDSPEC" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))"),
    "auth": {
      "type": "CODECONNECTIONS",
      "resource": "${CODE_CONNECTION_ARN}"
    }
  },
  "artifacts": { "type": "NO_ARTIFACTS" },
  "environment": {
    "type": "LINUX_CONTAINER",
    "image": "aws/codebuild/standard:7.0",
    "computeType": "BUILD_GENERAL1_LARGE",
    "privilegedMode": true,
    "environmentVariables": [
      { "name": "ECR_REPO_URI", "value": "${ECR_REPO_URI}", "type": "PLAINTEXT" },
      { "name": "ECR_REGISTRY", "value": "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com", "type": "PLAINTEXT" }
    ]
  },
  "serviceRole": "${ROLE_ARN}",
  "timeoutInMinutes": 30
}
JSON_EOF
)

if aws codebuild batch-get-projects --names "${CODEBUILD_PROJECT}" --region "${AWS_REGION}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('projects') else 1)" 2>/dev/null; then
  echo "[bootstrap] CodeBuild project exists — updating"
  echo "${PROJECT_INPUT}" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d))" \
    > /tmp/cb-project-update.json
  aws codebuild update-project --cli-input-json file:///tmp/cb-project-update.json --region "${AWS_REGION}" >/dev/null
  echo "[bootstrap] CodeBuild project updated"
else
  echo "[bootstrap] creating CodeBuild project..."
  echo "${PROJECT_INPUT}" > /tmp/cb-project-create.json
  aws codebuild create-project --cli-input-json file:///tmp/cb-project-create.json --region "${AWS_REGION}" >/dev/null
  echo "[bootstrap] CodeBuild project created"
fi

# ---------- 4. Webhook -------------------------------------------------------

FILTER_GROUPS='[[
  {"type":"EVENT","pattern":"PUSH"},
  {"type":"HEAD_REF","pattern":"refs/heads/'"${TRIGGER_BRANCH}"'"},
  {"type":"FILE_PATH","pattern":"^amplify/functions/transcribe-whisper/.*"}
]]'

# Re-create webhook idempotently — delete-if-exists then create.
aws codebuild delete-webhook --project-name "${CODEBUILD_PROJECT}" --region "${AWS_REGION}" 2>/dev/null || true

aws codebuild create-webhook \
  --project-name "${CODEBUILD_PROJECT}" \
  --filter-groups "${FILTER_GROUPS}" \
  --region "${AWS_REGION}" >/dev/null

echo "[bootstrap] webhook created (path-filtered to amplify/functions/transcribe-whisper/**)"

# ---------- 5. Trigger first build ------------------------------------------

echo ""
echo "[bootstrap] DONE."
echo ""
echo "  ECR repo:    ${ECR_REPO_URI}"
echo "  CodeBuild:   ${CODEBUILD_PROJECT}"
echo "  Webhook:     PUSH to ${TRIGGER_BRANCH}, file_path ^amplify/functions/transcribe-whisper/.*"
echo ""
echo "Next: kick off the first build manually (webhook fires only on path-relevant pushes):"
echo ""
echo "  aws --profile eamwatch codebuild start-build \\"
echo "    --project-name ${CODEBUILD_PROJECT} --region ${AWS_REGION}"
echo ""
