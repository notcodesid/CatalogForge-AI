#!/usr/bin/env bash
# Builds the image, pushes it to ECR, deploys infra/aws/catalogforge.yaml and applies the database migrations.
# Run from the project root, logged in to the AWS account: AWS_PROFILE=<profile> infra/aws/deploy.sh
# The Anthropic API key is read from .env.local the first time and kept in Secrets Manager; it's never printed
set -euo pipefail

REGION=${AWS_REGION:-eu-central-1}
STACK=${STACK_NAME:-catalogforge}
REPO=${ECR_REPOSITORY:-catalogforge}
export AWS_REGION=$REGION

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
# The commit, plus a timestamp when there are uncommitted changes (ECR tags can't be overwritten)
TAG=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then TAG="$TAG-local-$(date +%s)"; fi
IMAGE="$REGISTRY/$REPO:$TAG"

echo "== Image $IMAGE"
aws ecr describe-repositories --repository-names "$REPO" >/dev/null 2>&1 ||
  aws ecr create-repository --repository-name "$REPO" --image-tag-mutability IMMUTABLE \
    --image-scanning-configuration scanOnPush=true >/dev/null
aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
docker build --platform linux/arm64 -t "$IMAGE" .
docker push "$IMAGE"

echo "== Anthropic API key in Secrets Manager"
SECRET_NAME="$STACK/anthropic-api-key"
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "$SECRET_NAME" --query ARN --output text 2>/dev/null || true)
if [ -z "$SECRET_ARN" ]; then
  KEY_FILE=$(mktemp)
  trap 'rm -f "$KEY_FILE"' EXIT
  grep '^ANTHROPIC_API_KEY=' .env.local | cut -d= -f2- | tr -d '"\n' >"$KEY_FILE"
  [ -s "$KEY_FILE" ] || { echo "ANTHROPIC_API_KEY is not in .env.local"; exit 1; }
  SECRET_ARN=$(aws secretsmanager create-secret --name "$SECRET_NAME" --secret-string "file://$KEY_FILE" --query ARN --output text)
  rm -f "$KEY_FILE"
fi

echo "== Network and database version"
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
[ "$VPC" != "None" ] || { echo "This region has no default VPC. Create one: aws ec2 create-default-vpc"; exit 1; }
SUBNETS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" Name=default-for-az,Values=true \
  --query 'Subnets[].SubnetId' --output text | tr '\t' ',')
PREFIX_LIST=$(aws ec2 describe-managed-prefix-lists \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
  --query 'PrefixLists[0].PrefixListId' --output text)
POSTGRES=$(aws rds describe-db-engine-versions --engine postgres \
  --query "DBEngineVersions[?starts_with(EngineVersion, '17.')].EngineVersion" --output text | tr '\t' '\n' | sort -V | tail -1)
echo "VPC $VPC, subnets $SUBNETS, CloudFront prefix list $PREFIX_LIST, PostgreSQL $POSTGRES"

echo "== Stack $STACK (the first time takes about 15 minutes: the database and CloudFront are slow to create)"
aws cloudformation deploy --stack-name "$STACK" --template-file infra/aws/catalogforge.yaml \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides VpcId="$VPC" SubnetIds="$SUBNETS" CloudFrontPrefixListId="$PREFIX_LIST" \
  ImageUri="$IMAGE" AnthropicSecretArn="$SECRET_ARN" PostgresVersion="$POSTGRES"

output() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
CLUSTER=$(output ClusterName)

echo "== Migrations (a one-off task inside the VPC: the database is private)"
TASK=$(aws ecs run-task --cluster "$CLUSTER" --launch-type FARGATE --task-definition "$(output WorkerTaskDefinitionArn)" \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$(output WorkerSecurityGroupId)],assignPublicIp=ENABLED}" \
  --overrides '{"containerOverrides":[{"name":"worker","command":["pnpm","db:deploy"]}]}' \
  --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK"
EXIT=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" --query 'tasks[0].containers[0].exitCode' --output text)
[ "$EXIT" = "0" ] || { echo "Migrations failed (exit $EXIT). Logs: aws logs tail $(output LogGroupName) --since 10m"; exit 1; }

echo "== Done: $(output SiteUrl)"
