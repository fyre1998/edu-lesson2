const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'paths.js'),'utf8');

function paths(src){
  const context=vm.createContext({URL,document:{currentScript:{src}}});
  vm.runInContext(source,context);
  return context.PublicPaths;
}

test('production classroom and workspace keep API and images inside lesson 2',()=>{
  for(const src of ['https://lsclass.top/lesson/paths.js?v=1','https://lsclass.top/lesson/classroom/paths.js','https://lsclass.top/lesson/workspace/paths.js']){
    const p=paths(src);
    assert.equal(p.prefix,'/lesson');
    assert.equal(p.url('/api/classroom/login'),'/lesson/api/classroom/login');
    assert.equal(p.url('/api/classroom/files/photo?preview=true'),'/lesson/api/classroom/files/photo?preview=true');
    assert.equal(p.url('/classroom/assets/image.png'),'/lesson/classroom/assets/image.png');
    assert.equal(p.url('/lesson/api/me'),'/lesson/api/me');
    assert.equal(p.url('https://example.com/image.png'),'https://example.com/image.png');
    assert.equal(p.url('blob:picture'),'blob:picture');
  }
});

test('local classroom and workspace retain their original unprefixed APIs',()=>{
  for(const src of ['http://127.0.0.1:8015/classroom/paths.js','http://127.0.0.1:8015/paths.js']){
    const p=paths(src);
    assert.equal(p.prefix,'');
    assert.equal(p.url('/api/classroom/login'),'/api/classroom/login');
  }
});
