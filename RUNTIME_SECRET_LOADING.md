# Runtime Secret Loading with 1Password

This provisioning tool now supports runtime secret loading via the 1Password SDK. This means your Wasp application loads secrets from 1Password when the server starts, rather than baking them into the Docker image or deployment artifacts at build time.

## Benefits

✅ **Single Source of Truth** - All secrets stored only in 1Password
✅ **No Secrets in CI/CD** - GitHub Actions logs contain no application secrets
✅ **Easy Secret Rotation** - Update in 1Password, restart container (no rebuild needed)
✅ **Fail-Safe** - Server won't start if secrets are missing
✅ **Better Security** - Secrets never written to files or baked into images

## How It Works

### 1. CapRover Configuration
Only 2 environment variables are set in CapRover:

- `OP_SERVICE_ACCOUNT_TOKEN` - 1Password service account token
- `OP_VAULT` - Vault name (e.g., "Production" or "Development")

### 2. Server Startup
When your Wasp server starts, it:
1. Detects `OP_SERVICE_ACCOUNT_TOKEN` is set
2. Connects to 1Password using the SDK
3. Loads all required secrets from the specified vault
4. Sets them as `process.env` variables
5. Starts accepting requests

### 3. CI/CD Pipeline
GitHub Actions only loads secrets needed for deployment:
- CapRover credentials (for deployment)
- Vercel credentials (for frontend)
- DATABASE_URL (for migrations)
- No application runtime secrets!

## Setup Instructions

### Step 1: Copy Server Setup File

Copy the server setup template to your Wasp app:

```bash
cp templates/src/server/serverSetup.ts /path/to/your/wasp/app/src/server/serverSetup.ts
```

### Step 2: Update main.wasp

Add the `setupFn` configuration to your app block in `main.wasp`:

```wasp
app YourApp {
  wasp: {
    version: "^0.18.0"
  },

  title: "Your App",

  server: {
    setupFn: import { initializeSecretsFromOnePassword } from "@src/server/serverSetup"
  },

  // ... rest of your app config
}
```

### Step 3: Add 1Password SDK Dependency

Add to your app's `package.json`:

```json
{
  "dependencies": {
    "@1password/sdk": "^0.1.0",
    // ... other dependencies
  }
}
```

### Step 4: Set CapRover Environment Variables

In CapRover dashboard:

1. Navigate to your app
2. Go to "App Configs" → "Environmental Variables"
3. Add these two variables:
   - `OP_SERVICE_ACCOUNT_TOKEN` = `<your-service-account-token>`
   - `OP_VAULT` = `Production` (or `Development`)

**Note:** This tool automatically configures these when you provision with CapRover and GitHub enabled.

### Step 5: Use Updated Workflow Files

The generated workflow files in `.github/workflows/` are already configured for runtime loading. They:
- Load only CI/CD credentials from 1Password
- Skip loading application secrets
- Deploy the app with minimal environment variables

## 1Password Vault Structure

Your 1Password vault must follow this structure:

```
Production/  (or Development/)
├── Neon/
│   └── Database/
│       └── database_url
├── JWT/
│   └── Secrets/
│       └── jwt_secret
├── Vercel/
│   └── URLs/
│       └── app_url
├── CapRover/
│   ├── Server/
│   │   └── url
│   ├── Deployment/
│   │   └── app_token
│   └── URLs/
│       └── api_url
├── Stripe/
│   └── Credentials/
│       ├── api_key
│       └── webhook_secret
├── Sendgrid/
│   └── Credentials/
│       └── api_key
├── Resend/
│   └── Credentials/
│       └── api_key
├── AWS/
│   ├── Credentials/
│   │   ├── access_key
│   │   └── secret_key
│   └── Configuration/
│       └── files_bucket
├── Google/
│   └── OAuth/
│       ├── client_id
│       └── client_secret
└── Admin/
    ├── emails
    └── allowed_emails
```

