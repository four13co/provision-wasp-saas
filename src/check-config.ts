/**
 * Configuration checker - validates credentials and shows status
 */

import { execSync } from 'node:child_process';
import { opGetItem, opItemField, opReadRef } from './op-util.js';

interface CredentialStatus {
  name: string;
  found: boolean;
  source?: string; // 'env', 'op-ref', '1password', or error message
  value?: string; // Masked value for display
  optional?: boolean;
}

interface ServiceStatus {
  service: string;
  credentials: CredentialStatus[];
  configured: boolean;
}

/**
 * Check if value is an op:// reference
 */
function isOpReference(value: string): boolean {
  return /^op:\/\//i.test(value);
}

/**
 * Mask sensitive values for display
 */
function maskValue(value: string): string {
  if (value.length <= 8) {
    return '***';
  }
  return value.substring(0, 4) + '...' + value.substring(value.length - 4);
}

/**
 * Check a single credential from environment variables
 */
function checkCredential(
  name: string,
  envVars: string[],
  optional = false
): CredentialStatus {
  // Try environment variables
  for (const envVar of envVars) {
    const value = process.env[envVar];
    if (value) {
      if (isOpReference(value)) {
        // 1Password reference found
        return {
          name,
          found: true,
          source: `1Password reference (${envVar})`,
          value: value,
          optional
        };
      } else {
        // Direct environment variable
        return {
          name,
          found: true,
          source: `Environment variable (${envVar})`,
          value: maskValue(value),
          optional
        };
      }
    }
  }

  return {
    name,
    found: false,
    source: optional ? 'Not set (optional)' : 'Not found',
    optional
  };
}

/**
 * Check 1Password authentication
 */
function checkOpAuth(): { authenticated: boolean; user?: string; error?: string } {
  try {
    const output = execSync('op whoami', { stdio: 'pipe' }).toString().trim();
    return { authenticated: true, user: output };
  } catch {
    return { authenticated: false, error: 'Not authenticated. Run: op signin' };
  }
}

/**
 * Check if 1Password vault exists
 */
function checkVaultExists(vaultName: string): boolean {
  try {
    execSync(`op vault get "${vaultName}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check CapRover credentials
 */
function checkCapRover(): ServiceStatus {
  const credentials = [
    checkCredential('CAPROVER_URL', ['CAPROVER_URL'], false),
    checkCredential('CAPROVER_PASSWORD', ['CAPROVER_PASSWORD'], false)
  ];

  return {
    service: 'CapRover',
    credentials,
    configured: credentials.every(c => c.found)
  };
}

/**
 * Check Neon credentials
 */
function checkNeon(): ServiceStatus {
  const credentials = [
    checkCredential('NEON_API_KEY', ['NEON_API_KEY'], false)
  ];

  return {
    service: 'Neon',
    credentials,
    configured: credentials.every(c => c.found)
  };
}

/**
 * Check Vercel credentials
 */
function checkVercel(): ServiceStatus {
  const credentials = [
    checkCredential('VERCEL_TOKEN', ['VERCEL_TOKEN'], false),
    checkCredential('VERCEL_ORG_ID', ['VERCEL_ORG_ID', 'VERCEL_TEAM_ID'], true)
  ];

  return {
    service: 'Vercel',
    credentials,
    configured: credentials.filter(c => !c.optional).every(c => c.found)
  };
}

/**
 * Check Resend credentials
 */
function checkResend(): ServiceStatus {
  const credentials = [
    checkCredential('RESEND_API_KEY', ['RESEND_API_KEY', 'RESEND_MASTER_KEY'], false)
  ];

  return {
    service: 'Resend',
    credentials,
    configured: credentials.every(c => c.found)
  };
}

/**
 * Main configuration check
 */
export async function checkConfig(verbose: boolean): Promise<void> {
  console.log('');
  console.log('🔍 Configuration Check');
  console.log('='.repeat(50));
  console.log('');

  // Check 1Password authentication
  const opAuth = checkOpAuth();
  if (opAuth.authenticated) {
    console.log(`1Password: ✓ Authenticated as ${opAuth.user}`);
  } else {
    console.log(`1Password: ✗ ${opAuth.error}`);
    console.log('');
    console.log('Please authenticate with 1Password first:');
    console.log('  op signin');
    console.log('');
    return;
  }

  console.log('');
  console.log('Environment Variable Configuration:');
  console.log('');
  console.log('  Option 1 (RECOMMENDED): Use 1Password references');
  console.log('    1. Create .env with op:// references');
  console.log('    2. Run: op run --env-file=".env" -- npx provision-wasp-saas ...');
  console.log('');
  console.log('  Option 2: Export credentials directly');
  console.log('    export CAPROVER_URL="..." && npx provision-wasp-saas ...');
  console.log('');
  console.log('Credential Status:');
  console.log('='.repeat(50));

  // Check each service
  const services = [
    checkCapRover(),
    checkNeon(),
    checkVercel(),
    checkResend()
  ];

  for (const service of services) {
    console.log('');
    console.log(`${service.service}:`);

    for (const cred of service.credentials) {
      const status = cred.found ? '✓' : (cred.optional ? 'ℹ' : '✗');
      const valueStr = cred.value ? ` = ${cred.value}` : '';
      console.log(`  ${status} ${cred.name} - ${cred.source}${valueStr}`);
    }

    if (!service.configured) {
      console.log('');
      console.log('  How to configure:');
      console.log('');
      console.log('  Option 1: 1Password references (in .env, then use op run)');
      for (const cred of service.credentials.filter(c => !c.found && !c.optional)) {
        console.log(`    ${cred.name}="op://your-vault/${service.service}/${cred.name.toLowerCase()}"`);
      }
      console.log('');
      console.log('  Option 2: Shell exports');
      for (const cred of service.credentials.filter(c => !c.found && !c.optional)) {
        console.log(`    export ${cred.name}="your-value-here"`);
      }
    }
  }

  // Summary
  console.log('');
  console.log('='.repeat(50));
  console.log('Summary:');
  console.log('');

  const configuredCount = services.filter(s => s.configured).length;
  const totalCount = services.length;

  if (configuredCount === totalCount) {
    console.log(`✓ All ${totalCount} services configured`);
  } else {
    console.log(`✓ ${configuredCount} services configured`);
    console.log(`✗ ${totalCount - configuredCount} services missing credentials`);
    console.log('');
    console.log('Missing: ' + services.filter(s => !s.configured).map(s => s.service).join(', '));
  }

  console.log('');
}
