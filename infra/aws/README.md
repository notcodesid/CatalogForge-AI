# CatalogForge on AWS

The scalable setup from [Setup: scaling past the free setup](../../docs/setup.md#scaling-past-the-free-setup), as
one CloudFormation stack in `eu-central-1`. Written and checked (cfn-lint, a local container run), but not deployed
yet: the AWS account it was meant for doesn't allow these services.

| Part | On AWS |
|---|---|
| Web app | ECS Fargate (ARM64), behind an Application Load Balancer that only CloudFront may reach. CloudFront gives HTTPS |
| Workers | ECS Fargate, 1 to 3 tasks. They scale on the queue backlog each worker reports to CloudWatch every minute |
| Database | RDS PostgreSQL 17, private: only the web and worker tasks can connect. The password stays in Secrets Manager |
| Files | S3, reached with the tasks' IAM role (no access keys) |

Both services run the same image (`Dockerfile`); the task picks `pnpm start` or `pnpm worker`.

## Deploy

Logged in to the AWS account, from the project root:

```bash
AWS_PROFILE=<profile> infra/aws/deploy.sh
```

It builds and pushes the image to ECR, stores the Anthropic key from `.env.local` in Secrets Manager (never printed),
deploys `catalogforge.yaml` (about 15 minutes the first time) and runs the migrations as a one-off task inside the
VPC (`pnpm db:deploy`), then prints the site's address. Run it again to deploy a new version.

Roughly $75 a month at this size: the database, two small Fargate tasks, the load balancer and public IPv4 addresses.
