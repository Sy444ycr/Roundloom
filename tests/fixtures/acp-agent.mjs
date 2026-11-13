import { createInterface } from 'node:readline';
let count=0,permission;const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:false},authMethods:[{id:'fixture',name:'Fixture auth'}]}});
else if(m.method==='authenticate')send({id:m.id,result:{}});
else if(m.method==='session/new')send({id:m.id,result:{sessionId:'native-fixture'}});
else if(m.method==='session/prompt'){permission={prompt:m.id};send({id:'permission-'+(++count),method:'session/request_permission',params:{sessionId:'native-fixture',toolCall:{toolCallId:'tool-1',title:'Fixture write',status:'pending'},options:[{optionId:'allow',name:'Allow once',kind:'allow_once'},{optionId:'deny',name:'Deny',kind:'reject_once'}]}});}
else if(m.id?.startsWith?.('permission-')){send({method:'session/update',params:{sessionId:'native-fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Fixture answer '+count}}}});send({id:permission.prompt,result:{stopReason:'end_turn'}});}
else if(m.method==='session/cancel'&&permission)send({id:permission.prompt,result:{stopReason:'cancelled'}});
});
