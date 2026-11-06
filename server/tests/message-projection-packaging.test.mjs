// Static source/package checks only: no import of product services, DB,
// processes, Docker builds or network access.
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {posix} from 'node:path';

const root=new URL('../../',import.meta.url);
const source=name=>readFile(new URL(name,root),'utf8');
const required=['src/message-preview.js','server/message-read-states.mjs'];
const relativeImports=text=>[...text.matchAll(/^\s*import\s+(?:[^;"']*?\s+from\s*)?["'](\.[^"']+)["']/gm)].map(match=>match[1]);

async function importClosure(entry){
  const visited=new Set();
  async function walk(name){
    if(visited.has(name))return;
    assert.match(name,/^(src|server)\/[a-z-]+\.(?:mjs|js)$/);
    visited.add(name);
    for(const dependency of relativeImports(await source(name)))
      await walk(posix.normalize(posix.join(posix.dirname(name),dependency)));
  }
  await walk(entry);return [...visited].sort();
}

// The reviewed Dockerfiles use one-line shell-form COPY. Keep this parser
// deliberately small and reject unsupported syntax rather than guessing.
function copiedFiles(docker){
  let workdir='/',stage='';const files=new Map();
  for(const raw of docker.split(/\r?\n/)){
    const line=raw.trim();
    if(line.startsWith('FROM ')){stage=line;continue;}
    if(line.startsWith('WORKDIR ')){workdir=posix.resolve(workdir,line.slice(8));continue;}
    if(!line.startsWith('COPY ')||/^COPY\s+--from=/.test(line))continue;
    assert.ok(!line.includes('\\')&&!line.includes('['),'Review COPY syntax before extending the static parser');
    const parts=line.split(/\s+/).slice(1).filter(part=>!part.startsWith('--'));
    const destination=parts.pop();assert.ok(parts.length&&destination);
    for(const name of parts){
      if(name.endsWith('/'))continue; // Dependencies below require exact file COPY.
      const target=destination.endsWith('/')?posix.join(destination,posix.basename(name)):destination;
      files.set(name,{target:posix.resolve(workdir,target),stage});
    }
  }
  return files;
}

test('conversation projections directly import the shared preview and server read-state helpers',async()=>{
  const imports=relativeImports(await source('server/conversations.mjs'));
  assert.ok(imports.includes('../src/message-preview.js'));
  assert.ok(imports.includes('./message-read-states.mjs'));
  const closure=await importClosure('server/conversations.mjs');
  for(const name of required)assert.ok(closure.includes(name));
});

for(const name of ['postgres-test','recovery-test','linux-decoder-test'])
  test(`${name} exactly packages the conversation projection import closure without broadening private build input`,async()=>{
    const docker=await source(`server/${name}.Dockerfile`);
    const allowlist=(await source(`server/${name}.Dockerfile.dockerignore`)).split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
    assert.equal(allowlist[0],'**');
    for(const broad of ['!src/**','!src/*','!server/**','!server/*','!.env','!.env*','!private/','!private/**'])
      assert.ok(!allowlist.includes(broad),`Unexpected broad build inclusion: ${broad}`);
    assert.doesNotMatch(docker,/^COPY\s+(?:src\/\s|server\/\s|\.\s)/m);
    const copies=copiedFiles(docker),closure=await importClosure('server/conversations.mjs');
    for(const dependency of closure){
      assert.ok(allowlist.includes(`!${dependency}`),`${name} omits ${dependency} from its exact build allowlist`);
      assert.equal(copies.get(dependency)?.target,`/app/${dependency}`,`${name} omits/misplaces ${dependency}`);
    }
    for(const dependency of required){
      assert.equal(allowlist.filter(line=>line===`!${dependency}`).length,1);
      if(name==='linux-decoder-test')assert.equal(copies.get(dependency).stage,'FROM controller AS media-preparation');
    }
    assert.match(docker,/^USER node$/m);
    assert.doesNotMatch(docker,/^RUN\s+(?:npm|curl|wget)\b/m);
  });
