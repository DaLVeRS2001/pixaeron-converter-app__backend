# Adding a new deployable service

This deployment setup is intentionally small:

- `.github/deploy-services.json` is the list of services that can be deployed.
- `.github/workflows/ci.yml` reads that JSON and creates the GitHub Actions matrix automatically.
- `docker-compose.production.yaml` defines how services run on the Lightsail VM.
- Every service has its own GitHub Environment secret containing its production runtime env file.

You should not create a new workflow per service.
You should not create env files manually on the Lightsail server. The workflow installs them with mode `600`.

## 1. Add the service to `.github/deploy-services.json`

Example for a service without migrations:

```json
{
  "project": "executor",
  "imageName": "ghcr.io/dalvers2001/pixaeron-executor",
  "dockerfile": "apps/executor/Dockerfile",
  "composeService": "executor",
  "imageTagEnv": "EXECUTOR_IMAGE_TAG",
  "runtimeEnvSecret": "EXECUTOR_RUNTIME_ENV",
  "runtimeEnvFileEnv": "EXECUTOR_RUNTIME_ENV_FILE",
  "migrationCommand": ""
}
```

Example for a service with Prisma migrations:

```json
{
  "project": "jobs",
  "imageName": "ghcr.io/dalvers2001/pixaeron-jobs",
  "dockerfile": "apps/jobs/Dockerfile",
  "composeService": "jobs",
  "imageTagEnv": "JOBS_IMAGE_TAG",
  "runtimeEnvSecret": "JOBS_RUNTIME_ENV",
  "runtimeEnvFileEnv": "JOBS_RUNTIME_ENV_FILE",
  "migrationCommand": "./node_modules/.bin/prisma migrate deploy --config apps/jobs/prisma.config.ts"
}
```

Field meaning:

| Field               | Meaning                                                                      |
| ------------------- | ---------------------------------------------------------------------------- |
| `project`           | Nx project name. Must match `project.json` `name`.                           |
| `imageName`         | Container image name in GHCR.                                                |
| `dockerfile`        | Dockerfile used to build this service.                                       |
| `composeService`    | Service name in `docker-compose.production.yaml`.                            |
| `imageTagEnv`       | Env var used by Compose for this service image tag.                          |
| `runtimeEnvSecret`  | GitHub Environment secret containing only this service's runtime variables.  |
| `runtimeEnvFileEnv` | Env var used by Compose for this service's env-file path.                    |
| `migrationCommand`  | Command executed before `docker compose up`. Use empty string if not needed. |

## 2. Add the service to `docker-compose.production.yaml`

Example:

```yaml
jobs:
  image: ghcr.io/dalvers2001/pixaeron-jobs:${JOBS_IMAGE_TAG:-latest}
  restart: unless-stopped
  env_file:
    - ${JOBS_RUNTIME_ENV_FILE:-/opt/pixaeron/jobs.env}
  environment:
    NODE_ENV: production
    PORT: 3001
  ports:
    - '127.0.0.1:3001:3001'
```

Use a separate env file for every service. This prevents `jobs`, `executor`, and future services from receiving auth secrets they do not use.

## 3. Create the service runtime secret

Go to:

```text
GitHub repository
Settings
Environments
production
Environment secrets
JOBS_RUNTIME_ENV
```

Store only variables used by this service, for example:

```env
PULSAR_SERVICE_URL=pulsar://...
JOBS_CONCURRENCY=5
```

If only a runtime secret changed and no code changed, run the workflow manually with:

```text
workflow_dispatch -> service: all
```

or:

```text
workflow_dispatch -> service: jobs
```

## 4. Server setup is still one-time only

The Lightsail VM only needs the shared deployment directory and certificate directory:

```bash
sudo install -d -m 755 /opt/pixaeron /opt/pixaeron/certs
sudo chown -R "$USER:$USER" /opt/pixaeron
```

If PostgreSQL uses `sslrootcert=/app/certs/global-bundle.pem`, put the certificate here once:

```text
/opt/pixaeron/certs/global-bundle.pem
```

The pipeline creates or updates these files automatically during deployment:

```text
/opt/pixaeron/auth.env
/opt/pixaeron/jobs.env
/opt/pixaeron/deployment.env
/opt/pixaeron/docker-compose.production.yaml
/opt/pixaeron/deploy-service.sh
```

## 5. What happens on deployment

The verify job combines `.github/deploy-services.json` with the Nx affected
project list. Deploy jobs are created only for selected services.

```text
Is this service affected?
```

If yes, it:

1. builds the service Dockerfile, whose builder stage creates the pruned runtime package;
2. pushes `image:sha-<commit>`;
3. generates the service env file from its GitHub secret;
4. uploads the service env, Compose file, and shared deployment script to Lightsail;
5. updates only this service image tag in `/opt/pixaeron/deployment.env`;
6. runs migrations if `migrationCommand` is not empty;
7. runs `docker compose up -d --wait <service>`;
8. restores the previous Compose, env, image tag, and container if deployment fails.

Adding a new service should not require editing `.github/workflows/ci.yml`.
