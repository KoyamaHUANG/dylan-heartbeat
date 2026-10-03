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

test('Gateway keeps a Kelivo tool while archiving one ordinary turn around a bound history lookup',async t=>{
  const requests=[],queries=[];
  const logs=[];
  t.mock.method(console,'log',line=>{
    if (typeof line === 'string' && line.startsWith('{')) logs.push(JSON.parse(line));
  });
  const captures=[];
  t.mock.method(rawChatArchive,'captureChatRequest',input=>{
    const capture={input,assistants:[]};
    captures.push(capture);
    return {
      archiveAssistant:payload=>{capture.assistants.push(payload);return Promise.resolve({});},
      archiveAssistantTerminal:()=>Promise.resolve({})
    };
  });
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
  assert.equal(requests[1].messages.at(-1).role,'tool');
  assert.equal(requests[1].messages.filter(message=>message.role==='user').length,1);
  const evidence=JSON.parse(requests[1].messages.at(-1).content).messages[0];
  assert.deepEqual([evidence.id,evidence.original_message_id,evidence.role,evidence.message_time,evidence.source],
    ['history-mock-1','original-mock-1','user','2026-08-20T00:00:00.000000Z','kelivo_history_import']);
  assert.equal(evidence.content,'模拟历史消息');
  assert.deepEqual(queries,[{assistant_id:'ayan',conversation_id:'conversation-A',date:'2026-08-20',limit:20}]);
  assert.equal(captures.length,1);
  assert.equal(captures[0].input.client_user_message_id,'message-mock-1');
  assert.equal(captures[0].assistants.length,1);
  assert.match(captures[0].assistants[0].content,/我查到一条模拟历史消息/);
  const historyLogs=logs.filter(entry=>entry.event==='ayan_history_tool');
  assert.deepEqual(historyLogs.map(entry=>entry.stage),['eligibility','upstream_request','model_response',
    'query_started','query_completed','tool_result_queued','upstream_request','model_response','final_answer']);
  assert.equal(historyLogs[0].eligible,true);
  assert.equal(new Set(historyLogs.map(entry=>entry.request_id)).size,1);
  assert.equal(typeof historyLogs[0].request_id,'string');
  assert.doesNotMatch(JSON.stringify(historyLogs),/conversation-A|模拟历史消息|original-mock-1|call-history/);
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

test('disabled history tool keeps the ordinary chat archive path and client tools',async t=>{
  const previousFlag=process.env.AYAN_HISTORY_TOOL_ENABLED;
  const captures=[];
  process.env.AYAN_HISTORY_TOOL_ENABLED='false';
  t.mock.method(rawChatArchive,'captureChatRequest',input=>{
    const capture={input,assistants:[]};
    captures.push(capture);
    return {
      archiveAssistant:payload=>{capture.assistants.push(payload);return Promise.resolve({});},
      archiveAssistantTerminal:()=>Promise.resolve({})
    };
  });
  historyReader.query=async()=>{throw new Error('disabled history reader must not run');};
  global.fetch=async(url,options)=>{
    assert.equal(String(url),process.env.TARGET_API_URL);
    const request=JSON.parse(options.body);
    assert.deepEqual(request.tools.map(tool=>tool.function.name),['kelivo_existing_tool']);
    return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'普通回复'}}]}),{
      status:200,headers:{'content-type':'application/json'}
    });
  };
  try{
    const response=await app.inject({
      method:'POST',url:'/v1/chat/completions',remoteAddress:'10.0.0.8',
      headers:{authorization:'Bearer mock-gateway-key','x-kelivo-conversation-id':'conversation-A',
        'x-kelivo-assistant-id':'ayan','x-kelivo-archive-protocol':'1',
        'x-kelivo-request-id':'request-mock-disabled','x-kelivo-user-message-id':'message-mock-disabled'},
      payload:{model:'mock-model',stream:false,messages:[{role:'user',content:'普通聊天'}],
        tools:[{type:'function',function:{name:'kelivo_existing_tool',parameters:{type:'object'}}}],
        _kelivo_archive:{version:1,kind:'user_send',conversation_id:'conversation-A',assistant_id:'ayan',
          request_id:'request-mock-disabled',user_message_id:'message-mock-disabled',user_message_index:0,
          user_message_time:'2026-08-20T00:00:02.000Z',
          user_archive_content:{format:'kelivo_chat_message_parts_v1',parts:[{type:'text',text:'普通聊天'}]}}}
    });
    assert.equal(response.statusCode,200);
    assert.equal(captures.length,1);
    assert.equal(captures[0].input.client_user_message_id,'message-mock-disabled');
    assert.equal(captures[0].assistants.length,1);
    assert.equal(captures[0].assistants[0].content,'普通回复');
  }finally{process.env.AYAN_HISTORY_TOOL_ENABLED=previousFlag;}
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

