const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {HISTORY_TOOL_NAME} = require('../archive/history_tool');

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(),'ayan-history-tool-gateway-'));
process.env.DATA_DIR = dataDirectory;
process.env.RAILWAY_ENVIRONMENT = 'test';
process.env.ALLOW_PUBLIC_API = 'true';
process.env.GATEWAY_API_KEY = 'mock-gateway-key';
process.env.TARGET_API_URL = 'https://mock-upstream.invalid/v1/chat/completions';
process.env.TARGET_API_KEY = 'mock-upstream-key';
process.env.ARCHIVE_ENABLED = 'true';
process.env.ARCHIVE_DATABASE_URL = 'postgres://mock.invalid/archive';
process.env.ARCHIVE_API_KEY = 'mock-archive-key';
process.env.AYAN_HISTORY_TOOL_ENABLED = 'true';
const {app,historyReader,rawChatArchive} = require('../server');
rawChatArchive.enabled = false;
const originalFetch = global.fetch;

test.after(async()=>{
  global.fetch = originalFetch;
  await app.close();
  fs.rmSync(dataDirectory,{recursive:true,force:true});
});

test('Gateway keeps a Kelivo tool while completing a bound history lookup and final answer',async()=>{
  const requests=[],queries=[];
  historyReader.query=async raw=>{
    queries.push(raw);
    return {date:raw.date,timezone:'Asia/Shanghai',total:1,next_cursor:null,messages:[{
      storage:'history',id:'history-mock-1',original_message_id:'original-mock-1',
      role:'user',content_text:'模拟历史消息',message_time:'2026-08-20T00:00:00.000000Z',
      source:'kelivo_history_import',revision_status:'resolved'
    }]};
  };
  global.fetch=async(url,options)=>{
    assert.equal(String(url),process.env.TARGET_API_URL);
    const request=JSON.parse(options.body);requests.push(request);
    assert.equal(request._kelivo_archive,undefined);
    const message=requests.length===1
      ?{role:'assistant',tool_calls:[{id:'call-history',type:'function',function:{name:HISTORY_TOOL_NAME,arguments:'{"date":"2026-08-20"}'}}]}
      :{role:'assistant',content:'我查到一条模拟历史消息。'};
    return new Response(JSON.stringify({id:'mock-gateway-completion',model:'mock-model',choices:[{message}]}),{
      status:200,headers:{'content-type':'application/json'}
    });
  };
  const response=await app.inject({
    method:'POST',url:'/v1/chat/completions',remoteAddress:'10.0.0.8',
    headers:{authorization:'Bearer mock-gateway-key','x-kelivo-conversation-id':'conversation-A',
      'x-kelivo-assistant-id':'ayan','x-kelivo-archive-protocol':'1',
      'x-kelivo-request-id':'request-mock-1','x-kelivo-user-message-id':'message-mock-1'},
    payload:{model:'mock-model',stream:true,messages:[{role:'user',content:'那天聊了什么？'}],
      tools:[{type:'function',function:{name:'kelivo_existing_tool',parameters:{type:'object'}}}],tool_choice:'auto',
      _kelivo_archive:{version:1,kind:'user_send',conversation_id:'conversation-A',assistant_id:'ayan',
        request_id:'request-mock-1',user_message_id:'message-mock-1',user_message_index:0,
        user_message_time:'2026-08-20T00:00:00.000Z',
        user_archive_content:{format:'kelivo_chat_message_parts_v1',parts:[{type:'text',text:'那天聊了什么？'}]}}}
  });
  assert.equal(response.statusCode,200);
  assert.match(response.body,/我查到一条模拟历史消息/);
  assert.match(response.body,/data: \[DONE\]/);
  assert.equal(requests.length,2);
  assert.deepEqual(requests[0].tools.map(tool=>tool.function.name),['kelivo_existing_tool',HISTORY_TOOL_NAME]);
  assert.deepEqual(requests[1].tools.map(tool=>tool.function.name),['kelivo_existing_tool',HISTORY_TOOL_NAME]);
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).messages[0].content,'模拟历史消息');
  assert.deepEqual(queries,[{assistant_id:'ayan',conversation_id:'conversation-A',date:'2026-08-20',limit:20}]);
});

