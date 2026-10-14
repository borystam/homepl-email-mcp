import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import hoodiecrow from 'hoodiecrow-imap';
import { SMTPServer } from 'smtp-server';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createContext } from '../src/context.js';
import { makeServer } from '../src/server.js';
import { readTools } from '../src/read-tools.js';
import { writeTools } from '../src/write-tools.js';

const binaryOne = Buffer.from([0,255,1,2,128,13,10,42]);
const binaryTwo = Buffer.from('second attachment\0binary','utf8');
const raw = [
  'Received: from first.example.invalid by second.example.invalid;',
  ' Wed, 01 Jan 2014 00:00:00 +0000',
  'Received: from older.example.invalid by first.example.invalid;',
  ' Wed, 01 Jan 2014 00:00:00 +0000',
  'From: Customer <customer@example.invalid>',
  'To: employee@example.invalid',
  'Reply-To: replies@example.invalid',
  'Message-ID: <old-message@example.invalid>',
  'Date: Wed, 01 Jan 2014 00:00:00 +0000',
  'Subject: Old customer agreement',
  'X-Custom: first', 'X-Custom: second',
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="fixture-boundary"', '',
  '--fixture-boundary', 'Content-Type: text/plain; charset=utf-8', '', 'Delivery agreed in 2014.',
  '--fixture-boundary', 'Content-Type: application/octet-stream; name="same.bin"',
  'Content-Disposition: attachment; filename="same.bin"', 'Content-Transfer-Encoding: base64', '', binaryOne.toString('base64'),
  '--fixture-boundary', 'Content-Type: application/octet-stream; name="same.bin"',
  'Content-Disposition: attachment; filename="same.bin"', 'Content-Transfer-Encoding: base64', '', binaryTwo.toString('base64'),
  '--fixture-boundary--', '',
].join('\r\n');

async function environment(t) {
  const dataDir = await mkdtemp(join(tmpdir(),'homepl-integration-'));
  const messages = [2,9,30,12005].map(uid => ({uid, raw: uid === 2 ? raw : raw.replace('Old customer agreement',`History ${uid}`).replace('<old-message@example.invalid>',`<history-${uid}@example.invalid>`), internaldate:'01-Jan-2014 00:00:00 +0000', flags: uid === 9 ? ['\\Deleted'] : []}));
  const imap = hoodiecrow({
    plugins:['ID','AUTH-PLAIN','SASL-IR','ENABLE','UIDPLUS','MOVE','SPECIAL-USE','NAMESPACE'],
    users:{'employee@example.invalid':{password:'fixture-only'}},
    storage:{INBOX:{uidvalidity:12345,messages},'':{separator:'/',folders:{Sent:{'special-use':'\\Sent'},Drafts:{'special-use':'\\Drafts'},Trash:{'special-use':'\\Trash'},Archive:{messages:[]}}}},
  });
  const received = [];
  const smtp = new SMTPServer({secure:false, disabledCommands:['STARTTLS'], logger:false,
    onAuth(auth,_session,callback){ callback(auth.username === 'employee@example.invalid' && auth.password === 'fixture-only' ? null : new Error('invalid fixture login'), {user:'fixture'}); },
    onData(stream,_session,callback){ const chunks=[];stream.on('data', c=>chunks.push(c));stream.on('end',()=>{received.push(Buffer.concat(chunks));callback();}); },
  });
  await new Promise(resolve=>imap.listen(0,'127.0.0.1',resolve));
  await new Promise(resolve=>smtp.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{ await Promise.all([new Promise(r=>imap.close(r)),new Promise(r=>smtp.close(r))]);await rm(dataDir,{recursive:true,force:true}); });
  const account={id:'work',email:'employee@example.invalid',displayName:'Employee',imap:{host:'fixture.invalid',port:993},smtp:{host:'fixture.invalid',port:465},folders:{sent:'Sent',drafts:'Drafts',trash:'Trash'}};
  const ctx=await createContext({dataDir,getAccount:async id=>{assert.equal(id,'work');return account;},getPassword:async()=> 'fixture-only',
    imapFactory:settings=>new ImapFlow({...settings,host:'127.0.0.1',port:imap.server.address().port,secure:false,doSTARTTLS:false,disableAutoEnable:true}),
    smtpFactory:settings=>nodemailer.createTransport({...settings,host:'127.0.0.1',port:smtp.server.address().port,secure:false,ignoreTLS:true}),
  });
  const tools=[...readTools(ctx),...writeTools(ctx)];
  const call=async(name,args)=>{const tool=tools.find(t=>t.name===name);assert.ok(tool, name);return tool.handler(tool.schema.parse(args));};
  return {ctx,account,call,received,imap};
}