test('Gateway mixed response after a miss preserves client call association and replaces unsupported content',async t=>{
  let requests=0,queries=0;
  const archived=[];
  t.mock.method(rawChatArchive,'captureChatRequest',()=>({
    archiveAssistant:payload=>{archived.push(payload);return Promise.resolve({});},
    archiveAssistantTerminal:()=>Promise.resolve({})
  }));
  historyReader.query=async()=>{queries++;return {total:0,messages:[],next_cursor:null};};
  const clientCall={id:'mixed-client-call',type:'function',function:{name:'kelivo_existing_tool',arguments:'{"query":"拿铁"}'}};
  global.fetch=async()=>{
    const message=++requests===1?{role:'assistant',tool_calls:[{id:'mixed-history-call',type:'function',
      function:{name:HISTORY_TOOL_NAME,arguments:'{"keyword":"拿铁"}'}}]}
      :{role:'assistant',content:'历史记录不存在。',tool_calls:[clientCall]};
    return new Response(JSON.stringify({choices:[{index:0,message,finish_reason:'tool_calls'}]}),{
      status:200,headers:{'content-type':'application/json'}});
  };
  const response=await app.inject({method:'POST',url:'/v1/chat/completions',remoteAddress:'10.0.0.8',
    headers:{authorization:'Bearer mock-gateway-key','x-kelivo-conversation-id':'conversation-A',
      'x-kelivo-assistant-id':'ayan','x-kelivo-archive-protocol':'1',
      'x-kelivo-request-id':'mixed-request','x-kelivo-user-message-id':'mixed-user'},
    payload:{model:'mock-model',stream:false,messages:[{role:'user',content:'查拿铁'}],
      tools:[{type:'function',function:{name:'kelivo_existing_tool',parameters:{type:'object'}}}],
      _kelivo_archive:{version:1,kind:'user_send',conversation_id:'conversation-A',assistant_id:'ayan',
        request_id:'mixed-request',user_message_id:'mixed-user',user_message_index:0,
        user_message_time:'2026-08-20T00:00:00Z',
        user_archive_content:{format:'kelivo_chat_message_parts_v1',parts:[{type:'text',text:'查拿铁'}]}}}
  });
  assert.equal(response.statusCode,200);
  const choice=response.json().choices[0];
  assert.deepEqual(choice.message.tool_calls,[clientCall]);
  assert.equal(choice.finish_reason,'tool_calls');
  assert.match(choice.message.content,/本次检索未找到.*不代表历史记录不存在/);
  assert.equal(requests,2);
  assert.equal(queries,1);
  assert.ok(archived.length<=1);
  for(const payload of archived)assert.match(payload.content,/本次检索未找到/);
});

test('Gateway retries a keyword miss in the bound date scope and archives only the final sourced answer',async t=>{
  const requests=[],queries=[],captures=[];
  t.mock.method(rawChatArchive,'captureChatRequest',()=>{
    const answers=[];captures.push(answers);
    return {archiveAssistant:payload=>{answers.push(payload);return Promise.resolve({});},
      archiveAssistantTerminal:()=>Promise.resolve({})};
  });
  historyReader.query=async raw=>{
    queries.push(raw);
    return queries.length===1?{total:0,messages:[],next_cursor:null}:{total:1,next_cursor:null,messages:[{
      storage:'history',id:'retry-gateway-hit',original_message_id:'retry-original',role:'user',
      content_text:'模拟拿铁偏好',message_time:'2026-08-20T00:00:00Z',source:'kelivo_history_import'
    }]};
  };
  global.fetch=async(url,options)=>{
    assert.equal(String(url),process.env.TARGET_API_URL);
    const request=JSON.parse(options.body);requests.push(request);
    const message=requests.length<3?{role:'assistant',tool_calls:[{id:`retry-${requests.length}`,type:'function',
      function:{name:HISTORY_TOOL_NAME,arguments:JSON.stringify({date:'2026-08-20',keyword:requests.length===1?'拿铁咖啡':'拿铁'})}}]}
      :{role:'assistant',content:'本次查到模拟拿铁偏好。'};
    return new Response(JSON.stringify({choices:[{message}]}),{status:200,headers:{'content-type':'application/json'}});
  };
  const response=await app.inject({method:'POST',url:'/v1/chat/completions',remoteAddress:'10.0.0.8',
    headers:{authorization:'Bearer mock-gateway-key','x-kelivo-conversation-id':'conversation-A',
      'x-kelivo-assistant-id':'ayan','x-kelivo-archive-protocol':'1',
      'x-kelivo-request-id':'retry-request','x-kelivo-user-message-id':'retry-user'},
    payload:{model:'mock-model',stream:true,messages:[{role:'user',content:'查那天的拿铁偏好'}],
      tools:[{type:'function',function:{name:'kelivo_existing_tool',parameters:{type:'object'}}}],
      _kelivo_archive:{version:1,kind:'user_send',conversation_id:'conversation-A',assistant_id:'ayan',
        request_id:'retry-request',user_message_id:'retry-user',user_message_index:0,
        user_message_time:'2026-08-20T00:00:00Z',
        user_archive_content:{format:'kelivo_chat_message_parts_v1',parts:[{type:'text',text:'查那天的拿铁偏好'}]}}}
  });
  assert.equal(response.statusCode,200);
  assert.equal(requests.length,3);
  assert.deepEqual(queries.map(q=>[q.assistant_id,q.conversation_id,q.date,q.keyword]),[
    ['ayan','conversation-A','2026-08-20','拿铁咖啡'],['ayan','conversation-A','2026-08-20','拿铁']
  ]);
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).lookup_status,'not_found');
  for(const request of requests){
    assert.deepEqual(request.tools.map(tool=>tool.function.name),['kelivo_existing_tool',HISTORY_TOOL_NAME]);
    assert.equal(request._kelivo_archive,undefined);
  }
  assert.equal(captures.length,1);
  assert.equal(captures[0].length,1);
  assert.equal(captures[0][0].content,'本次查到模拟拿铁偏好。');
  assert.match(response.body,/本次查到模拟拿铁偏好/);
  assert.match(response.body,/data: \[DONE\]/);
});
