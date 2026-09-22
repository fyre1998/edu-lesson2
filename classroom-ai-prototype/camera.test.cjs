const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, 'camera.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function setup(getUserMedia, secure = true, onConfirm) {
  class Element {
    constructor() {
      this.listeners = {}; this.hiddenClasses = new Set();
      this.classList = {
        toggle: (key, add) => add ? this.hiddenClasses.add(key) : this.hiddenClasses.delete(key),
        add: key => this.hiddenClasses.add(key), remove: key => this.hiddenClasses.delete(key)
      };
      this.videoWidth = 1280; this.videoHeight = 720; this.disabled = false; this.open = false;
      this.style = {}; this.pointers = new Set(); this.draws = []; this.exports = [];
    }
    addEventListener(name, callback) { (this.listeners[name] ||= []).push(callback); }
    async fire(name, event = {}) { for (const callback of this.listeners[name] || []) await callback(event); }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire('close'); }
    focus() {}
    async play() {}
    getBoundingClientRect() { return { left: 20, top: 30, width: 640, height: 360 }; }
    setPointerCapture(id) { this.pointers.add(id); }
    hasPointerCapture(id) { return this.pointers.has(id); }
    releasePointerCapture(id) { this.pointers.delete(id); }
    getContext() { return { drawImage: (...args) => this.draws.push(args) }; }
    toBlob(callback, type, quality) {
      this.exports.push({ type, quality });
      callback(new Blob([JSON.stringify(this.draws.at(-1).slice(1))], { type }));
    }
  }
  const elements = new Map(), window = new Element(), document = new Element(), accepted = [];
  document.getElementById = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  document.createElement = () => new Element();
  document.activeElement = new Element();
  window.isSecureContext = secure;
  const context = vm.createContext({ window, document, navigator: { mediaDevices: { getUserMedia } }, File, Date });
  vm.runInContext(source, context);
  let fileRequests = 0;
  const camera = context.createCameraCapture({ onConfirm: file => { accepted.push(file); return onConfirm?.(file); }, onFile: () => fileRequests++ });
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

const event = overrides => ({ preventDefault() {}, ...overrides });
async function capture(app) {
  app.camera.open(); await settle();
  await app.elements.get('cameraShutter').fire('click');
  return app.elements.get('cameraPhoto');
}
async function zoom(app, percentage) {
  const input = app.elements.get('cameraZoom');
  input.value = String(percentage); await input.fire('input');
}

test('confirmation encodes the adjusted crop, and restore returns the entire original image', async () => {
  const app = setup(async () => fakeStream());
  const photo = await capture(app);
  assert.equal(photo.exports.length, 0);
  assert.equal(app.elements.get('cameraEditor').hiddenClasses.has('hidden'), false);
  await zoom(app, 200);
  assert.deepEqual(photo.draws.at(-1).slice(1), [320, 180, 640, 360, 0, 0, 1280, 720]);
  await app.elements.get('cameraRestore').fire('click');
  assert.deepEqual(photo.draws.at(-1).slice(1), [0, 0, 1280, 720, 0, 0, 1280, 720]);
  await zoom(app, 200);
  const visible = photo.draws.at(-1).slice(1), original = photo.draws[0][0];
  assert.ok(photo.draws.every(draw => draw[0] === original && draw[0] !== photo));
  await app.elements.get('cameraConfirm').fire('click');
  assert.deepEqual(JSON.parse(await app.accepted[0].text()), visible);
  assert.deepEqual(photo.exports, [{ type: 'image/jpeg', quality: 0.92 }]);
});

test('wheel zoom stays anchored at the pointer and never zooms beyond 100–400 percent', async () => {
  const app = setup(async () => fakeStream()), photo = await capture(app);
  let prevented = false;
  await photo.fire('wheel', event({ deltaY: -100, deltaMode: 0, clientX: 180, clientY: 300, preventDefault() { prevented = true; } }));
  const [x, y, width, height] = photo.draws.at(-1).slice(1);
  assert.ok(Math.abs(x + width * 0.25 - 320) < 1e-8);
  assert.ok(Math.abs(y + height * 0.75 - 540) < 1e-8);
  assert.equal(prevented, true);
  for (let i = 0; i < 15; i++) await photo.fire('wheel', event({ deltaY: -100, deltaMode: 1, clientX: 180, clientY: 300 }));
  assert.equal(app.elements.get('cameraZoomValue').textContent, '400%');
  assert.equal(app.elements.get('cameraZoomIn').disabled, true);
  for (let i = 0; i < 15; i++) await photo.fire('wheel', event({ deltaY: 1, deltaMode: 2, clientX: 180, clientY: 300 }));
  assert.equal(app.elements.get('cameraZoomValue').textContent, '100%');
  assert.deepEqual(photo.draws.at(-1).slice(1, 5), [0, 0, 1280, 720]);
});

