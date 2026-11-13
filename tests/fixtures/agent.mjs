import { createInterface } from 'node:readline';
const lines=createInterface({input:process.stdin});
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
lines.on('line',line=>{const message=JSON.parse(line);if(message.type==='run.start'){
  send({type:'output',text:'Fixture process received input'});
  send({type:'result',content:'Fixture output: '+message.input});
  send({type:'state',state:'succeeded'});
  lines.close();process.stdin.destroy();
}});
