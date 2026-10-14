#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { listAccounts, removeAccount, dataDir, configErrorDescriptions } from './config.js';

const command = process.argv[2] ?? 'serve';
const here = fileURLToPath(import.meta.url);

function openBrowser(url) {
  const [program, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(program, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => process.stderr.write('Open the setup URL above in your browser.\n'));
  child.unref();
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  if (command === 'serve') {
    if (process.argv.slice(3).some(arg => arg !== '--read-only')) throw new Error('Unknown serve option.');
    await (await import('./server.js')).serve({ readOnly: process.argv.includes('--read-only') });
  } else if (command === 'setup') {
    const setup = await (await import('./setup.js')).startSetup();
    process.stdout.write(`Open this private local setup page. Enter your mailbox password only there, never in chat.\n${setup.url}\n`);
    if (!process.argv.includes('--no-open')) openBrowser(setup.url);
    const stop = () => setup.close();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const result = await setup.completion;
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.status === 'failed') process.exitCode = 1;
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  } else if (command === 'accounts') {
    process.stdout.write(JSON.stringify(await listAccounts(), null, 2) + '\n');
  } else if (command === 'remove') {
    if (!process.argv[3]) throw new Error('Usage: homepl-email-mcp remove ACCOUNT_ID');
    await removeAccount(process.argv[3]);
    process.stdout.write('Account and stored credential removed. Downloaded files and prepared drafts remain in the local data directory.\n');
  } else if (command === 'config') {
    if (process.argv.slice(3).some(arg => arg !== '--read-only')) throw new Error('Unknown config option.');
    const args = [here, 'serve', ...(process.argv.includes('--read-only') ? ['--read-only'] : [])];
    const env = process.env.HOME_MAIL_DATA_DIR ? { HOME_MAIL_DATA_DIR: resolve(dataDir()) } : undefined;
    process.stdout.write(JSON.stringify({ mcpServers: { 'homepl-email': { command: process.execPath, args, ...(env ? { env } : {}) } } }, null, 2) + '\n');
    process.stdout.write('\nCodex TOML entry (merge into the existing file; do not replace other settings):\n');
    process.stdout.write(`[mcp_servers.homepl-email]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}\ntool_timeout_sec = 180\n`);
    if (env) process.stdout.write(`\n[mcp_servers.homepl-email.env]\nHOME_MAIL_DATA_DIR = ${JSON.stringify(env.HOME_MAIL_DATA_DIR)}\n`);
  } else if (command === 'doctor') {
    const accounts = await listAccounts();
    const report = { node: process.version, platform: process.platform, dataDir: resolve(dataDir()), accounts: accounts.length, connected: false };
    // Loading the native binding tests compatibility without reading credentials.
    await import('@napi-rs/keyring');
    report.credentialBinding = 'loaded';
    if (process.argv.includes('--connect')) {
      const { verifyAccount } = await import('./setup.js');
      const { getPassword } = await import('./config.js');
      for (const account of accounts) await verifyAccount(account, await getPassword(account.id));
      report.connected = accounts.length > 0;
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write('homepl-email-mcp serve [--read-only] | setup [--no-open] | accounts | config [--read-only] | doctor [--connect] | remove ACCOUNT_ID\n');
    if (!['help', '--help', '-h'].includes(command)) process.exitCode = 1;
  }
}

main().catch(error => {
  // Avoid logging a provider/native exception containing secrets or private data.
  const known = configErrorDescriptions[error?.code];
  process.stderr.write(known ? `${error.code}: ${known}\n` : 'The command failed. Check Node.js >=22, the OS credential store, and account setup. Run "node src/cli.js help" for usage.\n');
  process.exitCode = 1;
});