test('drag moves the crop, clamps all edges without blank space and ends on pointer cancel', async () => {
  const app = setup(async () => fakeStream()), photo = await capture(app);
  await zoom(app, 200);
  await photo.fire('pointerdown', event({ pointerId: 1, button: 0, clientX: 340, clientY: 210 }));
  await photo.fire('pointermove', { pointerId: 1, clientX: 440, clientY: 260 });
  assert.deepEqual(photo.draws.at(-1).slice(1, 5), [220, 130, 640, 360]);
  await photo.fire('pointermove', { pointerId: 1, clientX: -10000, clientY: -10000 });
  assert.deepEqual(photo.draws.at(-1).slice(1, 5), [640, 360, 640, 360]);
  await photo.fire('pointermove', { pointerId: 1, clientX: 10000, clientY: 10000 });
  assert.deepEqual(photo.draws.at(-1).slice(1, 5), [0, 0, 640, 360]);
  await photo.fire('pointercancel', { pointerId: 1 });
  const drawCount = photo.draws.length;
  await photo.fire('pointermove', { pointerId: 1, clientX: 0, clientY: 0 });
  assert.equal(photo.draws.length, drawCount);
  assert.equal(photo.pointers.size, 0);
});

test('keyboard adjustments and retake reset work without a mouse wheel', async () => {
  const app = setup(async () => fakeStream()), photo = await capture(app);
  await photo.fire('keydown', event({ key: '+' }));
  assert.equal(app.elements.get('cameraZoomValue').textContent, '120%');
  const previousX = photo.draws.at(-1)[1];
  await photo.fire('keydown', event({ key: 'ArrowRight' }));
  assert.ok(photo.draws.at(-1)[1] < previousX);
  await photo.fire('keydown', event({ key: '0' }));
  assert.equal(app.elements.get('cameraZoomValue').textContent, '100%');
  await zoom(app, 300);
  await app.elements.get('cameraRetry').fire('click'); await settle();
  assert.equal(app.elements.get('cameraEditor').hiddenClasses.has('hidden'), true);
  await app.elements.get('cameraShutter').fire('click');
  assert.deepEqual(photo.draws.at(-1).slice(1, 5), [0, 0, 1280, 720]);
  assert.equal(app.accepted.length, 0);
});

test('upload freezes adjustments and prevents duplicate uploads, then permits correction after failure', async () => {
  let finish;
  const app = setup(async () => fakeStream(), true, () => new Promise(resolve => { finish = resolve; }));
  const photo = await capture(app); await zoom(app, 200);
  const upload = app.elements.get('cameraConfirm').fire('click'); await settle();
  assert.equal(app.accepted.length, 1);
  assert.equal(app.elements.get('cameraRetry').disabled, true);
  assert.equal(app.elements.get('cameraZoom').disabled, true);
  const drawCount = photo.draws.length;
  await zoom(app, 400);
  await app.elements.get('cameraConfirm').fire('click');
  await app.elements.get('cameraRetry').fire('click');
  assert.equal(photo.draws.length, drawCount);
  assert.equal(app.accepted.length, 1);
  finish(false); await upload;
  assert.equal(app.elements.get('cameraDialog').open, true);
  assert.equal(app.elements.get('cameraConfirm').disabled, false);
  assert.equal(app.elements.get('cameraZoomValue').textContent, '200%');
  await zoom(app, 300);
  assert.equal(app.elements.get('cameraZoomValue').textContent, '300%');
});

test('closing during JPEG encoding prevents stale upload into a reopened camera', async () => {
  const app = setup(async () => fakeStream()), photo = await capture(app);
  let encode;
  photo.toBlob = callback => { encode = callback; };
  const upload = app.elements.get('cameraConfirm').fire('click');
  app.camera.close(); app.camera.open(); await settle();
  encode(new Blob(['old photo'], { type: 'image/jpeg' })); await upload;
  assert.equal(app.accepted.length, 0);
  assert.equal(app.elements.get('cameraDialog').open, true);
  assert.equal(app.elements.get('cameraConfirm').disabled, true);
  assert.equal(app.elements.get('cameraShutter').disabled, false);
});

test('failed JPEG encoding retains the crop for retry and never uploads an empty photo', async () => {
  const app = setup(async () => fakeStream()), photo = await capture(app);
  await zoom(app, 200);
  photo.toBlob = callback => callback(null);
  await app.elements.get('cameraConfirm').fire('click');
  assert.equal(app.accepted.length, 0);
  assert.equal(app.elements.get('cameraDialog').open, true);
  assert.equal(app.elements.get('cameraConfirm').disabled, false);
  assert.equal(app.elements.get('cameraZoomValue').textContent, '200%');
  assert.match(app.elements.get('cameraStatus').textContent, /失败/);
});
