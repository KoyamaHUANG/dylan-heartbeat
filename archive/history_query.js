const crypto = require('node:crypto');
const { Temporal } = require('@js-temporal/polyfill');
const { localDateRangeToUtc, resolveTimeZone } = require('../time_utils');
const { normalizeIdentifier } = require('./archive_store');
const { parseArchiveBoolean, parseArchiveLimit } = require('./archive_routes');
const { authorizeArchiveRequest } = require('./archive_auth');

function invalid() { const e = new Error('Invalid raw history query'); e.code = 'HISTORY_QUERY_INVALID'; return e; }
function iso(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(value)) throw invalid();
  try { return Temporal.Instant.from(value).toString({ fractionalSecondDigits: 6 }); } catch { throw invalid(); }
}
const scopeHash = q => crypto.createHash('sha256').update(JSON.stringify({
  assistant_id:q.assistant_id,conversation_id:q.conversation_id,start:q.start,end:q.end,
  include_revisions:q.include_revisions,timezone:q.timezone,
  keyword:q.keyword,original_message_id:q.original_message_id
})).digest('hex');
function sign(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return 'rh1.' + encoded + '.' + crypto.createHmac('sha256', secret).update(encoded).digest('hex');
}
function decode(cursor, secret, scope) {
  try {
    if (typeof cursor !== 'string' || cursor.length > 4096) throw invalid();
    const [prefix, encoded, signature, extra] = cursor.split('.');
    if (prefix !== 'rh1' || !encoded || !/^[a-f0-9]{64}$/.test(signature || '') || extra) throw invalid();
    const expected = crypto.createHmac('sha256', secret).update(encoded).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw invalid();
    const p = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (p.v !== 1 || p.scope !== scope || typeof p.key !== 'string' || p.key.length > 512) throw invalid();
    p.time = iso(p.time); p.watermark = iso(p.watermark);
    return p;
  } catch { throw invalid(); }
}
function parseHistoryQuery(raw = {}, {timeZone = resolveTimeZone(), secret} = {}) {
  let assistant_id, conversation_id, keyword, original_message_id;
  try {
    assistant_id = normalizeIdentifier(raw.assistant_id, {field:'assistant_id'});
    conversation_id = normalizeIdentifier(raw.conversation_id, {field:'conversation_id'});
    keyword = normalizeIdentifier(raw.keyword, {field:'keyword',maxLength:200});
    original_message_id = normalizeIdentifier(raw.original_message_id, {field:'original_message_id'});
  } catch { throw invalid(); }
  if (!assistant_id && !conversation_id) throw invalid();
  if ((keyword || original_message_id) && (!assistant_id || !conversation_id)) throw invalid();
  const requestedRevisions=parseArchiveBoolean(raw.include_revisions,'include_revisions');
  const q = {assistant_id,conversation_id,keyword,original_message_id,timezone:timeZone,start:null,end:null,
    // An exact source-ID lookup must also find an older, non-selected revision.
    include_revisions:original_message_id ? true : requestedRevisions,
    limit:parseArchiveLimit(raw.limit)};
  if (raw.date) {
    if (raw.start || raw.end) throw invalid();
    const range = localDateRangeToUtc(raw.date,timeZone);
    if (!range) throw invalid();
    q.start=range.start.toISOString(); q.end=range.end.toISOString(); q.date=raw.date;
  } else if (raw.start || raw.end) {
    if (!raw.start || !raw.end) throw invalid();
    q.start=iso(raw.start); q.end=iso(raw.end);
    if (Temporal.Instant.compare(q.start,q.end)>=0) throw invalid();
  }
  q.scope=scopeHash(q);
  q.cursor=raw.cursor ? decode(raw.cursor,secret,q.scope) : null;
  return q;
}

