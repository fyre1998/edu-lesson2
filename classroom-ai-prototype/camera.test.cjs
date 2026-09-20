const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, 'camera.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function setup(getUserMedia, secure = true) {
  class Element {
    constructor() {
      this.listeners = {}; this.hiddenClasses = new Set();
      this.classList = { toggle: (key, add) => add ? this.hiddenClasses.add(key) : this.hiddenClasses.delete(key) };
      this.videoWidth = 1280; this.videoHeight = 720; this.disabled = false; this.open = false;
    }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    async fire(name, event = {}) { for (const callback of this.listeners[name] || []) await callback(event); }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire('close'); }
    focus() {}
    async play() {}
    getContext() { return { drawImage() {} }; }
    toBlob(callback) { callback(new Blob(['photo'], { type: 'image/jpeg' })); }
  }
  const elements = new Map(), window = new Element(), document = new Element(), accepted = [];
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  document.activeElement = new Element();
  window.isSecureContext = secure;
  const context = vm.createContext({ window, document, navigator: { mediaDevices: { getUserMedia } }, File, Date });
  vm.runInContext(source, context);
  let fileRequests = 0;
  const camera = context.createCameraCapture({ onConfirm: file => accepted.push(file), onFile: () => fileRequests++ });
  return { camera, elements, accepted, document, get fileRequests() { return fileRequests; } };
}
function fakeStream() {
  const track = { stopped: false, stop() { this.stopped = true; }, addEventListener() {} };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}
test('capture keeps JPEG for confirmation and stops the camera immediately', async () => {
  const stream = fakeStream();
  const app = setup(async constraints => { assert.equal(constraints.audio, false); return stream; });
  app.camera.open(); await settle();
  assert.equal(app.elements.get('cameraShutter').disabled, false);
  await app.elements.get('cameraShutter').fire('click');
  assert.equal(stream.track.stopped, true);
  assert.equal(app.accepted.length, 0);
  await app.elements.get('cameraConfirm').fire('click');
  assert.equal(app.accepted.length, 1);
  assert.equal(app.accepted[0].type, 'image/jpeg');
  assert.match(app.accepted[0].name, /\.jpg$/);
  assert.equal(app.elements.get('cameraDialog').open, false);
});

test('camera describes automatic AI submission while keeping retake and cancel before confirmation', async () => {
  const app = setup(async () => fakeStream());
  app.camera.open({confirmText:'确认并交给 AI',readyText:'确认后照片自动交给 AI。'});await settle();
  await app.elements.get('cameraShutter').fire('click');
  assert.equal(app.elements.get('cameraConfirm').textContent,'确认并交给 AI');
  assert.equal(app.elements.get('cameraStatus').textContent,'确认后照片自动交给 AI。');
  assert.equal(app.accepted.length,0);
  app.camera.close();assert.equal(app.accepted.length,0);
  app.camera.open();await settle();
  assert.equal(app.elements.get('cameraConfirm').textContent,'确认上传');
});
test('late permission after close cannot leave the camera running', async () => {
  let resolve;
  const app = setup(() => new Promise(done => { resolve = done; }));
  app.camera.open(); app.camera.close();
  const stream = fakeStream(); resolve(stream); await settle();
  assert.equal(stream.track.stopped, true);
  assert.equal(app.elements.get('cameraVideo').srcObject, null);
});
test('stale request cannot replace a newly opened camera', async () => {
  const pending = [];
  const app = setup(() => new Promise(resolve => pending.push(resolve)));
  app.camera.open(); app.camera.close(); app.camera.open();
  const old = fakeStream(), current = fakeStream();
  pending[1](current); await settle(); pending[0](old); await settle();
  assert.equal(old.track.stopped, true);
  assert.equal(current.track.stopped, false);
  assert.equal(app.elements.get('cameraVideo').srcObject, current);
  app.camera.close(); assert.equal(current.track.stopped, true);
});
test('permission rejection has a file fallback', async () => {
  const app = setup(async () => { throw { name: 'NotAllowedError' }; });
  app.camera.open(); await settle();
  assert.match(app.elements.get('cameraStatus').textContent, /权限/);
  assert.equal(app.elements.get('cameraShutter').disabled, true);
  await app.elements.get('cameraFile').fire('click');
  assert.equal(app.fileRequests, 1);
  assert.equal(app.elements.get('cameraDialog').open, false);
});
test('insecure origin never requests camera access', async () => {
  let requested = false;
  const app = setup(async () => { requested = true; return fakeStream(); }, false);
  app.camera.open(); await settle();
  assert.equal(requested, false);
  assert.match(app.elements.get('cameraStatus').textContent, /HTTPS/);
});
test('retake discards the first photo and page hiding stops the new stream', async () => {
  const streams = [];
  const app = setup(async () => { const stream = fakeStream(); streams.push(stream); return stream; });
  app.camera.open(); await settle();
  await app.elements.get('cameraShutter').fire('click');
  await app.elements.get('cameraRetry').fire('click'); await settle();
  assert.equal(streams.length, 2);
  assert.equal(app.elements.get('cameraConfirm').disabled, true);
  assert.equal(app.accepted.length, 0);
  app.document.hidden = true; await app.document.fire('visibilitychange');
  assert.equal(streams[1].track.stopped, true);
  assert.equal(app.elements.get('cameraDialog').open, false);
});
