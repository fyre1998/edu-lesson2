const {test}=require('node:test');
const assert=require('node:assert/strict');
const {read}=require('./chat-stream.js');
const event=(kind,data)=>`event: ${kind}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;
function response(chunks){return new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}}));}

test('shows text before the final response, decoding split Chinese and emoji bytes',async()=>{
  let controller;
  const stream=new ReadableStream({start(value){controller=value;}}),shown=[];
  const pending=read(new Response(stream),text=>shown.push(text));
  const first=new TextEncoder().encode(': keep-alive\r\n\r\n'+event('text',{text:'观察😀。'}));
  for(const byte of first)controller.enqueue(Uint8Array.of(byte));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(shown,['观察😀。']);
  controller.enqueue(new TextEncoder().encode(event('done',{id:1,answer:'观察😀。下一步？'})));
  assert.equal((await pending).answer,'观察😀。下一步？');
});

for(const ending of ['error','eof'])test(`partial ${ending} is never treated as a saved answer`,async()=>{
  const text=event('text',{text:'第一句。'})+(ending==='error'?event('error',{detail:'请重试',status:502}):'');
  const shown=[];
  await assert.rejects(read(response([new TextEncoder().encode(text)]),t=>shown.push(t)),/重试/);
  assert.deepEqual(shown,['第一句。']);
});
