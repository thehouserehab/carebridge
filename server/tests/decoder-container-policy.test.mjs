import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { DECODER_NODE_IMAGE,DECODER_RUN_LABEL,decoderResourceNames,decoderReceipt,decoderContainerArguments,assertDecoderOwner,assertDecoderIsolation } from '../decoder-container-policy.mjs';
const names = decoderResourceNames('12345678-1234-4234-8234-123456789abc');
const imageId = `sha256:${'a'.repeat(64)}`, receipt = decoderReceipt('b'.repeat(64),names.run);
const fixture = () => ({ Id:receipt.id,Name:`/${receipt.name}`,Image:imageId,State:{ Running:false },
  Config:{ User:'node',Env:['TZ=UTC'],Labels:{ [DECODER_RUN_LABEL]:names.run } },
  HostConfig:{ ReadonlyRootfs:true,Privileged:false,NetworkMode:'none',PidMode:'',IpcMode:'private',UTSMode:'',
    Memory:1024*1024*1024,MemorySwap:1024*1024*1024,NanoCpus:1e9,PidsLimit:128,LogConfig:{ Type:'none' },RestartPolicy:{ Name:'no' },
    Ulimits:[{ Name:'nofile',Soft:1024,Hard:1024 }],
    CapDrop:['ALL'],CapAdd:null,SecurityOpt:['no-new-privileges'],Binds:null,VolumesFrom:null,Devices:[],DeviceRequests:[],Mounts:[],PortBindings:{},
    Tmpfs:{ '/tmp':'rw,noexec,nosuid,nodev,size=256m,mode=1777' } },Mounts:[],
  NetworkSettings:{ Networks:{ none:{ IPAddress:'',Gateway:'',GlobalIPv6Address:'',IPv6Gateway:'' } },Ports:{} } });
