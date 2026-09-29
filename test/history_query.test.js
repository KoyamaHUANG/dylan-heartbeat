const test = require('node:test');
const assert = require('node:assert/strict');
const Fastify = require('fastify');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {Pool} = require('pg');
const {parseHistoryQuery,unionSql,listHistory,registerHistoryRoutes,sign} = require('../archive/history_query');

const secret = 'synthetic-history-query-secret';
const parse = raw=>parseHistoryQuery(raw,{timeZone:'Asia/Shanghai',secret});
const binding = {assistant_id:'ayan',conversation_id:'conversation-A'};
const timestamp = '2026-08-20T03:12:08.000123Z';

test('date, offset range, literal keyword, both identities and canonical revision selection shape the same SQL',()=>{
  const dated=parse({...binding,date:'2026-08-20',keyword:'100%_literal'});
  assert.equal(dated.start,'2026-08-19T16:00:00.000Z');
  assert.equal(dated.end,'2026-08-20T16:00:00.000Z');
  const {sql,args}=unionSql(dated,timestamp);
  assert.match(sql,/m\.assistant_id=\$\d+/);
  assert.match(sql,/h\.assistant_id=\$\d+/);
  assert.match(sql,/m\.conversation_id=\$\d+/);
  assert.match(sql,/h\.conversation_id=\$\d+/);
  assert.match(sql,/strpos\(lower\(m\.content_text\),lower\(\$\d+::text\)\) > 0/);
  assert.match(sql,/strpos\(lower\(h\.content_text\),lower\(\$\d+::text\)\) > 0/);
  assert.match(sql,/h\.current_selected=TRUE AND h\.revision_status='resolved'/);
  assert.equal(args.filter(value=>value==='100%_literal').length,2);
  assert.throws(()=>parse({conversation_id:'conversation-A',keyword:'100%_literal'}));
  assert.equal(parse({...binding,start:'2026-08-20T00:00:00+08:00',end:'2026-08-21T00:00:00+08:00'}).start,
    '2026-08-19T16:00:00.000000Z');
});

test('exact original ID finds an old revision without matching a different conversation or live row',()=>{
  const q=parse({...binding,original_message_id:'source-old-revision'});
  assert.equal(q.include_revisions,true);
  const {sql,args}=unionSql(q,timestamp);
  assert.match(sql,/h\.original_message_id=\$\d+/);
  assert.match(sql,/FROM archive_messages m WHERE [\s\S]*FALSE/);
  assert.doesNotMatch(sql,/h\.current_selected=TRUE/);
  assert.ok(args.includes('source-old-revision'));
  assert.throws(()=>parse({assistant_id:'ayan',original_message_id:'source-old-revision'}));
  assert.throws(()=>parse({conversation_id:'conversation-A',original_message_id:123}));
});

