import { type ServerSetupFn } from 'wasp/server';
import { createClient } from '@1password/sdk';

export const initializeSecretsFromOnePassword: ServerSetupFn = async () => {
  console.log('🔐 Initializing secrets from 1Password...');

  // Check if we should load from 1Password
  if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) {
    console.log('⚠️  OP_SERVICE_ACCOUNT_TOKEN not set - skipping 1Password initialization');
    console.log('   Using environment variables from .env.server or CapRover');
    return;
  }

  if (!process.env.OP_VAULT) {
    console.error('❌ OP_VAULT not set but OP_SERVICE_ACCOUNT_TOKEN is present');
    throw new Error('OP_VAULT environment variable is required when using 1Password');
  }

  const vault = process.env.OP_VAULT;
  console.log(`📦 Loading secrets from 1Password vault: ${vault}`);

  try {
    // Initialize 1Password SDK client
    const client = await createClient({
      auth: process.env.OP_SERVICE_ACCOUNT_TOKEN,
      integrationName: 'Wasp SaaS App',
      integrationVersion: '1.0.0',
    });

    // Define all secrets to load from 1Password
    // Format: { ENV_VAR_NAME: 'op://VaultName/ItemName/FieldName' }
    const secrets = {
      DATABASE_URL: `op://${vault}/Neon/Database/database_url`,
      JWT_SECRET: `op://${vault}/JWT/Secrets/jwt_secret`,
      WASP_WEB_CLIENT_URL: `op://${vault}/Vercel/URLs/app_url`,
      WASP_SERVER_URL: `op://${vault}/CapRover/URLs/api_url`,
      STRIPE_API_KEY: `op://${vault}/Stripe/Credentials/api_key`,
      STRIPE_WEBHOOK_SECRET: `op://${vault}/Stripe/Credentials/webhook_secret`,
      SENDGRID_API_KEY: `op://${vault}/Sendgrid/Credentials/api_key`,
      RESEND_API_KEY: `op://${vault}/Resend/Credentials/api_key`,
      AWS_S3_IAM_ACCESS_KEY: `op://${vault}/AWS/Credentials/access_key`,
      AWS_S3_IAM_SECRET_KEY: `op://${vault}/AWS/Credentials/secret_key`,
      AWS_S3_FILES_BUCKET: `op://${vault}/AWS/Configuration/files_bucket`,
      GOOGLE_CLIENT_ID: `op://${vault}/Google/OAuth/client_id`,
      GOOGLE_CLIENT_SECRET: `op://${vault}/Google/OAuth/client_secret`,
      ADMIN_EMAILS: `op://${vault}/Admin/emails`,
      ALLOWED_EMAILS: `op://${vault}/Admin/allowed_emails`,
    };

    // Load each secret from 1Password
    let loadedCount = 0;
    let failedCount = 0;

    for (const [envKey, opReference] of Object.entries(secrets)) {
      try {
        const value = await client.secrets.resolve(opReference);
        process.env[envKey] = value;
        console.log(`  ✅ Loaded ${envKey}`);
        loadedCount++;
      } catch (error: any) {
        console.error(`  ❌ Failed to load ${envKey}: ${error.message}`);
        failedCount++;
        // Don't throw immediately - try to load all secrets first
      }
    }

    console.log(`\n📊 1Password secret loading complete:`);
    console.log(`   ✅ Successfully loaded: ${loadedCount}`);
    console.log(`   ❌ Failed to load: ${failedCount}`);

    // If any secrets failed to load, fail the startup
    if (failedCount > 0) {
      throw new Error(`Failed to load ${failedCount} secret(s) from 1Password. Check the logs above for details.`);
    }

    console.log('✅ All secrets loaded successfully from 1Password!\n');
  } catch (error: any) {
    console.error('\n❌ Failed to initialize 1Password secrets:', error.message);
    console.error('   Server startup aborted to prevent running with missing secrets.\n');
    throw error;
  }
};
