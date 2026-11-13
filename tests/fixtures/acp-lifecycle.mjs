import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const [mode, journal] = process.argv.slice(2);
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\n');
const record = name => { if(journal) appendFileSync(journal, name+'\n'); };
record('spawn');
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const m = JSON.parse(line);
  record(m.method ?? 'response');
  if(m.method === 'initialize') setTimeout(() => send({id:m.id, result:{protocolVersion:1,agentCapabilities:{loadSession:mode !== 'unsupported'},authMethods:[]}}), 100);
  if(m.method === 'session/new') setTimeout(() => send({id:m.id, result:{sessionId:'persisted-acp-session'}}), mode === 'slow-new' ? 500 : 0);
  if(m.method === 'session/load') {
    send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'HISTORICAL_OUTPUT'}}}});
    send({id:m.id,result:{}});
  }
  if(m.method === 'session/prompt' && mode !== 'hang') {
    send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'LIVE_ANSWER'}}}});
    send({id:m.id,result:{stopReason:'end_turn'}});
  }
});