**In 1Password UI:**
- Top-level names (Neon, JWT, etc.) = **Items**
- Second-level names (Database, Secrets, etc.) = **Sections** within items
- Third-level names (database_url, jwt_secret, etc.) = **Fields** in sections

This structure is automatically created when you provision infrastructure using this tool.

## Local Development

For local development, you have two options:

### Option 1: Use 1Password CLI (Recommended)

```bash
export OP_SERVICE_ACCOUNT_TOKEN=<your-dev-token>
export OP_VAULT=Development
wasp start
```

The server will automatically load all secrets from 1Password when it starts.

### Option 2: Use .env.server (Fallback)

If `OP_SERVICE_ACCOUNT_TOKEN` is not set, the server skips 1Password loading and uses environment variables from `.env.server`:

```bash
# .env.server
DATABASE_URL=postgresql://...
JWT_SECRET=...
# ... other secrets
```

This is useful for:
- Quick local development
- Environments where 1Password CLI isn't available
- Testing without 1Password access

## Troubleshooting

### Server won't start - "OP_SERVICE_ACCOUNT_TOKEN not set"

Make sure the environment variable is set in CapRover:
1. CapRover Dashboard → Your App → App Configs → Environmental Variables
2. Check that `OP_SERVICE_ACCOUNT_TOKEN` exists and has a valid value

### Server crashes at startup - "Failed to load DATABASE_URL"

This means the 1Password vault structure doesn't match expectations:
1. Check that your vault name matches `OP_VAULT`
2. Verify the item/section/field structure matches the expected format
3. Run `provision-wasp-saas` to ensure vault structure is correct

### Secrets work in development but not production

Development and Production vaults are separate:
- `Development` vault for dev environment
- `Production` vault for prod environment
- Make sure service account has access to the correct vault
- Verify `OP_VAULT` environment variable is set correctly

### How do I rotate a secret?

1. Update the secret in 1Password (in the appropriate vault)
2. Restart your CapRover container
3. No rebuild or redeploy needed!

## Migration from Build-Time Secrets

If you have an existing app that loads secrets at build time:

1. Add `@1password/sdk` to package.json
2. Copy `serverSetup.ts` to your app
3. Update `main.wasp` with `setupFn`
4. Update your GitHub workflows (copy from templates)
5. Update CapRover environment variables (remove all except OP_SERVICE_ACCOUNT_TOKEN and OP_VAULT)
6. Redeploy your app

The server will now load secrets at runtime instead of using baked-in values.

## Security Best Practices

✅ **DO:**
- Use separate service accounts for dev and prod
- Use separate vaults for different environments
- Monitor 1Password access logs
- Rotate service account tokens periodically for security

❌ **DON'T:**
- Set actual application secrets as CapRover environment variables
- Commit service account tokens to git
- Share service account tokens between environments
- Log secret values in your application

## Advanced Configuration

### Custom Secret Mapping

Edit `src/server/serverSetup.ts` to customize which secrets are loaded:

```typescript
const secrets = {
  DATABASE_URL: `op://${vault}/Neon/Database/database_url`,
  JWT_SECRET: `op://${vault}/JWT/Secrets/jwt_secret`,
  // Add your custom secrets here
  CUSTOM_API_KEY: `op://${vault}/CustomService/Credentials/api_key`,
};
```

### Optional Secrets

To make a secret optional (won't fail startup if missing), modify the error handling in `serverSetup.ts`.

### Integration Name

Update the integration name in `serverSetup.ts`:

```typescript
const client = await createClient({
  auth: process.env.OP_SERVICE_ACCOUNT_TOKEN,
  integrationName: 'Your App Name',  // <-- Change this
  integrationVersion: '1.0.0',
});
```

## Support

For issues or questions:
1. Check this documentation
2. Review the `IMPLEMENT_1PASSWORD_RUNTIME_LOADING.md` guide
3. See the reference implementation in `clickup-overwatch` repository
4. Open an issue at https://github.com/your-repo/provision-wasp-saas

---

**Last Updated:** 2025-01-08
**Requires:** Wasp 0.18.0+, @1password/sdk 0.1.0+
