/**
 * Utilities for prompting user input securely
 */

import * as readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';

/**
 * Prompt for text input (visible)
 */
export function promptText(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({ input, output });

  return new Promise((resolve) => {
    const prompt = defaultValue ? `${question} (${defaultValue}): ` : `${question}: `;

    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/**
 * Prompt for secret input (hidden)
 */
export function promptSecret(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });

  return new Promise((resolve) => {
    // Disable echo for password input
    const stdin = process.stdin as any;
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }

    let secret = '';
    output.write(`${question}: `);

    input.on('data', function onData(char) {
      const str = char.toString('utf-8');

      switch (str) {
        case '\n':
        case '\r':
        case '\u0004': {
          // Enter key pressed
          if (stdin.isTTY) {
            stdin.setRawMode(false);
          }
          input.removeListener('data', onData);
          output.write('\n');
          rl.close();
          resolve(secret);
          break;
        }
        case '\u0003': {
          // Ctrl+C pressed
          if (stdin.isTTY) {
            stdin.setRawMode(false);
          }
          process.exit(1);
          break;
        }
        case '\u007f': {
          // Backspace pressed
          if (secret.length > 0) {
            secret = secret.slice(0, -1);
            output.write('\b \b');
          }
          break;
        }
        default: {
          // Regular character
          secret += str;
          output.write('*');
          break;
        }
      }
    });
  });
}

/**
 * Prompt for yes/no confirmation
 */
export function promptConfirm(question: string, defaultYes: boolean = false): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  const suffix = defaultYes ? ' (Y/n): ' : ' (y/N): ';

  return new Promise((resolve) => {
    rl.question(question + suffix, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();

      if (normalized === '') {
        resolve(defaultYes);
      } else {
        resolve(normalized === 'y' || normalized === 'yes');
      }
    });
  });
}

/**
 * Prompt with options
 */
export function promptChoice(question: string, choices: string[]): Promise<string> {
  const rl = readline.createInterface({ input, output });

  return new Promise((resolve) => {
    output.write(`${question}\n`);
    choices.forEach((choice, i) => {
      output.write(`  ${i + 1}. ${choice}\n`);
    });

    rl.question('Select (1-' + choices.length + '): ', (answer) => {
      rl.close();
      const num = parseInt(answer.trim(), 10);

      if (num >= 1 && num <= choices.length) {
        resolve(choices[num - 1]);
      } else {
        resolve(choices[0]);
      }
    });
  });
}
