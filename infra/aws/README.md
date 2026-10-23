# CatalogForge on AWS

The scalable setup from [Setup: scaling past the free setup](../../docs/setup.md#scaling-past-the-free-setup), as
one CloudFormation stack. Live at https://d1bmdg6rm9fedd.cloudfront.net, in Sydney (`ap-southeast-2`): the AWS
account's organization only allows that region. The template works in any region.

| Part | On AWS |
|---|---|
| Web app | ECS Fargate (ARM64), behind an Application Load Balancer that only CloudFront may reach. CloudFront gives HTTPS |
| Workers | ECS Fargate, 1 to 3 tasks. They scale on the queue backlog each worker reports to CloudWatch every minute |
| Database | RDS PostgreSQL 17, private: only the web and worker tasks can connect. The password stays in Secrets Manager |
| Files | S3, reached with the tasks' IAM role (no access keys) |

Both services run the same image (`Dockerfile`); the task picks `pnpm start` or `pnpm worker`.

Measured on the live stack:

| Test | Result |
|---|---|
| Round 1 sheet with 14 photos | 13 rows in 27 s: 10 Done, 3 Needs review, 0 Failed; 12 photos matched and stored in S3; German and French done |
| 1,000-row sheet | Queue backlog rose to 135 jobs, the scale-out alarm fired after 2 minutes and the workers went from 1 to 3. All 1,000 rows done in 3 min 23 s (762 Done, 238 Needs review, 0 Failed), then back down |
| 15 MB upload | Reaches the app through CloudFront and the load balancer (no 4 MB limit as on Vercel's free plan) |

## Deploy

Logged in to the AWS account, from the project root:

```bash
AWS_PROFILE=<profile> AWS_REGION=ap-southeast-2 infra/aws/deploy.sh
```

It builds and pushes the image to ECR, stores the Anthropic key from `.env.local` in Secrets Manager (never printed),
deploys `catalogforge.yaml` (about 15 minutes the first time) and runs the migrations as a one-off task inside the
VPC (`pnpm db:deploy`), then prints the site's address. Run it again to deploy a new version. If the AWS login
expires while it waits for the stack, run it again: an image already in ECR isn't built or pushed twice.

Roughly $75 a month at this size: the database, two small Fargate tasks, the load balancer and public IPv4 addresses.
