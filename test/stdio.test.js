import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

for (const readOnly of [false, true]) test(`installed CLI starts over stdio (readOnly=${readOnly}) without stdout pollution or account access`, {timeout:15000}, async t=>{
  const directory=await mkdtemp(join(tmpdir(),'homepl-stdio-'));
  const client=new Client({name:'clean-install-fixture',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../src/cli.js',import.meta.url)),'serve', ...(readOnly ? ['--read-only'] : [])],env:{...process.env,HOME_MAIL_DATA_DIR:directory},stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk;});
  t.after(async()=>{await client.close();await rm(directory,{recursive:true,force:true});});
  await client.connect(transport);
  const tools=await client.listTools();
  assert.ok(tools.tools.find(tool=>tool.name==='mail_download_attachment'));
  const result=await client.callTool({name:'mail_accounts',arguments:{}});
  assert.deepEqual(JSON.parse(result.content[0].text).accounts,[]);
  assert.equal(JSON.parse(result.content[0].text).access, readOnly ? 'read-only' : 'read-write');
  assert.equal(tools.tools.some(tool => tool.name === 'mail_send_prepared'), !readOnly);
  assert.equal(stderr,'');
});
