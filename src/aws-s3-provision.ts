/**
 * AWS S3 provisioning (file storage)
 * - Helps user save AWS S3 credentials to 1Password vault
 * - AWS account and S3 bucket must be created manually
 */

import { ensureOpAuth, opEnsureVault, opEnsureItemWithSections, ItemSection } from './op-util.js';
import { ProvisionOptions, AwsS3Result } from './types.js';
import { RollbackAction } from './rollback.js';
import { getAwsS3Credentials } from './credentials.js';
import { promptText, promptSecret } from './prompt-util.js';

/**
 * Provision AWS S3 credentials (bring-your-own mode)
 * AWS account, IAM user, and S3 bucket must be created manually
 */
export async function provisionAwsS3(
  options: ProvisionOptions
): Promise<{ result: AwsS3Result; rollbackActions: RollbackAction[] }> {
  const { projectName, envSuffix, verbose, dryRun } = options;
  const rollbackActions: RollbackAction[] = [];

  const vaultName = `${projectName}-${envSuffix}`.toLowerCase().replace(/[^a-zA-Z0-9_\-]/g, '-');

  if (verbose) {
    console.log(`  AWS S3 provisioning for vault: ${vaultName}`);
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would save AWS S3 credentials to 1Password vault: ${vaultName}`);
    return {
      result: {
        accessKey: 'AKIAIOSFODNN7EXAMPLE',
        secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        bucketName: 'my-app-files-dev',
        region: 'us-east-1'
      },
      rollbackActions
    };
  }

  // Try to get credentials from environment or credentials store
  let credentials = getAwsS3Credentials();

  // If not found, prompt user interactively
  if (!credentials.accessKey) {
    console.log('\n  AWS S3 credentials not found in environment.');
    console.log('  Please create an AWS account at https://aws.amazon.com/');
    console.log('  Then create an IAM user with S3 access from: https://console.aws.amazon.com/iam/');
    console.log('  Create an S3 bucket from: https://s3.console.aws.amazon.com/\n');

    const accessKey = await promptText('  Enter AWS Access Key ID (AKIA...)');
    credentials.accessKey = accessKey;
  }

  if (!credentials.secretKey) {
    const secretKey = await promptSecret('  Enter AWS Secret Access Key');
    credentials.secretKey = secretKey;
  }

  if (!credentials.bucketName) {
    const suggestedBucket = `${projectName}-files-${envSuffix}`.toLowerCase();
    const bucketName = await promptText(`  Enter S3 Bucket Name`, suggestedBucket) || suggestedBucket;
    credentials.bucketName = bucketName;
  }

  if (!credentials.region) {
    const region = await promptText('  Enter AWS Region', 'us-east-1') || 'us-east-1';
    credentials.region = region;
  }

  try {
    // Write to 1Password project vault
    ensureOpAuth();
    opEnsureVault(vaultName);

    // Create AWS item with sections
    const awsSections: ItemSection[] = [
      {
        label: 'Credentials',
        fields: [
          { label: 'access_key', value: credentials.accessKey!, type: 'STRING' },
          { label: 'secret_key', value: credentials.secretKey!, type: 'CONCEALED' }
        ]
      },
      {
        label: 'Configuration',
        fields: [
          { label: 'files_bucket', value: credentials.bucketName!, type: 'STRING' },
          { label: 'region', value: credentials.region!, type: 'STRING' }
        ]
      }
    ];

    opEnsureItemWithSections(vaultName, 'AWS', awsSections, undefined, verbose);

    if (verbose) {
      console.log(`  ✓ Wrote AWS S3 credentials to 1Password vault: ${vaultName}`);
    } else {
      console.log(`  ✓ AWS S3: credentials saved`);
    }

    return {
      result: {
        accessKey: credentials.accessKey!,
        secretKey: credentials.secretKey!,
        bucketName: credentials.bucketName!,
        region: credentials.region!
      },
      rollbackActions
    };
  } catch (e: any) {
    throw new Error(`AWS S3 provisioning failed: ${e?.message || e}`);
  }
}

/**
 * List AWS S3 instances (not applicable - AWS is bring-your-own)
 */
export async function listAwsS3Instances(
  options: { projectName?: string; envSuffix?: 'dev' | 'prod'; filterPattern?: string; verbose?: boolean }
): Promise<Array<{ id: string; name: string; environment?: 'dev' | 'prod' | 'unknown'; metadata?: any }>> {
  // AWS doesn't have "instances" to list - it's a bring-your-own credentials service
  return [];
}

/**
 * Delete AWS S3 instance (not applicable - AWS is bring-your-own)
 */
export async function deleteAwsS3Instance(
  instanceId: string,
  options: { verbose?: boolean }
): Promise<{ id: string; name: string; success: boolean; error?: string }> {
  return {
    id: instanceId,
    name: 'AWS S3',
    success: false,
    error: 'AWS S3 credentials are managed manually and should be removed from 1Password vault directly'
  };
}
