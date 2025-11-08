/**
 * Configuration management for provision-wasp-saas
 * Stores master vault name and other tool settings
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ToolConfig {
  masterVault?: string;
  version?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.config', 'provision-wasp-saas');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Read the tool configuration
 */
export function readConfig(): ToolConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return {};
    }
    const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (e) {
    return {};
  }
}

/**
 * Write the tool configuration
 */
export function writeConfig(config: ToolConfig): void {
  try {
    // Ensure config directory exists
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }

    // Write config file
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e: any) {
    throw new Error(`Failed to write config: ${e?.message || e}`);
  }
}

/**
 * Get the master vault name from config
 * Returns null if not configured
 */
export function getMasterVault(): string | null {
  const config = readConfig();
  return config.masterVault || null;
}

/**
 * Set the master vault name in config
 */
export function setMasterVault(vaultName: string): void {
  const config = readConfig();
  config.masterVault = vaultName;
  writeConfig(config);
}

/**
 * Check if the tool has been initialized
 */
export function isInitialized(): boolean {
  const config = readConfig();
  return !!config.masterVault;
}

/**
 * Get the config file path for display in messages
 */
export function getConfigPath(): string {
  return CONFIG_FILE;
}
