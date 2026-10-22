import{mkdirSync,readFileSync,writeFileSync,copyFileSync}from'node:fs';
const dest='deploy/site/dist';mkdirSync(dest,{recursive:true});
for(const name of ['index.html','style.css','app.js'])copyFileSync('deploy/site/'+name,dest+'/'+name);
const read=name=>JSON.parse(readFileSync('docs/results/'+name,'utf8'));
writeFileSync(dest+'/proof.json',JSON.stringify({ledger:read('ledger.json'),decisions:read('decisions.json'),reconciliation:read('reconciliation.json'),enrichment:read('enrichment.json'),freshness:read('freshness.json'),recording:read('demo-probe.json')}));
for(const name of ['demo.webm','console-desktop.png'])copyFileSync('docs/results/'+name,dest+'/'+name);
console.log('Built measured evidence and actual console recording. Persistent API is not hosted.');
