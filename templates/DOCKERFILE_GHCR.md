# Using GitHub Container Registry (GHCR) with CapRover

This guide explains how to authenticate with GitHub Container Registry (GHCR) in your Dockerfile when deploying to CapRover.

## Available Environment Variables

When you provision your CapRover app with GitHub integration (`--include-github`), the following environment variables are automatically set in CapRover:

- `GITHUB_PAT` - GitHub Personal Access Token (from `gh auth token`)
- `GITHUB_USERNAME` - GitHub username (from `gh api user -q .login`)
- `OP_SERVICE_ACCOUNT_TOKEN` - 1Password service account token
- `OP_VAULT` - 1Password vault name

These variables are available during the Docker build process when CapRover builds your image.

## Use Cases

### Pull Private Docker Base Images from GHCR

If your Dockerfile uses a private base image hosted on GitHub Container Registry:

```dockerfile
ARG GITHUB_PAT
ARG GITHUB_USERNAME

# Login to GHCR before pulling private base image
RUN echo "$GITHUB_PAT" | docker login ghcr.io -u "$GITHUB_USERNAME" --password-stdin

# Now can pull your private base image
FROM ghcr.io/your-org/your-private-node:20

# Rest of your Dockerfile
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["npm", "start"]
```

### Pull Private npm Packages from GitHub Packages

If you need to install private npm packages from GitHub Packages during build:

```dockerfile
FROM node:20-alpine

ARG GITHUB_PAT
ARG GITHUB_USERNAME

WORKDIR /app

# Configure npm to authenticate with GitHub Packages
RUN echo "//npm.pkg.github.com/:_authToken=${GITHUB_PAT}" > .npmrc && \
    echo "@your-org:registry=https://npm.pkg.github.com" >> .npmrc

# Copy package files
COPY package*.json ./

# Install dependencies (including private packages)
RUN npm ci

# Clean up .npmrc to avoid committing credentials
RUN rm -f .npmrc

# Copy application code
COPY . .

CMD ["npm", "start"]
```

## Example: Wasp Application with Private GHCR Base Image

For a Wasp application deployed to CapRover:

```dockerfile
ARG GITHUB_PAT
ARG GITHUB_USERNAME

# Login to GHCR
RUN echo "$GITHUB_PAT" | docker login ghcr.io -u "$GITHUB_USERNAME" --password-stdin

# Use your custom private Node.js base image
FROM ghcr.io/your-org/wasp-base:node20

WORKDIR /app

# Copy the pre-built Wasp server
COPY . .

# Install production dependencies
RUN npm ci --only=production

# Cleanup credentials
RUN docker logout ghcr.io

EXPOSE 3001

CMD ["npm", "start"]
```

## Security Notes

### Environment Variables During Build

⚠️ **Important**: Build-time ARGs and environment variables can be visible in:
- Build logs (CapRover may mask them)
- Docker image layers (if not properly cleaned up)

### Best Practices

✅ **DO:**
- Use ARGs to pass credentials to specific RUN commands
- Logout from registries after authentication (`docker logout ghcr.io`)
- Remove `.npmrc` or credential files after use
- Use multi-stage builds to avoid credentials in final image

❌ **DON'T:**
- Store credentials in environment variables in the final image
- Commit `.npmrc` or credential files to git
- Use credentials in the final CMD or ENTRYPOINT

### Multi-Stage Build Example

For better security, use multi-stage builds:

```dockerfile
# Build stage
FROM node:20-alpine AS builder

ARG GITHUB_PAT
ARG GITHUB_USERNAME

WORKDIR /app

# Authenticate with GHCR for private packages
RUN echo "//npm.pkg.github.com/:_authToken=${GITHUB_PAT}" > .npmrc

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production stage (credentials not present)
FROM node:20-alpine

WORKDIR /app

# Copy only built assets and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

EXPOSE 3001
CMD ["npm", "start"]
```

## Troubleshooting

### "authentication required" Error

If you see Docker authentication errors during build:

1. **Verify credentials are set in CapRover**:
   - Go to CapRover Dashboard → Your App → App Configs → Environmental Variables
   - Check that `GITHUB_PAT` and `GITHUB_USERNAME` are present

2. **Verify Dockerfile uses ARGs correctly**:
   ```dockerfile
   ARG GITHUB_PAT
   ARG GITHUB_USERNAME
   ```

3. **Check PAT permissions**:
   - Go to GitHub → Settings → Developer settings → Personal access tokens
   - Ensure token has `read:packages` scope for pulling images/packages

### "manifest unknown" Error

If GHCR returns "manifest unknown":

1. **Verify image exists**: `docker pull ghcr.io/your-org/your-image:tag`
2. **Check image visibility**: Ensure image is public or PAT has access
3. **Verify org name**: Use exact organization/username from GitHub

### Environment Variables Not Available

If `GITHUB_PAT` or `GITHUB_USERNAME` are not set:

1. **Re-run provisioning with GitHub integration**:
   ```bash
   provision-wasp-saas --provision-caprover --include-github --env prod
   ```

2. **Manually verify GitHub item in 1Password**:
   ```bash
   op item get GitHub --vault your-project-prod
   ```

3. **Check CapRover logs**:
   - CapRover Dashboard → Your App → Logs
   - Look for "Including GitHub credentials for GHCR authentication"

## Alternative: Server-Level Docker Configuration

For a more secure and simpler approach, you can configure the CapRover server's Docker daemon once:

```bash
# SSH to CapRover server
ssh root@your-caprover-server

# Login to GHCR (credentials stored in Docker's auth store)
echo "YOUR_GITHUB_PAT" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin

# Now all Docker builds can access GHCR
docker pull ghcr.io/your-org/your-private-image:latest
```

**Pros:**
- ✅ More secure (credentials in Docker's encrypted store)
- ✅ Simpler Dockerfiles (no authentication code needed)
- ✅ Works for all apps on the server
- ✅ One-time setup

**Cons:**
- ❌ Requires manual server access
- ❌ Not automated by provisioning tool
- ❌ Needs re-configuration if server is rebuilt

## See Also

- [CapRover Documentation](https://caprover.com/docs/)
- [GitHub Container Registry Docs](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [Docker Multi-Stage Builds](https://docs.docker.com/build/building/multi-stage/)
- [RUNTIME_SECRET_LOADING.md](../RUNTIME_SECRET_LOADING.md) - Runtime secret loading with 1Password

---

**Last Updated:** 2025-01-08
**Applies to:** CapRover deployments with private GHCR images
