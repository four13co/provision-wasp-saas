/**
 * Parse Wasp .env.*.example files to extract required environment variables
 */

import fs from 'node:fs';
import path from 'node:path';

export interface EnvVar {
  name: string;
  value?: string;
  comment?: string;
}

export interface WaspEnvConfig {
  serverVars: EnvVar[];
  clientVars: EnvVar[];
}

function parseEnvFile(filePath: string): EnvVar[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const vars: EnvVar[] = [];
  let currentComment: string | undefined;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Handle comments
    if (trimmed.startsWith('#')) {
      currentComment = trimmed.substring(1).trim();
      continue;
    }

    // Skip empty lines
    if (!trimmed) {
      currentComment = undefined;
      continue;
    }

    // Parse KEY=value
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) {
      const [, name, value] = match;
      vars.push({
        name,
        value: value || undefined,
        comment: currentComment
      });
      currentComment = undefined;
    }
  }

  return vars;
}

export function parseWaspEnv(projectDir: string): WaspEnvConfig {
  const serverEnvPath = path.join(projectDir, '.env.server.example');
  const clientEnvPath = path.join(projectDir, '.env.client.example');

  const serverVars = parseEnvFile(serverEnvPath);
  const clientVars = parseEnvFile(clientEnvPath);

  return {
    serverVars,
    clientVars
  };
}

/**
 * Get list of required secrets for provisioning
 */
export function getRequiredSecrets(config: WaspEnvConfig): string[] {
  const allVars = [...config.serverVars, ...config.clientVars];
  const secrets = new Set<string>();

  for (const envVar of allVars) {
    // Common patterns for secrets that need to be provisioned
    if (
      envVar.name.includes('DATABASE_URL') ||
      envVar.name.includes('STRIPE') ||
      envVar.name.includes('SENDGRID') ||
      envVar.name.includes('AWS') ||
      envVar.name.includes('GOOGLE') ||
      envVar.name.includes('JWT') ||
      envVar.name.includes('SECRET') ||
      envVar.name.includes('KEY') ||
      envVar.name.includes('TOKEN')
    ) {
      secrets.add(envVar.name);
    }
  }

  return Array.from(secrets).sort();
}