test('real IMAP: full old history, UID gaps, duplicate headers, exact MIME and duplicate-name attachments', {timeout:30000}, async t=>{
  const {call}=await environment(t);
  const folders=await call('mail_folders',{accountId:'work'});
  assert.deepEqual(folders.folders.map(f=>f.path).sort(),['Archive','Drafts','INBOX','Sent','Trash']);
  const page1=await call('mail_list_messages',{accountId:'work',folder:'INBOX',pageSize:2});
  assert.deepEqual(page1.messages.map(m=>m.uid),[12005,30]);
  const page2=await call('mail_list_messages',{accountId:'work',folder:'INBOX',pageSize:2,cursor:page1.nextCursor});
  assert.deepEqual(page2.messages.map(m=>m.uid),[9,2]);
  let cursor=page2.nextCursor;
  while(cursor){ const page=await call('mail_list_messages',{accountId:'work',folder:'INBOX',pageSize:2,cursor});assert.equal(page.messages.length,0);cursor=page.nextCursor; }
  const ref={accountId:'work',folder:'INBOX',uid:2,uidValidity:page1.uidValidity};
  const message=await call('mail_get_message',ref);
  assert.equal(message.uid,2);
  assert.equal(message.internalDate,'2014-01-01T00:00:00.000Z');
  // Header representation is ordered and also includes original header bytes.
  const headerBytes=Buffer.from(message.headers.rawBase64,'base64').toString();
  assert.equal((headerBytes.match(/Received:/g)||[]).length,2);
  assert.equal((headerBytes.match(/X-Custom:/g)||[]).length,2);
  const source=await call('mail_download_raw',ref);
  assert.deepEqual(await readFile(source.file.path),Buffer.from(raw));
  const parts=message.parts.filter(p=>p.filename==='same.bin');
  assert.equal(parts.length,2);
  const one=await call('mail_download_attachment',{...ref,partId:parts[0].partId});
  const two=await call('mail_download_attachment',{...ref,partId:parts[1].partId});
  assert.deepEqual(await readFile(one.file.path),binaryOne);
  assert.deepEqual(await readFile(two.file.path),binaryTwo);
  const found=await call('mail_search_messages',{accountId:'work',folder:'INBOX',query:{headers:{'Message-ID':'<old-message@example.invalid>'}}});
  assert.deepEqual(found.messages.map(m=>m.uid),[2]);
  await assert.rejects(call('mail_get_message',{...ref,uidValidity:'1'}),{code:'UIDVALIDITY_CHANGED'});
});