test('Gateway passes an existing Kelivo tool call back to the client without a history lookup',async()=>{
  let requests=0;
  historyReader.query=async()=>{throw new Error('history reader must not run');};
  global.fetch=async(url,options)=>{
    assert.equal(String(url),process.env.TARGET_API_URL);
    const request=JSON.parse(options.body);
    requests++;
    assert.deepEqual(request.tools.map(tool=>tool.function.name),['kelivo_existing_tool',HISTORY_TOOL_NAME]);
    return new Response(JSON.stringify({id:'mock-existing-tool',model:'mock-model',choices:[{
      message:{role:'assistant',tool_calls:[{id:'call-existing',type:'function',
        function:{name:'kelivo_existing_tool',arguments:'{}'}}]},finish_reason:'tool_calls'
    }]}),{status:200,headers:{'content-type':'application/json'}});
  };
  const response=await app.inject({
    method:'POST',url:'/v1/chat/completions',remoteAddress:'10.0.0.8',
    headers:{authorization:'Bearer mock-gateway-key','x-kelivo-conversation-id':'conversation-A',
      'x-kelivo-assistant-id':'ayan','x-kelivo-archive-protocol':'1',
      'x-kelivo-request-id':'request-mock-2','x-kelivo-user-message-id':'message-mock-2'},
    payload:{model:'mock-model',stream:true,messages:[{role:'user',content:'请调用已有工具'}],
      tools:[{type:'function',function:{name:'kelivo_existing_tool',parameters:{type:'object'}}}],tool_choice:'auto',
      _kelivo_archive:{version:1,kind:'user_send',conversation_id:'conversation-A',assistant_id:'ayan',
        request_id:'request-mock-2',user_message_id:'message-mock-2',user_message_index:0,
        user_message_time:'2026-08-20T00:00:01.000Z',
        user_archive_content:{format:'kelivo_chat_message_parts_v1',parts:[{type:'text',text:'请调用已有工具'}]}}}
  });
  assert.equal(response.statusCode,200);
  assert.equal(requests,1);
  assert.match(response.body,/kelivo_existing_tool/);
  assert.match(response.body,/data: \[DONE\]/);
});

test('Gateway keeps the existing stream error response path with history tool disabled',async()=>{
  const previousFlag=process.env.AYAN_HISTORY_TOOL_ENABLED;
  const expectedBody='{"error":"mock upstream error"}';
  let requests=0;
  process.env.AYAN_HISTORY_TOOL_ENABLED='false';
  global.fetch=async(url,options)=>{
    assert.equal(String(url),process.env.TARGET_API_URL);
    const request=JSON.parse(options.body);
    requests++;
    assert.equal(request.stream,true);
    assert.deepEqual(request.tools.map(tool=>tool.function.name),['kelivo_existing_tool']);
    return new Response(expectedBody,{status:429,headers:{'content-type':'application/json'}});
  };
  try {
    const response=await app.inject({
      method:'POST',url:'/v1/chat/completions',remoteAddress:'10.0.0.8',
      headers:{authorization:'Bearer mock-gateway-key'},
      payload:{model:'mock-model',stream:true,messages:[{role:'user',content:'模拟上游限流'}],
        tools:[{type:'function',function:{name:'kelivo_existing_tool',parameters:{type:'object'}}}]}
    });
    assert.equal(response.statusCode,429);
    assert.equal(response.body,expectedBody);
    assert.match(response.headers['content-type'],/^application\/json/);
    assert.equal(response.headers['cache-control'],'no-cache');
    assert.equal(requests,1);
  } finally {
    process.env.AYAN_HISTORY_TOOL_ENABLED=previousFlag;
  }
});
