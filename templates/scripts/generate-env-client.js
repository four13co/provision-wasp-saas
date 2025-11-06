#!/usr/bin/env node

/**
 * Generate .env.client file from environment variables
 * This populates client-side variables needed by the Wasp frontend
 */

const fs = require('fs');
const path = require('path');

function generateEnvClient() {
  console.log('📝 Generating .env.client file...\n');

  const envLines = ['# Client environment variables'];
  let foundCount = 0;

  // Map server env vars to client env vars
  const mappings = [
    { from: 'API_URL', to: 'REACT_APP_API_URL' },
    { from: 'APP_URL', to: 'REACT_APP_APP_URL' }
  ];

  for (const { from, to } of mappings) {
    const value = process.env[from];
    if (value && value.trim() !== '') {
      envLines.push(`${to}=${value}`);
      foundCount++;
    }
  }

  // Also include any existing REACT_APP_* variables
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('REACT_APP_') && value && value.trim() !== '') {
      // Don't duplicate if we already added it from mappings
      if (!envLines.some(line => line.startsWith(`${key}=`))) {
        envLines.push(`${key}=${value}`);
        foundCount++;
      }
    }
  }

  // Write to .env.client
  const content = envLines.join('\n') + '\n';
  fs.writeFileSync('.env.client', content, 'utf8');

  console.log(`✅ Generated .env.client with ${foundCount} variables`);
  console.log('');
}

generateEnvClient();
