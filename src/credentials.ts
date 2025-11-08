/**
 * Credential management - reads from master vault or environment variables
 */

import { getMasterVault } from './config.js';
import { opReadField } from './op-util.js';

/**
 * Get a credential value, trying master vault first, then environment variable
 * Supports both new structured format (with sections) and legacy flat format
 */
function getCredential(
  itemName: string,
  sectionLabel: string,
  fieldLabel: string,
  envVarName?: string,
  altFieldNames?: string[]
): string | null {
  // Try master vault first
  const vaultName = getMasterVault();
  if (vaultName) {
    // Try structured format (section.field)
    try {
      const value = opReadField(vaultName, itemName, sectionLabel, fieldLabel);
      if (value) {
        return value;
      }
    } catch (e) {
      // Ignore and try alternative formats
    }

    // Try flat format with uppercase field names (legacy support)
    const legacyFieldNames = [
      fieldLabel.toUpperCase(),
      ...(altFieldNames || [])
    ];

    for (const legacyName of legacyFieldNames) {
      try {
        const value = opReadField(vaultName, itemName.toUpperCase(), '', legacyName);
        if (value) {
          return value;
        }
      } catch (e) {
        // Continue trying
      }
    }
  }

  // Fall back to environment variable
  if (envVarName && process.env[envVarName]) {
    return process.env[envVarName] || null;
  }

  return null;
}

/**
 * Get Neon credentials
 */
export function getNeonCredentials(): {
  apiKey: string | null;
  orgId: string | null;
  region: string | null;
} {
  return {
    apiKey: getCredential('Neon', 'Credentials', 'api_key', 'NEON_API_KEY', ['API_KEY', 'credential']),
    orgId: getCredential('Neon', 'Credentials', 'org_id', 'NEON_ORG_ID', ['ORG_ID']),
    region: getCredential('Neon', 'Configuration', 'region', 'NEON_REGION', ['REGION'])
  };
}

/**
 * Get Vercel credentials
 */
export function getVercelCredentials(): {
  token: string | null;
  teamId: string | null;
} {
  return {
    token: getCredential('Vercel', 'Credentials', 'token', 'VERCEL_TOKEN', ['VERCEL_TOKEN', 'credential']),
    teamId:
      getCredential('Vercel', 'Credentials', 'team_id', 'VERCEL_TEAM_ID', ['ORG_ID', 'TEAM_ID']) ||
      getCredential('Vercel', 'Credentials', 'team_id', 'VERCEL_ORG_ID', ['ORG_ID', 'TEAM_ID'])
  };
}

/**
 * Get Netlify credentials
 */
export function getNetlifyCredentials(): {
  token: string | null;
  teamSlug: string | null;
  teamId: string | null;
} {
  return {
    token: getCredential('Netlify', 'Credentials', 'token', 'NETLIFY_TOKEN'),
    teamSlug: getCredential('Netlify', 'Team', 'team_slug', 'NETLIFY_TEAM_SLUG'),
    teamId: getCredential('Netlify', 'Team', 'team_id', 'NETLIFY_TEAM_ID')
  };
}

/**
 * Get CapRover credentials
 */
export function getCapRoverCredentials(): {
  url: string | null;
  password: string | null;
} {
  return {
    url: getCredential('CapRover', 'Server', 'url', 'CAPROVER_URL', ['URL']),
    password: getCredential('CapRover', 'Server', 'password', 'CAPROVER_PASSWORD', ['PASSWORD', 'credential'])
  };
}

/**
 * Get Resend credentials
 */
export function getResendCredentials(): {
  apiKey: string | null;
  smtpServer: string | null;
  smtpPort: string | null;
  smtpUsername: string | null;
} {
  return {
    apiKey:
      getCredential('Resend', 'Credentials', 'api_key', 'RESEND_API_KEY', ['API_KEY', 'credential']) ||
      getCredential('Resend', 'Credentials', 'api_key', 'RESEND_MASTER_KEY', ['MASTER_KEY', 'credential']),
    smtpServer: getCredential('Resend', 'SMTP', 'smtp_server', 'RESEND_SMTP_SERVER', ['smtp_server']),
    smtpPort: getCredential('Resend', 'SMTP', 'smtp_port', 'RESEND_SMTP_PORT', ['smtp_port']),
    smtpUsername: getCredential('Resend', 'SMTP', 'username', 'RESEND_SMTP_USERNAME', ['username'])
  };
}

