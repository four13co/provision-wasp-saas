#!/usr/bin/env node

/**
 * Generate .env.server file from environment variables
 * This ensures all loaded server-side variables are written to the env file
 */

const fs = require('fs');
const path = require('path');

// Server-side environment variables (matches pickServerEnv in env-emit.ts)
const SERVER_ENV_KEYS = [
  'DATABASE_URL',
  'JWT_SECRET',
  // Stripe/Payments
  'STRIPE_API_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_CUSTOMER_PORTAL_URL',
  'PAYMENTS_HOBBY_SUBSCRIPTION_PLAN_ID',
  'PAYMENTS_PRO_SUBSCRIPTION_PLAN_ID',
  // Email
  'SENDGRID_API_KEY',
  'RESEND_API_KEY',
  // Social Auth
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  // Storage
  'AWS_S3_IAM_ACCESS_KEY',
  'AWS_S3_IAM_SECRET_KEY',
  'AWS_S3_FILES_BUCKET',
  // Admin
  'ADMIN_EMAILS',
  // Deployment
  'CAPROVER_URL',
  'CAPROVER_APP_TOKEN',
  'VERCEL_TOKEN',
  'VERCEL_PROJECT_ID',
  'VERCEL_ORG_ID',
  'API_URL',
  'APP_URL'
];

function generateEnvServer() {
  console.log('📝 Generating .env.server file...\n');

  const envLines = [];
  let foundCount = 0;
  let missingCount = 0;

  for (const key of SERVER_ENV_KEYS) {
    const value = process.env[key];
    // Skip if empty or placeholder value
    if (value && value.trim() !== '' && !value.startsWith('PLACEHOLDER_')) {
      envLines.push(`${key}=${value}`);
      foundCount++;
    } else {
      // Log missing optional vars for debugging, but don't fail
      missingCount++;
    }
  }

  // Write to .env.server
  const content = envLines.join('\n') + '\n';
  fs.writeFileSync('.env.server', content, 'utf8');

  console.log(`✅ Generated .env.server with ${foundCount} variables`);
  if (missingCount > 0) {
    console.log(`   (${missingCount} optional variables were not set)`);
  }
  console.log('');
}

generateEnvServer();
