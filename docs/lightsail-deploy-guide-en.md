# Pixaeron: Simple Production Deployment on Lightsail

This approach is intended for a full-stack developer and one application VPS. It does not require Ansible, Terraform, Kubernetes, a self-hosted runner, or a separate deployment framework.

## 1. Target Architecture

```text
push to main
    |
    v
GitHub Actions
    |- runs lint, tests, and builds for affected Nx projects
    |- builds affected service Docker images
    |- pushes immutable sha-tagged images to GHCR
    `- connects to the VPS over SSH
             |
             v
      docker compose pull
      prisma migrate deploy
      docker compose up -d
      GET /auth/health
             |
             v
Lightsail managed PostgreSQL over its private endpoint and TLS
```

The deployment consists of these readable files:

```text
apps/auth/Dockerfile
apps/auth/auth.env.example
docker-compose.production.yaml
.github/deploy-services.json
.github/workflows/ci.yml
scripts/deploy-service.sh
```

## 2. Definitions

**Docker image** is a built version of the application with its runtime dependencies.

**Container** is a running instance of a Docker image.

**Docker Compose** is a YAML file describing containers and their configuration.

**GHCR, GitHub Container Registry**, stores Docker images in GitHub.

**CI/CD** is a workflow that verifies code, builds an image, and starts the new version on the server.

**SSH** is an encrypted connection used to execute commands on the VPS.

**Migration** is a version-controlled PostgreSQL schema change. Production uses `prisma migrate deploy`.

**Health check** is `GET /auth/health`, which verifies that NestJS is running and can query PostgreSQL.

## 3. One-Time Work

Prepare a clean VPS once:

1. Install Docker and Compose.
2. Create `/opt/pixaeron`.
3. Add the AWS database CA certificate.
4. Add a dedicated SSH key for GitHub Actions.
5. Create the GitHub `production` Environment and its secrets.

Afterward, a push to `main` performs the normal deployment automatically.

## 4. Prepare the Ubuntu VPS

Connect with the existing operator key:

```bash
ssh ubuntu@STATIC_IP
```

Install Ubuntu packages:

```bash
sudo apt update
sudo apt install -y docker.io docker-compose-v2 curl
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Reconnect so Linux applies Docker group membership:

```bash
exit
ssh ubuntu@STATIC_IP
docker version
docker compose version
```

Create directories:

```bash
sudo mkdir -p /opt/pixaeron/certs
sudo chown -R "$USER:$USER" /opt/pixaeron
```

Download the AWS CA certificate used to verify the TLS database connection:

```bash
curl -fsSLo /opt/pixaeron/certs/global-bundle.pem \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

That is the complete server preparation. The VPS never performs Docker builds or `npm ci`.

## 5. Create the Production Environment

Copy [runtime.env.example](../runtime.env.example), replace these placeholders, and store the complete content as the GitHub Environment secret `AUTH_RUNTIME_ENV`:

```text
DATABASE_URL
JWT_SECRET
IP_HASH_SECRET
GOOGLE_CLIENT_ID
CAPTCHA_* when enabled
```

Generate two independent values locally and place them in that secret:

```bash
openssl rand -hex 64
openssl rand -hex 64
```

Use the private Lightsail database endpoint:

```text
postgresql://USERNAME:URL_ENCODED_PASSWORD@PRIVATE_DB_ENDPOINT:5432/dbauth?schema=public&sslmode=verify-full&sslrootcert=/app/certs/global-bundle.pem
```

During deployment, GitHub Actions transfers this secret over SSH as `/opt/pixaeron/auth.env` with mode `600`. It is never copied into the Docker image or committed to Git.

## 6. Create the GitHub Actions SSH Key

Do not give GitHub the personal operator key. Generate a dedicated deployment key in PowerShell:

```powershell
ssh-keygen -t ed25519 `
  -f "$HOME\.ssh\pixaeron-github-deploy" `
  -C "github-actions@pixaeron"
```

Authorize its public key on the VPS:

```powershell
Get-Content "$HOME\.ssh\pixaeron-github-deploy.pub" |
  ssh ubuntu@STATIC_IP "umask 077; cat >> ~/.ssh/authorized_keys"
```

Only the public key is installed on the VPS. Keep the private key in the local operator key store and place a copy in the `VPS_SSH_PRIVATE_KEY` GitHub Environment secret; other developers do not need that private key to trigger the workflow.

## 7. SSH Security and the Lightsail Firewall

GitHub-hosted runners use changing public IP addresses. Automatic SSH deployment requires the Lightsail `TCP 22` rule to allow `Any IPv4`.

Disable password and root login before opening the rule:

```bash
sudo tee /etc/ssh/sshd_config.d/99-pixaeron.conf > /dev/null <<'EOF'
PasswordAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
EOF