test('canonical history excludes old revisions and proven live duplicates; opt-in revisions retain versions',()=>{
  const canonical=unionSql(parse({...binding,date:'2026-08-20'}),timestamp).sql;
  const revisions=unionSql(parse({...binding,date:'2026-08-20',include_revisions:'true'}),timestamp).sql;
  assert.match(canonical,/h\.current_selected=TRUE AND h\.revision_status='resolved'/);
  assert.match(canonical,/NOT EXISTS \(SELECT 1 FROM archive_messages l/);
  assert.doesNotMatch(revisions,/h\.current_selected=TRUE/);
  assert.match(revisions,/h\.dedupe_status='distinct'/);
});

test('signed cursor rejects changes to keyword, original ID, assistant or conversation scope',()=>{
  const q=parse({...binding,keyword:'coffee'});
  const cursor=sign({v:1,scope:q.scope,time:timestamp,key:'h:conversation-A:1:id',watermark:timestamp},secret);
  assert.ok(parse({...binding,keyword:'coffee',cursor}).cursor);
  assert.throws(()=>parse({...binding,keyword:'tea',cursor}));
  assert.throws(()=>parse({...binding,original_message_id:'source-1',cursor}));
  assert.throws(()=>parse({...binding,assistant_id:'other',keyword:'coffee',cursor}));
  assert.throws(()=>parse({...binding,conversation_id:'other',keyword:'coffee',cursor}));
});

test('read-only mock client returns stable total and a signed second page',async()=>{
  const statements=[];
  const rows=[
    {storage:'history',id:'history-1',original_message_id:'source-1',assistant_id:'ayan',conversation_id:'conversation-A',
      role:'user',content_text:'synthetic one',message_time:timestamp,sort_key:'h:conversation-A:1:history-1'},
    {storage:'history',id:'history-2',original_message_id:'source-2',assistant_id:'ayan',conversation_id:'conversation-A',
      role:'assistant',content_text:'synthetic two',message_time:timestamp,sort_key:'h:conversation-A:2:history-2'}
  ];
  let released=0;
  const pool={connect:async()=>({
    query:async(sql,args=[])=>{
      statements.push(sql);
      if(sql.includes(' AS watermark'))return {rows:[{watermark:'2026-09-27T00:00:00.000000Z'}]};
      if(sql.startsWith('SELECT COUNT'))return {rows:[{total:'2'}]};
      if(sql.startsWith('SELECT storage'))return {rows:sql.includes('all_messages WHERE (message_time >')?[rows[1]]:rows};
      return {rows:[]};
    },release:()=>{released++;}
  })};
  const first=await listHistory(pool,parse({...binding,date:'2026-08-20',limit:1}),secret);
  assert.equal(first.total,2);
  assert.equal(first.messages.length,1);
  assert.equal(first.messages[0].original_message_id,'source-1');
  assert.ok(first.next_cursor);
  const second=await listHistory(pool,parse({...binding,date:'2026-08-20',limit:1,cursor:first.next_cursor}),secret);
  assert.equal(second.total,2);
  assert.equal(second.messages[0].id,'history-2');
  assert.equal(second.next_cursor,null);
  assert.equal(released,2);
  assert.equal(statements.filter(sql=>sql==='BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY').length,2);
  assert.equal(statements.filter(sql=>sql==='ROLLBACK').length,2);
});

test('authenticated exact-ID HTTP lookup reports unavailable on an empty result',async()=>{
  const pool={connect:async()=>({query:async sql=>{
    if(sql.includes(' AS watermark'))return {rows:[{watermark:'2026-09-27T00:00:00.000000Z'}]};
    if(sql.startsWith('SELECT COUNT'))return {rows:[{total:'0'}]};
    return {rows:[]};
  },release:()=>{}})};
  const app=Fastify();
  registerHistoryRoutes(app,{pool,timeZone:'Asia/Shanghai',archiveApiKey:secret,requireBothForHttp:true});
  try{
    const unscoped=await app.inject({url:'/v1/archive/history?conversation_id=conversation-A&date=2026-08-20',
      headers:{authorization:'Bearer '+secret}});
    assert.equal(unscoped.statusCode,400);
    const response=await app.inject({url:'/v1/archive/history?assistant_id=ayan&conversation_id=conversation-A&original_message_id=missing',
      headers:{authorization:'Bearer '+secret}});
    assert.equal(response.statusCode,200);
    assert.equal(response.json().total,0);
    assert.equal(response.json().lookup_status,'unavailable');
    assert.deepEqual(response.json().messages,[]);
  }finally{await app.close();}
});

test('isolated PostgreSQL executes history filters, counts, revisions and dual identity scope',
  {skip:!process.env.KELIVO_V11_TEST_ADMIN_URL},async()=>{
  const adminUrl=new URL(process.env.KELIVO_V11_TEST_ADMIN_URL);
  assert.ok(['127.0.0.1','[::1]'].includes(adminUrl.hostname),'isolated loopback server required');
  const database='ayan_history_query_'+crypto.randomBytes(6).toString('hex');
  const admin=new Pool({connectionString:adminUrl.toString()});
  let pool;
  try {
    await admin.query('CREATE DATABASE '+database);
    adminUrl.pathname='/'+database;
    pool=new Pool({connectionString:adminUrl.toString(),max:2});
    for(const name of ['001_initial.sql','002_kelivo_archive_identity.sql','003_history_backfill.sql','004_history_dedupe_audit.sql']){
      await pool.query(fs.readFileSync(path.join(__dirname,'../migrations',name),'utf8'));
      await pool.query('INSERT INTO archive_schema_migrations(migration_name) VALUES($1)',[name]);
    }
    const add=async({id,assistant='ayan',conversation='conversation-A',content,time='2026-08-20T03:12:08.000123Z',
      order=0,group=id,index=0,selected=true,status='resolved',dedupe='distinct'})=>{
      await pool.query(`INSERT INTO archive_history_messages
        (history_id,assistant_id,conversation_id,role,content_text,content_json,content_fingerprint,
         history_fingerprint,message_time,original_message_id,original_conversation_id,original_order,
         source,import_batch_id,source_backup_sha256,revision_group,revision_index,revision_order,
         current_selected,revision_status,dedupe_status)
        VALUES($1,$2,$3,'user',$4,$5::jsonb,$6,$7,$8,$9,$3,$10,
               'kelivo_history_import','synthetic-acceptance',$11,$12,$13,$10,$14,$15,$16)`,
        [crypto.randomUUID(),assistant,conversation,content,JSON.stringify(content),crypto.randomBytes(32).toString('hex'),
          crypto.randomBytes(32).toString('hex'),time,id,order,'0'.repeat(64),group,index,selected,status,dedupe]);
    };
    await add({id:'old-v0',content:'蓝色旧稿',group:'revision-one',selected:false});
    await add({id:'new-v1',content:'蓝色终稿',group:'revision-one',index:1,order:1});
    await add({id:'another',content:'蓝色补充',order:2,time:'2026-08-20T03:12:09.000124Z'});
    await add({id:'third',content:'绿色记录',order:3,time:'2026-08-20T03:12:10.000125Z'});
    await add({id:'other-conversation',conversation:'conversation-B',content:'蓝色隔离',order:4});
    await add({id:'other-assistant',assistant:'other',content:'蓝色隔离',order:5});
    await add({id:'next-day',content:'蓝色隔日',time:'2026-08-21T03:12:08Z',order:6});
    await add({id:'duplicate',content:'蓝色待审重复',dedupe:'unresolved_duplicate',order:7});
    await add({id:'unresolved',content:'蓝色未选修订',status:'unresolved_revision',selected:null,order:8});
    const list=raw=>listHistory(pool,parse({...binding,...raw}),secret);
    const first=await list({date:'2026-08-20',limit:1});
    assert.equal(first.total,3);
    assert.equal(first.messages.length,1);
    assert.ok(first.next_cursor);
    const second=await list({date:'2026-08-20',limit:1,cursor:first.next_cursor});
    assert.equal(second.total,3);
    assert.notEqual(second.messages[0].id,first.messages[0].id);
    const third=await list({date:'2026-08-20',limit:1,cursor:second.next_cursor});
    assert.equal(third.total,3);
    assert.equal(third.next_cursor,null);
    assert.deepEqual([first,second,third].map(p=>p.messages[0].original_message_id),['new-v1','another','third']);
    assert.equal((await list({date:'2026-08-20',keyword:'蓝色'})).total,2);
    assert.equal((await list({date:'2026-08-20',keyword:'不存在'})).total,0);
    assert.equal((await list({date:'2026-08-20',include_revisions:'true'})).total,5);
    const exact=await list({original_message_id:'old-v0'});
    assert.equal(exact.total,1);
    assert.equal(exact.lookup_status,'found');
    assert.equal(exact.messages[0].current_selected,false);
    assert.equal(exact.messages[0].original_message_id,'old-v0');
    const absent=await list({original_message_id:'no-such-id'});
    assert.equal(absent.total,0);
    assert.equal(absent.lookup_status,'unavailable');
    assert.equal((await list({start:'2026-08-20T03:12:09Z',end:'2026-08-20T03:12:10Z'})).total,1);
    assert.equal((await list({conversation_id:'conversation-B',original_message_id:'old-v0'})).total,0);
    assert.equal((await list({assistant_id:'other',original_message_id:'old-v0'})).total,0);
    assert.equal((await list({conversation_id:'conversation-B',date:'2026-08-20'})).total,1);
    assert.equal((await list({assistant_id:'other',date:'2026-08-20'})).total,1);
  } finally {
    if(pool)await pool.end();
    await admin.query('DROP DATABASE IF EXISTS '+database+' WITH (FORCE)');
    await admin.end();
  }
});
