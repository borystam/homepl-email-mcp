import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

for (const readOnly of [false, true]) test(`installed CLI starts over stdio (readOnly=${readOnly}) without stdout pollution or account access`, {timeout:15000}, async t=>{
  const directory=await mkdtemp(join(tmpdir(),'homepl-stdio-'));
  const client=new Client({name:'clean-install-fixture',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/cli.js',import.meta.url)),'serve', ...(readOnly ? ['--read-only'] : [])],env:{...process.env,HOME_MAIL_DATA_DIR:directory},stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk;});
  t.after(async()=>{await client.close();await rm(directory,{recursive:true,force:true});});
  await client.connect(transport);
  const tools=await client.listTools();
  assert.ok(tools.tools.find(tool=>tool.name==='mail_setup'));
  assert.ok(tools.tools.find(tool=>tool.name==='mail_setup_status'));
  assert.ok(tools.tools.find(tool=>tool.name==='mail_download_attachment'));
  const result=await client.callTool({name:'mail_accounts',arguments:{}});
  assert.deepEqual(JSON.parse(result.content[0].text).accounts,[]);
  assert.equal(JSON.parse(result.content[0].text).access, readOnly ? 'read-only' : 'read-write');
  assert.equal(tools.tools.some(tool => tool.name === 'mail_send_prepared'), !readOnly);
  assert.equal(stderr,'');
});

test('stdio EOF closes an active private form without relying on the client to kill Node', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'homepl-stdio-form-'));
  const serverUrl = new URL('../src/server.js', import.meta.url).href;
  const setupUrl = new URL('../src/setup.js', import.meta.url).href;
  const bootstrap = `import { serve } from ${JSON.stringify(serverUrl)};
import { startSetup } from ${JSON.stringify(setupUrl)};
await serve({onboarding:{getIdentity:()=>({platform:process.platform,username:'Fixture',node:process.version,dataDir:process.env.HOME_MAIL_DATA_DIR}),startSetup:()=>startSetup({checkStorage:async()=>{},listAccounts:async()=>[]})}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
    env: { ...process.env, HOME_MAIL_DATA_DIR: directory }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  child.stderr.resume();
  t.after(async () => { if (child.exitCode === null) child.kill(); await closed; await rm(directory, { recursive: true, force: true }); });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
  const request = (id, method, params) => new Promise(resolve => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await request(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'eof-fixture', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const response = await request(2, 'tools/call', { name: 'mail_setup', arguments: {} });
  const form = JSON.parse(response.result.content[0].text);
  assert.equal(form.status, 'pending');
  const page = await fetch(form.url);
  assert.equal(page.status, 200);
  await page.text();
  child.stdin.end();
  assert.deepEqual(await closed, { code: 0, signal: null });
  await assert.rejects(fetch(form.url));
});