// History results use their own cursor and ordering. Existing V1 archive and
// proactive cursors remain untouched; live sequence is never changed.
function unionSql(q, watermark) {
  const args=[watermark];
  const common = alias => {
    const clauses=[alias+'.message_time IS NOT NULL'];
    if(q.assistant_id){args.push(q.assistant_id);clauses.push(alias+'.assistant_id=$'+args.length);}
    if(q.conversation_id){args.push(q.conversation_id);clauses.push(alias+'.conversation_id=$'+args.length);}
    if(q.start){args.push(q.start,q.end);clauses.push(alias+'.message_time >= $'+(args.length-1)+'::timestamptz AND '+alias+'.message_time < $'+args.length+'::timestamptz');}
    if(q.keyword){args.push(q.keyword);clauses.push('strpos(lower('+alias+'.content_text),lower($'+args.length+'::text)) > 0');}
    return clauses;
  };
  const live=common('m'); live.push('m.canonical=TRUE','m.created_at <= $1::timestamptz');
  const hist=common('h'); hist.push("h.dedupe_status='distinct'",'h.imported_at <= $1::timestamptz');
  if(q.original_message_id){live.push('FALSE');args.push(q.original_message_id);hist.push('h.original_message_id=$'+args.length);}
  if(!q.include_revisions) hist.push("h.current_selected=TRUE AND h.revision_status='resolved'");
  // A later live retry can arrive after a backfill commit. Prefer its proven
  // stable identity at read time without changing the live write path.
  if(!q.original_message_id)hist.push(`NOT EXISTS (SELECT 1 FROM archive_messages l
    WHERE l.conversation_id=h.conversation_id AND l.role=h.role AND l.canonical=TRUE
      AND l.created_at <= $1::timestamptz
      AND (l.assistant_id IS NULL OR l.assistant_id=h.assistant_id)
      AND (l.fingerprint=h.content_fingerprint OR
        (h.dedupe_metadata->>'visible_text_only'='true'
         AND jsonb_typeof(l.content_json)='string' AND l.content_text=h.content_text))
      AND ((h.external_event_id IS NOT NULL AND l.external_event_id=h.external_event_id)
        OR ((l.metadata_json->>'client_user_message_id'=h.original_message_id
          OR l.metadata_json->>'original_message_id'=h.original_message_id)
          AND date_trunc('milliseconds',l.message_time)=date_trunc('milliseconds',h.message_time))))`);
  const sql=`SELECT 'live'::text AS storage,m.archive_message_id::text AS id,m.assistant_id,m.conversation_id,m.role,
      m.content_text,m.content_json,m.message_time,m.created_at AS recorded_at,m.source,m.sequence,
      NULL::text AS original_message_id,TRUE AS current_selected,
      'live'::text AS revision_status,NULL::text AS revision_group,NULL::integer AS revision_index,
      ('l:'||m.conversation_id||':'||lpad(m.sequence::text,20,'0')||':'||m.archive_message_id::text) COLLATE "C" AS sort_key
    FROM archive_messages m WHERE ${live.join(' AND ')}
    UNION ALL
    SELECT 'history',h.history_id::text,h.assistant_id,h.conversation_id,h.role,
      h.content_text,h.content_json,h.message_time,h.imported_at,h.source,NULL::bigint,h.original_message_id,h.current_selected,
      h.revision_status,h.revision_group,h.revision_index,
      ('h:'||h.conversation_id||':'||lpad(h.original_order::text,20,'0')||':'||h.history_id::text) COLLATE "C" AS sort_key
    FROM archive_history_messages h WHERE ${hist.join(' AND ')}`;
  return {sql,args};
}
async function listHistory(pool,q,secret) {
  const c=await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    await c.query("SET LOCAL statement_timeout='15s'");
    const time = (await c.query("SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS watermark")).rows[0].watermark;
    const watermark=q.cursor?.watermark || time;
    const {sql,args}=unionSql(q,watermark);
    const total=Number((await c.query('SELECT COUNT(*)::text AS total FROM ('+sql+') all_messages',args)).rows[0].total);
    let after='';
    if(q.cursor){args.push(q.cursor.time,q.cursor.key);after='WHERE (message_time > $'+(args.length-1)+'::timestamptz OR (message_time=$'+(args.length-1)+'::timestamptz AND sort_key > $'+args.length+' COLLATE "C"))';}
    args.push(q.limit+1);
    const result=await c.query(`SELECT storage,id,assistant_id,conversation_id,role,content_text,content_json,source,sequence,original_message_id,
      to_char(message_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS message_time,
      current_selected,revision_status,revision_group,revision_index,sort_key
      FROM (${sql}) all_messages ${after} ORDER BY message_time ASC,sort_key ASC LIMIT $${args.length}`,args);
    const more=result.rows.length>q.limit, rows=result.rows.slice(0,q.limit), last=rows.at(-1);
    const next_cursor=more?sign({v:1,scope:q.scope,time:last.message_time,key:last.sort_key,watermark},secret):null;
    return {timezone:q.timezone,date:q.date||null,total,messages:rows.map(({sort_key,...r})=>r),next_cursor,
      ...(q.original_message_id?{lookup_status:total===0?'unavailable':'found'}:{})};
  } finally {try {await c.query('ROLLBACK');} finally{c.release();}}
}
function registerHistoryRoutes(app,{timeZone=resolveTimeZone(),pool:injectedPool=null,
  databaseUrl=process.env.ARCHIVE_DATABASE_URL,enabled=process.env.ARCHIVE_ENABLED,
  archiveApiKey=process.env.ARCHIVE_API_KEY,requireBothForHttp=false}={}) {
  let pool=injectedPool;
  const query=async raw=>{
    const q=parseHistoryQuery(raw,{timeZone,secret:archiveApiKey});
    if(!pool){
      if(!['true','1','yes','on'].includes(String(enabled).toLowerCase())||!databaseUrl)
        throw Object.assign(new Error('History unavailable'),{code:'HISTORY_UNAVAILABLE'});
      const {Pool}=require('pg');pool=new Pool({connectionString:databaseUrl,max:2,connectionTimeoutMillis:3000,idleTimeoutMillis:10000});
      pool.on('error',()=>{});
    }
    return listHistory(pool,q,archiveApiKey);
  };
  app.get('/v1/archive/history',async(req,reply)=>{
    const auth=authorizeArchiveRequest(req.headers,archiveApiKey);
    if(!auth.allow)return reply.code(auth.status).send({error:auth.error});
    if(requireBothForHttp && (!req.query?.assistant_id || !req.query?.conversation_id))
      return reply.code(400).send({error:'History unavailable or invalid query'});
    try {
      return await query(req.query);
    } catch(e) {
      return reply.code(['HISTORY_QUERY_INVALID','ARCHIVE_QUERY_INVALID'].includes(e.code)?400:503).send({error:'History unavailable or invalid query'});
    }
  });
  app.addHook('onClose',async()=>{if(pool&&!injectedPool)await pool.end();});
  return {query};
}
module.exports={parseHistoryQuery,unionSql,listHistory,registerHistoryRoutes,sign,decode};
