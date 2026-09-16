const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, 'app-v2.js'), 'utf8');

function setup() {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      innerHTML: '', textContent: '', value: '', style: {}, disabled: false, readOnly: false,
      classList: { add() {}, remove() {}, contains() { return true; } },
      listeners: {},
      addEventListener(name, handler) { this.listeners[name] = handler; },
      insertAdjacentHTML(_, html) { this.innerHTML += html; },
      replaceChildren() { this.innerHTML = ''; },
    });
    return elements.get(selector);
  };
  let resolveRequest;
  const calls = [];
  const context = vm.createContext({
    document: { querySelector: element, querySelectorAll: () => [] },
    FormData, setTimeout: () => 1, clearTimeout() {},
    fetch: (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Promise(resolve => { resolveRequest = resolve; });
    },
  });
  vm.runInContext(source.slice(0, source.indexOf('\npopulateGroups();')), context);
  vm.runInContext("currentUser = {role:'student', name:'王晓彤', groupId:1};", context);
  return { element, calls, context, run: code => vm.runInContext(code, context),
    reply: (status, data) => resolveRequest({ ok: status < 400, status, json: async () => data }) };
}

test('student text appears before the AI request resolves and is not duplicated on success', async () => {
  const app = setup();
  app.element('#chatInput').value = '我看到了气泡';
  const pending = app.run('sendMessage()');
  assert.match(app.element('#messages').innerHTML, /我看到了气泡/);
  assert.match(app.element('#messages').innerHTML, /AI 正在思考/);
  assert.equal(app.element('#chatInput').value, '');
  assert.equal(app.element('#sendButton').disabled, true);
  await app.run('sendMessage()');
  assert.equal(app.calls.length, 1);
  app.reply(201, { question: '我看到了气泡', answer: '请描述更多现象。', images: [] });
  await pending;
  assert.equal(app.element('#messages').innerHTML.split('我看到了气泡').length - 1, 1);
  assert.match(app.element('#messages').innerHTML, /请描述更多现象/);
  assert.doesNotMatch(app.element('#messages').innerHTML, /AI 正在思考/);
  assert.equal(app.element('#sendButton').disabled, false);
});

test('image-only messages show the image immediately and send its stored ID', async () => {
  const app = setup();
  app.run("selectedImages.set('photo1', {id:'photo1', name:'实验.png', size:100, preview:true});");
  const pending = app.run('sendMessage()');
  assert.match(app.element('#messages').innerHTML, /photo1\?preview=true/);
  assert.match(app.element('#messages').innerHTML, /实验.png/);
  assert.equal(app.calls[0].body.image_ids[0], 'photo1');
  assert.equal(app.run('selectedImages.size'), 0);
  app.reply(502, { detail: 'AI 暂时不可用' });
  await pending;
  assert.match(app.element('#messages').innerHTML, /重试这条消息/);
  assert.match(app.element('#messages').innerHTML, /实验.png/);
  assert.equal(app.run('pendingMessage.images[0].id'), 'photo1');
  assert.equal(app.element('#sendButton').disabled, false);
});

test('background synchronization cannot replace a pending message', async () => {
  const app = setup();
  app.element('#chatInput').value = '等待中的问题';
  const pending = app.run('sendMessage()');
  await app.run('syncGroups()');
  assert.equal(app.calls.length, 1);
  assert.match(app.element('#messages').innerHTML, /等待中的问题/);
  app.reply(502, { detail: '回复超时' });
  await pending;
  assert.equal(app.run('pendingMessage.text'), '等待中的问题');
});

test('retry reuses the failed question and image without a second pending bubble', async () => {
  const app = setup();
  app.run(source.slice(source.indexOf("els.messages.addEventListener('click'"), source.indexOf("els.fileList.addEventListener('click'")));
  app.element('#chatInput').value = '请分析这张图';
  app.run("selectedImages.set('retry-photo', {id:'retry-photo', name:'实验.png', size:100, preview:true});");
  const pending = app.run('sendMessage()');
  app.reply(502, { detail: '服务繁忙' });
  await pending;
  app.element('#messages').listeners.click({ target: { closest: () => ({}) } });
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[1].body.message, '请分析这张图');
  assert.equal(app.calls[1].body.image_ids[0], 'retry-photo');
  assert.equal(app.element('#messages').innerHTML.split('请分析这张图').length - 1, 1);
  assert.doesNotMatch(app.element('#messages').innerHTML, /服务繁忙/);
  app.reply(201, {question:'请分析这张图', answer:'识图成功', images:[{id:'retry-photo',name:'实验.png'}]});
  await new Promise(resolve => setImmediate(resolve));
  assert.match(app.element('#messages').innerHTML, /识图成功/);
  assert.equal(app.run('pendingMessage'), null);
});