const refused = (run) => assert.throws(run,{ message:'DECODER_CONTAINER_SAFETY' });
const checked = (state) => assertDecoderIsolation(state,receipt,imageId);
test('decoder UUID full IDs immutable base and exact names required',() => {
  assert.match(DECODER_NODE_IMAGE,/^docker\.io\/library\/node@sha256:[a-f0-9]{64}$/);
  for (const run of ['existing',null,'../test','12345678-1234-1234-8234-123456789abc']) refused(() => decoderResourceNames(run));
  refused(() => decoderReceipt('short',names.run)); refused(() => decoderContainerArguments({ ...names,worker:'existing' },imageId));
  refused(() => decoderContainerArguments(names,'latest')); checked(fixture());
});
test('worker starts offline non-root read-only bounded without user mounts',() => {
  const args = decoderContainerArguments(names,imageId);
  for (const required of ['--network=none','--read-only','--pull=never','node','--memory=1024m','--memory-swap=1024m','--pids-limit=128','no-new-privileges']) assert.ok(args.includes(required));
  assert.equal(args.some((arg) => /--publish|--volume|--mount|--privileged|docker\.sock/.test(arg)),false);
});
test('cleanup receipt must match container full ID name image and label',() => {
  for (const change of [{ Id:'c'.repeat(64) },{ Name:'/existing' },{ Image:`sha256:${'c'.repeat(64)}` },{ Config:{ Labels:{} } }]) refused(() => assertDecoderOwner({ ...fixture(),...change },receipt,imageId));
  refused(() => assertDecoderOwner(fixture(),{ ...receipt,name:'existing' },imageId));
});
test('writable root root user unlimited resources or elevated capabilities refused',() => {
  for (const change of [{ ReadonlyRootfs:false },{ Privileged:true },{ Memory:0 },{ MemorySwap:-1 },{ NanoCpus:0 },{ PidsLimit:0 },
    { CapDrop:[] },{ CapAdd:['SYS_ADMIN'] },{ SecurityOpt:[] },{ SecurityOpt:['no-new-privileges','seccomp=unconfined'] },{ Ulimits:[] },
    { Ulimits:[{ Name:'nofile',Soft:1024,Hard:65536 }] },{ LogConfig:{ Type:'json-file' } },{ RestartPolicy:{ Name:'always' } }]) {
    const state = fixture(); Object.assign(state.HostConfig,change); refused(() => checked(state));
  }
  const root = fixture(); root.Config.User = 'root'; refused(() => checked(root));
  const timezone = fixture(); timezone.Config.Env.push('TZ=Asia/Seoul'); refused(() => checked(timezone));
  const running = fixture(); running.State.Running = true; refused(() => checked(running));
});
test('network ports devices mounts and shared host namespaces refused',() => {
  for (const change of [{ NetworkMode:'bridge' },{ PidMode:'host' },{ IpcMode:'host' },{ UTSMode:'host' },{ Binds:['C:/private:/host'] },
    { VolumesFrom:['existing'] },{ Devices:[{}] },{ DeviceRequests:[{}] },{ Mounts:[{}] },{ Tmpfs:{} },{ PortBindings:{ '8080/tcp':[{}] } }]) {
    const state = fixture(); Object.assign(state.HostConfig,change); refused(() => checked(state));
  }
  for (const mutate of [ (state) => state.Mounts.push({ Type:'bind',Destination:'/host' }),
    (state) => { state.NetworkSettings.Networks.other = {}; },(state) => { state.NetworkSettings.Networks.none.Gateway = '1.2.3.4'; },
    (state) => { state.NetworkSettings.Ports['8080/tcp'] = [{}]; } ]) { const state = fixture(); mutate(state); refused(() => checked(state)); }
});
test('decoder build permits only verified public sources and exact internal modules',async () => {
  const dockerfile = await readFile(new URL('../decoder-test.Dockerfile',import.meta.url),'utf8');
  assert.ok(dockerfile.includes(`FROM ${DECODER_NODE_IMAGE} AS compiled`));
  for (const fixed of ['--disable-network','--disable-autodetect','--disable-everything','--no-autostart',
    'FCF986EA15E6E293A5644F10B4322F04D67658D8','8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e','libwebpmux',
    '--enable-demuxer=image_png_pipe,image_jpeg_pipe,image_webp_pipe','pcm_u8,wrapped_avframe',
    '--enable-libx265','--enable-libaom','--enable-libmp3lame','--enable-libopus','--enable-libvorbis',
    'libaom_av1,mpeg4','libmp3lame,alac,libopus,libvorbis']) assert.ok(dockerfile.includes(fixed));
  assert.equal(/ADD\s|curl\s|wget\s|COPY\s+\.\s/m.test(dockerfile),false);
  const rules = (await readFile(new URL('../decoder-test.Dockerfile.dockerignore',import.meta.url),'utf8')).split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(rules,['**','!package.json','!src/','!src/media-policy.js','!server/','!server/errors.mjs','!server/media-preparation-policy.mjs','!server/media-decoder-policy.mjs',
    '!server/media-container-validation.mjs','!server/media-decoder.mjs','!server/decoder-native-test.mjs','!server/decoder-fixtures.mjs',
    '!server/image-metadata.mjs','!server/image-metadata-test-fixtures.mjs','!server/image-metadata-native-test.mjs',
    '!server/icc-profile.mjs','!server/icc-profile-test-fixtures.mjs','!server/icc-profile-native-test.mjs','!server/icc-color-test.c',
    '!server/video-metadata.mjs','!server/mp4-metadata.mjs','!server/webm-metadata.mjs','!server/video-metadata-test-fixtures.mjs','!server/video-metadata-native-test.mjs','!test-results/','!test-results/runtime-build/',
    '!test-results/runtime-build/ffmpeg-9.0.2/','!test-results/runtime-build/ffmpeg-9.0.2/ffmpeg-9.0.2.tar.xz',
    '!test-results/runtime-build/ffmpeg-9.0.2/ffmpeg-9.0.2.tar.xz.asc','!test-results/runtime-build/ffmpeg-9.0.2/ffmpeg-devel.asc']);
  assert.ok(dockerfile.includes('FROM worker AS image-metadata'));
  assert.ok(dockerfile.includes('COPY server/image-metadata.mjs server/image-metadata-test-fixtures.mjs server/image-metadata-native-test.mjs ./'));
  assert.ok(dockerfile.includes('CMD ["node", "image-metadata-native-test.mjs"]'));
  assert.ok(dockerfile.includes('FROM compiled AS image-color-compiled'));
  assert.ok(dockerfile.includes('lcms2-dev=2.19-r0'));
  assert.ok(dockerfile.includes('lcms2=2.19-r0'));
  assert.ok(dockerfile.includes('-std=c11 -O2 -Wall -Wextra -Werror'));
  assert.ok(dockerfile.includes('COPY server/icc-profile.mjs server/icc-profile-test-fixtures.mjs server/icc-profile-native-test.mjs ./'));
  assert.match(dockerfile,/COPY server\/icc-profile\.mjs[^\n]+\nUSER node\nCMD/);
  assert.ok(dockerfile.includes('FROM worker AS video-metadata'));
  assert.ok(dockerfile.includes('COPY server/video-metadata.mjs server/mp4-metadata.mjs server/webm-metadata.mjs ./'));
  assert.ok(dockerfile.includes('CMD ["node", "video-metadata-native-test.mjs"]'));
});
