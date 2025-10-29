# provision-wasp-saas

**Infrastructure provisioning for Wasp/OpenSaaS projects**

Automated setup of 1Password vaults, databases, hosting, and CI/CD for [Wasp](https://wasp.sh) and [OpenSaaS](https://opensaas.sh) applications.

## Quick Start

```bash
# 1. Create your Wasp app
wasp new -t saas my-app
cd my-app

# 2. Provision infrastructure
npx provision-wasp-saas --provision
```

That's it! Your app now has:
- ✅ 1Password vaults (dev + prod) with all secrets
- ✅ Neon database provisioned
- ✅ CapRover backend hosting configured
- ✅ Vercel frontend hosting configured
- ✅ GitHub repository with CI/CD workflows
- ✅ Environment files (.env.server, .env.client)

## What It Does

`provision-wasp-saas` automates the infrastructure setup that would normally take hours:

1. **1Password Vaults** - Creates separate dev/prod vaults with all required secrets
2. **Database** - Provisions Neon PostgreSQL databases
3. **Backend Hosting** - Sets up CapRover deployment for your Wasp server
4. **Frontend Hosting** - Configures Vercel for your Wasp React client
5. **GitHub** - Creates repository with automated CI/CD workflows
6. **Secrets Management** - Generates JWT secrets, stores credentials securely
7. **Environment Files** - Creates `.env.server` and `.env.client` from 1Password

## Prerequisites

Before running `provision-wasp-saas`, you need:

### Required Tools
- [Wasp](https://wasp.sh) - `curl -sSL https://get.wasp-lang.dev/installer.sh | sh`
- [1Password CLI](https://developer.1password.com/docs/cli/) - `brew install --cask 1password-cli`
- [GitHub CLI](https://cli.github.com/) - `brew install gh`
- Git - `brew install git`
- Node.js 22+ - `brew install node@22`

### Authentication
```bash
# Authenticate with 1Password
op signin

# Authenticate with GitHub
gh auth login
```

### Infrastructure Accounts
- **Neon** - [Sign up](https://neon.tech) for serverless Postgres
- **CapRover** - [Deploy](https://caprover.com/) self-hosted PaaS or use existing server
- **Vercel** - [Sign up](https://vercel.com) for frontend hosting
- **1Password** - [Account](https://1password.com) with vault creation permissions

## Usage

### Basic Provisioning

```bash
cd my-wasp-app
npx provision-wasp-saas --provision
```

### Options

```bash
--provision        # Run full infrastructure provisioning
--verbose, -v      # Show detailed output
--dry-run          # Show what would be done without making changes
--help, -h         # Show help message
```

### Verbose Mode

```bash
npx provision-wasp-saas --provision --verbose
```

Shows detailed output for debugging and understanding what's happening.

### Dry Run

```bash
npx provision-wasp-saas --provision --dry-run
```

Preview all actions without making any changes.

## How It Works

### 1. Project Detection

Looks for `main.wasp` or `.wasproot` in the current directory to confirm it's a Wasp project.

### 2. Environment Parsing

Reads `.env.server.example` and `.env.client.example` to understand required secrets:

```bash
# .env.server.example
DATABASE_URL=
JWT_SECRET=
STRIPE_API_KEY=
SENDGRID_API_KEY=
```

### 3. Vault Creation

Creates two 1Password vaults:
- `{project-name}-dev` - Development environment
- `{project-name}-prod` - Production environment

### 4. Secret Generation

Automatically generates:
- `JWT_SECRET` - Cryptographically secure random string
- Webhook secrets (if needed)
- Service account tokens

### 5. Infrastructure Provisioning

**Neon Database:**
```bash
# Creates projects: my-app-dev, my-app-prod
# Stores connection strings in 1Password
```

**CapRover Backend:**
```bash
# Creates apps: my-app-api-dev, my-app-api-prod
# Configures deployment tokens
```

**Vercel Frontend:**
```bash
# Creates projects: my-app-dev, my-app-prod
# Links to Git repository
```

### 6. GitHub Setup

Creates repository with branches:
- `Development` → Deploys to dev environment
- `Production` → Deploys to prod environment

Adds workflows:
- `.github/workflows/deploy-dev.yml`
- `.github/workflows/deploy-prod.yml`

Sets secrets:
- `OP_SERVICE_ACCOUNT_TOKEN` - 1Password access
- Vault names for dev/prod environments

### 7. Environment Files

Generates local `.env.server` and `.env.client` from 1Password for development.

## Project Structure After Provisioning

```
my-wasp-app/
├── main.wasp                    # Wasp configuration
├── .env.server                  # Server secrets (gitignored)
├── .env.client                  # Client variables (gitignored)
├── .env.server.example          # Template (committed)
├── .env.client.example          # Template (committed)
├── .github/
│   └── workflows/
│       ├── deploy-dev.yml       # Dev deployment
│       └── deploy-prod.yml      # Prod deployment
├── src/
│   ├── client/                  # React components
│   └── server/                  # Node.js operations
└── .wasp/                       # Generated code (gitignored)
```

## Deployment Flow

### Development

```bash
# Make changes
git add .
git commit -m "feat: new feature"
git push origin Development

# GitHub Actions automatically:
# 1. Loads secrets from 1Password
# 2. Builds Wasp project
# 3. Deploys backend to CapRover
# 4. Deploys frontend to Vercel
# 5. Runs database migrations
```

### Production

```bash
# Merge to Production branch
gh pr create --base Production --title "Release v1.0"
gh pr merge

# Same automated deployment to prod environment
```

## 1Password Vault Structure

Each environment vault contains:

```
my-app-dev/
├── DATABASE_URL          # Neon connection string
├── JWT_SECRET            # Generated secret
├── STRIPE/
│   ├── STRIPE_API_KEY
│   └── STRIPE_WEBHOOK_SECRET
├── SENDGRID/
│   └── SENDGRID_API_KEY
├── AWS/
│   ├── AWS_S3_IAM_ACCESS_KEY
│   ├── AWS_S3_IAM_SECRET_KEY
│   └── AWS_S3_FILES_BUCKET
├── CAPROVER_URL
├── CAPROVER_APP_TOKEN
└── VERCEL/
    ├── VERCEL_TOKEN
    ├── VERCEL_PROJECT_ID_DEV
    └── VERCEL_ORG_ID
```

## Customization

### Adding Secrets

1. Add to 1Password vault (dev/prod)
2. Update `.env.server.example` or `.env.client.example`
3. Add to workflow files if needed for CI/CD

### Changing Hosting

The tool is opinionated about:
- **Backend**: CapRover (self-hosted)
- **Frontend**: Vercel (managed)
- **Database**: Neon (serverless Postgres)

To use different providers, fork and customize the provisioning modules in `src/`.

## Troubleshooting

### "No Wasp project detected"

Make sure you're in a directory with `main.wasp` file created by `wasp new`.

### "1Password not authenticated"

Run `op signin` to authenticate the CLI.

### "GitHub CLI not authenticated"

Run `gh auth login` and follow the prompts.

### Missing secrets in CI

Check GitHub repository secrets:
```bash
gh secret list
```

Should show:
- `OP_SERVICE_ACCOUNT_TOKEN`
- Vault names are auto-derived from repository name

## Development

### Local Setup

```bash
git clone https://github.com/gregflint/provision-wasp-saas.git
cd provision-wasp-saas
npm install
npm run build
```

### Testing

```bash
# Create test Wasp project
wasp new -t saas test-app
cd test-app

# Run provisioner
../provision-wasp-saas/dist/index.js --provision --dry-run
```

## Architecture

- **Single Package** - No monorepo complexity
- **TypeScript** - Type-safe provisioning
- **Modular** - Each provider in separate file
- **1Password First** - Single source of truth for secrets
- **Git-Centric** - Branch-based environments

## Contributing

Issues and PRs welcome! This tool is designed to be:
- Simple and focused
- Easy to understand
- Minimal dependencies
- Well-documented

## License

MIT

## Credits

Built for the Wasp and OpenSaaS communities. Inspired by the need to automate the tedious parts of SaaS infrastructure setup.

## Related

- [Wasp](https://wasp.sh) - Full-stack framework
- [OpenSaaS](https://opensaas.sh) - Free SaaS template
- [1Password CLI](https://developer.1password.com/docs/cli/) - Secrets management
- [Neon](https://neon.tech) - Serverless Postgres
- [CapRover](https://caprover.com) - Self-hosted PaaS
- [Vercel](https://vercel.com) - Frontend hosting
