const assert = require('node:assert/strict');
const {openAsBlob} = require('node:fs');
const path = require('node:path');
(async()=>{
  const {readMediaFileMetadata,MAX_METADATA_SCAN_BYTES} = await import('../src/services/mediaMetadata.js');
  const sync = n => Buffer.from([(n>>21)&127,(n>>14)&127,(n>>7)&127,n&127]);
  const frame = (id,data) => {const h=Buffer.alloc(10);h.write(id);h.writeUInt32BE(data.length,4);return Buffer.concat([h,data]);};
  const picture=Buffer.from([255,216,255,224,5,4,3,255,217]);
  const body=Buffer.concat([frame('TIT2',Buffer.from('\0WAV title')),frame('APIC',Buffer.concat([Buffer.from('\0image/jpeg\0\x03\0'),picture]))]);
  const tag=Buffer.concat([Buffer.from('ID3\x03\0\0','binary'),sync(body.length),body]);
  const pcmSize=128*1024*1024;
  const riff=Buffer.alloc(20);riff.write('RIFF');riff.writeUInt32LE(12+pcmSize+8+tag.length+(tag.length&1),4);riff.write('WAVE',8);riff.write('data',12);riff.writeUInt32LE(pcmSize,16);
  const tagOffset=20+pcmSize;const chunk=Buffer.alloc(8);chunk.write('id3 ');chunk.writeUInt32LE(tag.length,4);
  const pieces=[[0,riff],[tagOffset,Buffer.concat([chunk,tag,Buffer.alloc(tag.length&1)])]];
  let bytesRead=0;
  const file={name:'fixture.wav',type:'audio/wav',size:tagOffset+8+tag.length+(tag.length&1),slice(start,end){
    assert.ok(end-start<=MAX_METADATA_SCAN_BYTES);bytesRead+=end-start;
    const result=Buffer.alloc(Math.max(0,Math.min(end,this.size)-start));
    for(const [at,bytes] of pieces){const a=Math.max(at,start),b=Math.min(at+bytes.length,end);if(b>a)bytes.copy(result,a-start,a-at,b-at);}
    return {arrayBuffer:async()=>result.buffer.slice(result.byteOffset,result.byteOffset+result.byteLength)};
  }};
  const result=await readMediaFileMetadata(file);
  assert.equal(result.meta.title,'WAV title');assert.deepEqual(Buffer.from(await result.albumBlob.arrayBuffer()),picture);
  assert.ok(bytesRead<2048,'must skip 128 MiB PCM and read only chunk headers/tags');
  const broken=Buffer.from(riff);broken.writeUInt32LE(0xfffffff0,16);pieces[0]=[0,broken];
  assert.equal((await readMediaFileMetadata(file)).albumBlob,null,'invalid chunk must stop traversal');
  for(const source of process.argv.slice(2)){
    const blob=await openAsBlob(source);Object.defineProperty(blob,'name',{value:path.basename(source)});
    const actual=await readMediaFileMetadata(blob);
    assert.ok(actual.albumBlob?.size>1000,'real WAV embedded art missing');
    console.log(path.basename(source),JSON.stringify(actual.meta),'cover',actual.albumBlob.size,actual.albumBlob.type);
  }
  console.log('WAV metadata: trailing ID3 artwork, bounded reads, and malformed chunk checks passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
