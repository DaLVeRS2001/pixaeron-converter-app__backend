# pixaeron-converter-app\_\_backend

Backend Nx workspace for the Pixaeron image conversion application. It contains
five deployable services and the libraries they share:

- `apps/auth` — Federation 2 Identity/Auth subgraph: registration, email
  verification, password recovery, Google sign-in, cookie sessions and session
  audit;
- `apps/notifications` — private transactional-email service: gRPC command
  contract, Amazon SES delivery, SES feedback ingestion, suppression and
  retention. It has no public GraphQL surface and no host port;
- `apps/conversion-api` — Federation 2 conversion subgraph: batch admission,
  presigned S3 uploads, quotas and storage windows, the outbox that feeds SQS
  and the consumer of worker events;
- `apps/conversion-worker` — SQS consumer that compresses the uploaded images
  with sharp, writes the results and their previews to S3 and reports back;
- `apps/gateway` — Apollo Router with a statically composed supergraph, the only
  service reachable from the public internet.

The repository is public. It holds no runtime secrets: production configuration
lives in AWS Systems Manager Parameter Store and is written into mode-0600
runtime env files by CI at release time. `.env.example` and
`runtime.env.example` document the shape of those values, never the values.

## Local development

Use Node.js 24 for parity with CI.

```powershell
npm ci
npx nx run auth:prisma-generate
npx nx run notifications:prisma-generate
npx nx run conversion-api:prisma-generate
npm run docker:start
```

`docker-compose.yaml` is the local stack; `docker-compose.production.yaml` is the
deployed model and is not meant to be run by hand. Local Compose publishes
Gateway on `127.0.0.1:4000` and Auth on `127.0.0.1:3001`; Notifications and
conversion-api are reachable only inside the Compose network, the latter
through the router. Conversion-api and the conversion worker read `apps/conversion-api/.env`
and `apps/conversion-worker/.env`, whose `SQS_QUEUE_SUFFIX=-dev` and
`CONVERSION_S3_BUCKET` select the dev queue copies and the dev bucket, so a local
compression is a real round trip through SQS and S3.
The gateway composes the supergraph from the committed subgraph schemas at build
time, so rebuild it after a schema change: `docker compose up -d --build gateway`.

## Verification

```powershell
npm run check
npm run schema:check
npm run contracts:check
```

`npm run check` runs the lint, test and build targets across the workspace. The
GraphQL and protobuf contract checks are separate because both are cross-repository
contracts: the composed schema is consumed by the frontend, and the protobuf
contract is consumed by Auth and Notifications together.

## Documentation

Operational and architectural guides live under `docs/`, indexed by
`docs/AGENTS.md`. That directory is intentionally untracked pending a move to a
separate documentation repository, so it is present in a working tree but not in
a clone of this repository.

Deployment mechanics are not in this repository either. The reusable workflow and
the deployment scripts live in the central CI repository and are pinned here by
full commit SHA in `.github/workflows/ci.yml`.