sudo sshd -t
sudo systemctl reload ssh
```

Keep the current SSH session open until a second terminal successfully connects. With key-only authentication, knowing a password is insufficient to access the server.

If you do not want GitHub runners to reach SSH, keep port 22 restricted to operator addresses and run the final Compose commands manually. That is safer but is no longer automatic CD.

## 8. GitHub Secrets

Create these secrets in `Repository -> Settings -> Environments -> production`:

```text
VPS_HOST
  Lightsail static IPv4.

VPS_USER
  ubuntu

VPS_SSH_PRIVATE_KEY
  Full contents of ~/.ssh/pixaeron-github-deploy.

VPS_KNOWN_HOSTS
  Output of: ssh-keyscan -H STATIC_IP

AUTH_RUNTIME_ENV
  Complete auth runtime environment based on runtime.env.example.
```

`known_hosts` lets SSH verify that the workflow reached the expected server rather than an impersonating host.

## 9. Deployment Workflow

[ci.yml](../.github/workflows/ci.yml) starts after a push to `main`. It reads [deploy-services.json](../.github/deploy-services.json) and uses the Nx project graph:

- a change to `auth` or one of its dependency libraries continues the deployment;
- a change to an independent application or documentation skips the auth deployment;
- a manual `workflow_dispatch` deploys the selected service or all deployable services.

Only affected services are placed in the deployment matrix. Unchanged services do not start deploy jobs and do not repeat `npm ci` or Docker builds.

The VPS validates only the Compose configuration of the service being deployed. A newly added service therefore does not require every other service to be redeployed or to receive its runtime env again.

When `auth` is affected, the workflow:

1. Runs auth lint and tests.
2. Builds `apps/auth/Dockerfile`.
3. Pushes immutable `sha-<commit>` and convenience `latest` tags to GHCR.
4. Copies the next Compose file, service env, and `deploy-service.sh` to the VPS.
5. Pulls the new auth image.
6. Runs `prisma migrate deploy`.
7. Restarts the auth container.
8. Waits for the service health check.
9. On failure, restores the previous Compose file, service env, image tag, and container.

Application rollback cannot reverse a database migration. Production migrations must therefore be backward compatible: add new columns or tables first, deploy compatible code, and remove old schema only in a later release.

The server does not contain the project source code or a separate deployment framework. It only stores the Compose file, environment files, the database certificate, and running containers.

## 10. First Deployment

Review and stage the complete deployment change, including package manifests and the lockfile when dependencies changed. Do not rely on a fixed list of paths because that list becomes stale as services are added:

```bash
git status --short
git diff

# Stage the reviewed files in the IDE or with git add, then verify the result.
git diff --cached --stat
git diff --cached

git commit -m "add auth production deployment"
git push origin main
```

Open `GitHub -> Actions -> CI/CD`. After a successful deployment, inspect the VPS:

```bash
ssh ubuntu@STATIC_IP
cd /opt/pixaeron
docker compose --env-file deployment.env -f docker-compose.production.yaml ps
docker compose --env-file deployment.env -f docker-compose.production.yaml logs --tail=100 auth
```

Before Caddy is installed, access the application through an SSH tunnel:

```bash
ssh -L 3000:127.0.0.1:3000 ubuntu@STATIC_IP
```

```text
http://127.0.0.1:3000/auth/health
http://127.0.0.1:3000/auth
```

## 11. Add Another Microservice

Follow [Adding a new deployable service](./add-deployable-service.md). A new service needs its Dockerfile, one Compose service, one manifest entry, and one service-specific GitHub Environment secret. Do not copy the workflow or deployment script.

## 12. Intentionally Excluded

- Ansible and Terraform.
- Kubernetes and autoscaling.
- A self-hosted GitHub runner.
- A deployment framework beyond the single repository-owned `deploy-service.sh` script.
- Automatic database migration rollback. The deployment rolls the application back, while schema changes follow the backward-compatible expand/contract pattern.

These tools are not mandatory signs of production. Add one only when a concrete problem requires it.

## 13. Official References

- [Ubuntu Docker package](https://packages.ubuntu.com/noble/docker.io)
- [Docker Compose config](https://docs.docker.com/reference/cli/docker/compose/config/)
- [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [GitHub Actions deployments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)
- [Lightsail managed database private mode](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-databases.html)