/**
 * Get Stripe credentials
 */
export function getStripeCredentials(): {
  apiKey: string | null;
  webhookSecret: string | null;
  customerPortalUrl: string | null;
  hobbyPlanId: string | null;
  proPlanId: string | null;
} {
  return {
    apiKey: getCredential('Stripe', 'Credentials', 'api_key', 'STRIPE_API_KEY', ['API_KEY', 'credential']),
    webhookSecret: getCredential('Stripe', 'Credentials', 'webhook_secret', 'STRIPE_WEBHOOK_SECRET', ['WEBHOOK_SECRET']),
    customerPortalUrl: getCredential('Stripe', 'URLs', 'customer_portal_url', 'STRIPE_CUSTOMER_PORTAL_URL', ['CUSTOMER_PORTAL_URL']),
    hobbyPlanId: getCredential('Stripe', 'Plans', 'hobby_subscription_plan_id', 'PAYMENTS_HOBBY_SUBSCRIPTION_PLAN_ID', ['HOBBY_PLAN_ID']),
    proPlanId: getCredential('Stripe', 'Plans', 'pro_subscription_plan_id', 'PAYMENTS_PRO_SUBSCRIPTION_PLAN_ID', ['PRO_PLAN_ID'])
  };
}

/**
 * Get SendGrid credentials
 */
export function getSendGridCredentials(): {
  apiKey: string | null;
} {
  return {
    apiKey: getCredential('Sendgrid', 'Credentials', 'api_key', 'SENDGRID_API_KEY', ['API_KEY', 'credential'])
  };
}

/**
 * Get AWS S3 credentials
 */
export function getAwsS3Credentials(): {
  accessKey: string | null;
  secretKey: string | null;
  bucketName: string | null;
  region: string | null;
} {
  return {
    accessKey: getCredential('AWS', 'Credentials', 'access_key', 'AWS_S3_IAM_ACCESS_KEY', ['ACCESS_KEY']),
    secretKey: getCredential('AWS', 'Credentials', 'secret_key', 'AWS_S3_IAM_SECRET_KEY', ['SECRET_KEY']),
    bucketName: getCredential('AWS', 'Configuration', 'files_bucket', 'AWS_S3_FILES_BUCKET', ['BUCKET']),
    region: getCredential('AWS', 'Configuration', 'region', 'AWS_REGION', ['REGION']) || 'us-east-1'
  };
}

/**
 * Get Google OAuth credentials
 */
export function getGoogleOAuthCredentials(): {
  clientId: string | null;
  clientSecret: string | null;
} {
  return {
    clientId: getCredential('Google', 'OAuth', 'client_id', 'GOOGLE_CLIENT_ID', ['CLIENT_ID']),
    clientSecret: getCredential('Google', 'OAuth', 'client_secret', 'GOOGLE_CLIENT_SECRET', ['CLIENT_SECRET'])
  };
}

/**
 * Check if tool has been initialized with credentials
 */
export function hasCredentials(provider: 'neon' | 'vercel' | 'netlify' | 'caprover' | 'resend'): boolean {
  switch (provider) {
    case 'neon':
      return !!getNeonCredentials().apiKey;
    case 'vercel':
      return !!getVercelCredentials().token;
    case 'netlify':
      return !!getNetlifyCredentials().token;
    case 'caprover':
      return !!(getCapRoverCredentials().url && getCapRoverCredentials().password);
    case 'resend':
      return !!getResendCredentials().apiKey;
    default:
      return false;
  }
}

/**
 * Get helpful error message when credentials are missing
 */
export function getMissingCredentialsMessage(provider: string): string {
  return `${provider} credentials not found.

Run initialization to set up credentials:
  provision-wasp-saas init

Or set environment variables:
  export ${provider.toUpperCase()}_API_KEY=your-key

Or use 1Password references with op run:
  op run --env-file=".env" -- provision-wasp-saas ...`;
}