test('real SMTP/IMAP: exact sent copy, attachment, Bcc envelope, retry protection and isolated expunge', {timeout:30000}, async t=>{
  const {ctx,call,received}=await environment(t);
  await writeFile(join(ctx.uploadDir,'payload.bin'),binaryOne);
  const prepared=await call('mail_prepare',{accountId:'work',to:['customer@example.invalid'],bcc:['hidden@example.invalid'],subject:'Fixture reply',text:'Hello',attachments:[{relativePath:'payload.bin'}]});
  const result=await call('mail_send_prepared',{accountId:'work',operationId:prepared.operationId});
  assert.equal(result.smtpAccepted,true);
  assert.equal(result.sentCopy.saved,true);
  assert.equal(received.length,1);
  const sent=await call('mail_download_raw',{accountId:'work',folder:'Sent',uid:result.sentCopy.uid,uidValidity:result.sentCopy.uidValidity});
  assert.deepEqual(await readFile(sent.file.path),await readFile(prepared.sentEmlPath));
  assert.deepEqual(received[0],await readFile(prepared.emlPath));
  const parsed=await simpleParser(received[0]);
  const sentParsed=await simpleParser(await readFile(sent.file.path));
  assert.equal(parsed.bcc,undefined);
  assert.equal(sentParsed.bcc.value[0].address,'hidden@example.invalid');
  assert.equal(sentParsed.messageId,parsed.messageId);
  assert.equal(sentParsed.date.toISOString(),parsed.date.toISOString());
  assert.equal(sentParsed.text,parsed.text);
  assert.deepEqual(sentParsed.attachments[0].content,binaryOne);
  assert.deepEqual(parsed.attachments[0].content,binaryOne);
  await call('mail_send_prepared',{accountId:'work',operationId:prepared.operationId});
  assert.equal(received.length,1);
  const ref={accountId:'work',folder:'INBOX',uid:2,uidValidity:'12345'};
  await call('mail_delete_permanently',ref);
  const remaining=await call('mail_list_messages',{accountId:'work',folder:'INBOX'});
  assert.deepEqual(remaining.messages.map(m=>m.uid),[12005,30,9]); // UID9 already had Deleted; must survive.
  const draft=await call('mail_save_draft',{accountId:'work',to:['customer@example.invalid'],bcc:['hidden@example.invalid'],subject:'Draft fixture',text:'First version',attachments:[{relativePath:'payload.bin'}]});
  const updated=await call('mail_update_draft',{accountId:'work',folder:draft.folder,uid:draft.uid,uidValidity:draft.uidValidity,text:'Revised version'});
  assert.equal(updated.previousDraftRetained,false);
  const updatedRaw=await call('mail_download_raw',{accountId:'work',folder:updated.folder,uid:updated.uid,uidValidity:updated.uidValidity});
  const updatedParsed=await simpleParser(await readFile(updatedRaw.file.path));
  assert.equal(updatedParsed.bcc.value[0].address,'hidden@example.invalid');
  assert.equal(updatedParsed.text.trim(),'Revised version');
  assert.deepEqual(updatedParsed.attachments[0].content,binaryOne);
  const drafts=await call('mail_list_messages',{accountId:'work',folder:'Drafts'});
  assert.deepEqual(drafts.messages.map(m=>m.uid),[updated.uid]);
});

test('MCP client handshake, tool discovery, schema validation and actual mail call', {timeout:30000}, async t=>{
  const {ctx,account}=await environment(t);
  const server=await makeServer({ctx,listAccounts:async()=>[account]});
  const client=new Client({name:'integration-fixture',version:'1.0.0'});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
  t.after(async()=>{await client.close();await server.close();});
  const listed=await client.listTools();
  assert.ok(listed.tools.some(tool=>tool.name==='mail_download_raw'));
  assert.ok(listed.tools.some(tool=>tool.name==='mail_send_prepared'));
  const accounts=await client.callTool({name:'mail_accounts',arguments:{}});
  assert.equal(JSON.parse(accounts.content[0].text).accounts[0].id,'work');
  assert.ok(!accounts.content[0].text.includes('fixture-only'));
  const result=await client.callTool({name:'mail_list_messages',arguments:{accountId:'work',folder:'INBOX',pageSize:2}});
  assert.ok(!result.isError,JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text).messages.map(m=>m.uid),[12005,30]);
  const invalid=await client.callTool({name:'mail_get_message',arguments:{accountId:'work',folder:'INBOX',uid:2}});
  assert.equal(invalid.isError,true);
});
