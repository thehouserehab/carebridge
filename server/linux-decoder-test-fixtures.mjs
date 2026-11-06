import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { Pool } from 'pg';
import { databaseFromPool } from './database.mjs';
import { linuxDecoderRuntime } from './linux-decoder-runtime.mjs';
// Fixed public test CLI artifact only, NOT an operating-service default.
export const TEST_LINUX_CLI_SHA256 = '9c46230f41e4263b3a9d93ae9284722709923c50d138bc64eed2bb6c02af0581';
export function syntheticPng() {
  const chunk = (name,bytes) => {
    const result = Buffer.alloc(bytes.length+12); result.writeUInt32BE(bytes.length); result.write(name,4,'ascii'); bytes.copy(result,8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4,-4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0,result.length-4); return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(32); header.writeUInt32BE(24,4); header[8] = 8; header[9] = 2;
  const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(24*(1+32*3)))),chunk('IEND',Buffer.alloc(0))]);
  return { bytes,type:'image/png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex') };
}
export const syntheticInput = (fixture = syntheticPng(),changes = {}) => ({ type:fixture.type,size:fixture.size,sha256:fixture.sha256,
  stream:Readable.from([fixture.bytes],{ objectMode:false }),...changes });
export function testDatabaseOptions(database) {
  const password = process.env.CAREBRIDGE_FIXTURE_PASSWORD;
  if (!/^[a-f0-9]{64}$/.test(password ?? '') || !/^(postgres|carebridge_it_[a-f0-9]{32})$/.test(database ?? '')) throw new Error('LINUX_DECODER_TEST_CONFIGURATION');
  return { host:'127.0.0.1',port:5432,database,user:'carebridge_fixture_admin',password,ssl:false,max:2,
    connectionTimeoutMillis:4000,idleTimeoutMillis:1000,query_timeout:15000,options:'-c statement_timeout=10000 -c lock_timeout=5000' };
}
export function testDatabase(database) { return databaseFromPool(new Pool(testDatabaseOptions(database))); }
export function testRuntime(configuration = {}) {
  return linuxDecoderRuntime({ cliPath:'/usr/local/bin/docker',cliSha256:TEST_LINUX_CLI_SHA256,socketPath:'/run/carebridge-engine/docker.sock',socketOwnerUid:0,
    engineIdentity:process.env.CAREBRIDGE_LINUX_TEST_ENGINE,approvedImageId:process.env.CAREBRIDGE_LINUX_TEST_IMAGE,...configuration });
}
