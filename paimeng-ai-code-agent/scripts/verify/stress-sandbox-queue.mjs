// Exercises the current prototype's actual enqueue function, with one real Docker holder.
// The copied source is pinned by SHA-256; only paths, logging output and hold duration are adapted.
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const runId=randomUUID().slice(0,8),output=join(root,'runtime','queue-stress',`sandbox-${runId}`);
await mkdir(output,{recursive:true});
const path=join(root,'src/server/delivery/sandbox.prototype/run.mjs');
const lock=await readFile(join(root,'templates/react-ts/1.0.0/package-lock.json'));
const cacheKey=createHash('sha256').update('node:24-alpine').update(lock).digest('hex').slice(0,16);
await readFile(join(root,'runtime/sandbox-prototype/dependencies',`react-ts-${cacheKey}`,'ready.json'));
const original=await readFile(path,'utf8');
const marker='\nawait mkdir(runRoot, { recursive: true });';
if(!original.includes(marker))throw new Error('Prototype changed: benchmark extraction needs review');
let source=original.slice(0,original.indexOf(marker));
source=source.replace("const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');",`const root = ${JSON.stringify(root)};`)
 .replace("const runRoot = join(root, 'runtime', 'sandbox-prototype', runId);",`const runRoot = ${JSON.stringify(join(output,'workspace'))};`)
 .replace('}, 800);','}, 10_000);');
const sourceHash=createHash('sha256').update(original).digest('hex');
source+=`
const benchmark = {runId:${JSON.stringify(runId)},sourceHash:${JSON.stringify(sourceHash)},scope:'prototype queue only, not product admission',holdMs:10000,snapshots:[]};
console.log=()=>{};
const mark=label=>{global.gc();benchmark.snapshots.push({label,at:new Date().toISOString(),memory:process.memoryUsage(),queued:report.jobs.filter(j=>j.status==='queued').length,active,events:report.events.length});};
const nap=ms=>new Promise(r=>setTimeout(r,ms));
await mkdir(runRoot,{recursive:true});
const dependencies=await prepareDependencies('react-ts');
const holder=enqueue({id:'holder',template:'react-ts',dependencies,kind:'timeout'});
while(!report.events.some(e=>e.event==='started'))await nap(10);
mark('holder-running');
const handles=[];
for(const target of [100,1000,10000]){
 const before=performance.now();
 while(handles.length<target)handles.push(enqueue({id:'pending-'+handles.length,template:'react-ts',dependencies}));
 benchmark.snapshots.push({label:'enqueue-time-'+target,elapsedMs:performance.now()-before});
 await nap(20);mark('queued-'+target);
}
for(const handle of handles)handle.cancel();
await Promise.all([holder.promise,...handles.map(h=>h.promise)]);
mark('drained-records-retained');
benchmark.maxActive=maxActive;
benchmark.cancelled=report.jobs.filter(j=>j.status==='cancelled-before-start').length;
benchmark.holderStatus=report.jobs.find(j=>j.id==='holder').status;
benchmark.remainingContainers=(await docker(['ps','-aq','--filter','label=paimeng.prototype='+runId])).stdout.trim();
handles.length=0;report.jobs.length=0;report.events.length=0;
await nap(1000);mark('released-and-gc');
benchmark.passed=benchmark.maxActive===1&&benchmark.cancelled===10000&&!benchmark.remainingContainers;
await writeFile(${JSON.stringify(join(output,'report.json'))},JSON.stringify(benchmark,null,2));
process.stdout.write(JSON.stringify(benchmark,null,2)+'\\n');
if(!benchmark.passed)process.exitCode=1;
`;
const entry=join(output,'probe.mjs');await writeFile(entry,source);
console.log('[sandbox-queue-stress] source',sourceHash);
const child=spawn(process.execPath,['--expose-gc','--max-old-space-size=256',entry],{cwd:root,env:process.env,stdio:'inherit'});
const result=await new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',reject);});
console.log('[sandbox-queue-stress] report',join(output,'report.json'));
process.exitCode=result.code??1;
