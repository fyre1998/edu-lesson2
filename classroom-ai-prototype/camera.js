/* Camera lifecycle is independent of the attachment destination. */
function createCameraCapture({ onConfirm, onFile }) {
  const find = id => document.getElementById(id);
  const dialog = find('cameraDialog'), video = find('cameraVideo'), photo = find('cameraPhoto');
  const status = find('cameraStatus'), placeholder = find('cameraPlaceholder');
  const shutter = find('cameraShutter'), confirm = find('cameraConfirm'), retry = find('cameraRetry');
  const stage = find('cameraStage'), editor = find('cameraEditor'), fileButton = find('cameraFile');
  const zoomInput = find('cameraZoom'), zoomValue = find('cameraZoomValue');
  const zoomIn = find('cameraZoomIn'), zoomOut = find('cameraZoomOut'), restore = find('cameraRestore');
  let stream = null, originalPhoto = null, revision = 0, origin = null, busy = false, drag = null;
  let crop = { zoom: 1, x: 0, y: 0 };
  let readyText = '检查照片是否清晰，可以重拍或确认上传。';
  const show = (element, visible) => element.classList.toggle('hidden', !visible);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  function endDrag() {
    const pointer = drag?.id;
    drag = null;
    if (pointer !== undefined && photo.hasPointerCapture(pointer)) photo.releasePointerCapture(pointer);
    photo.classList.remove('is-dragging');
  }
  function updateControls() {
    zoomInput.value = Math.round(crop.zoom * 100);
    zoomValue.textContent = `${zoomInput.value}%`;
    zoomInput.disabled = restore.disabled = busy || !originalPhoto;
    zoomOut.disabled = busy || !originalPhoto || crop.zoom <= 1;
    zoomIn.disabled = busy || !originalPhoto || crop.zoom >= 4;
    retry.disabled = fileButton.disabled = busy;
    confirm.disabled = busy || !originalPhoto;
    photo.classList.toggle('is-zoomed', crop.zoom > 1 && !busy);
  }
  function fitPhoto() {
    if (!originalPhoto) return;
    const bounds = stage.getBoundingClientRect();
    const scale = Math.min(bounds.width / photo.width, bounds.height / photo.height);
    photo.style.width = `${photo.width * scale}px`;
    photo.style.height = `${photo.height * scale}px`;
  }
  function renderPhoto() {
    if (!originalPhoto) return;
    const width = originalPhoto.width / crop.zoom, height = originalPhoto.height / crop.zoom;
    crop.x = clamp(crop.x, 0, originalPhoto.width - width);
    crop.y = clamp(crop.y, 0, originalPhoto.height - height);
    // Always redraw from the unmodified capture, so repeated adjustments do not degrade it.
    photo.getContext('2d').drawImage(originalPhoto, crop.x, crop.y, width, height, 0, 0, photo.width, photo.height);
    updateControls();
  }
  function setZoom(value, anchorX = 0.5, anchorY = 0.5) {
    if (!originalPhoto || busy || !Number.isFinite(value)) return;
    const zoom = clamp(value, 1, 4);
    crop.x += anchorX * originalPhoto.width * (1 / crop.zoom - 1 / zoom);
    crop.y += anchorY * originalPhoto.height * (1 / crop.zoom - 1 / zoom);
    crop.zoom = zoom;
    renderPhoto();
  }
  function restorePhoto() {
    if (!originalPhoto || busy) return;
    endDrag();
    crop = { zoom: 1, x: 0, y: 0 };
    renderPhoto();
  }
  zoomInput.addEventListener('input', () => setZoom(Number(zoomInput.value) / 100));
  zoomIn.addEventListener('click', () => setZoom(crop.zoom * 1.2));
  zoomOut.addEventListener('click', () => setZoom(crop.zoom / 1.2));
  restore.addEventListener('click', restorePhoto);
  photo.addEventListener('wheel', event => {
    if (!originalPhoto) return;
    event.preventDefault();
    if (busy) return;
    endDrag();
    const bounds = photo.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1;
    setZoom(crop.zoom * Math.exp(-clamp(event.deltaY * unit, -100, 100) * 0.002),
      clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
      clamp((event.clientY - bounds.top) / bounds.height, 0, 1));
  }, { passive: false });
  photo.addEventListener('pointerdown', event => {
    if (!originalPhoto || busy || crop.zoom <= 1 || event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    photo.focus({ preventScroll: true });
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    photo.setPointerCapture(event.pointerId);
    photo.classList.add('is-dragging');
  });
  photo.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId || busy || !originalPhoto) return;
    const bounds = photo.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    crop.x -= (event.clientX - drag.x) / bounds.width * originalPhoto.width / crop.zoom;
    crop.y -= (event.clientY - drag.y) / bounds.height * originalPhoto.height / crop.zoom;
    drag.x = event.clientX; drag.y = event.clientY;
    renderPhoto();
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(name => photo.addEventListener(name, event => {
    if (drag?.id === event.pointerId) endDrag();
  }));
  photo.addEventListener('keydown', event => {
    if (!originalPhoto || busy) return;
    const directions = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (!['+', '=', '-', '0', ...Object.keys(directions)].includes(event.key)) return;
    event.preventDefault();
    if (event.key === '0') return restorePhoto();
    if (event.key === '+' || event.key === '=') return setZoom(crop.zoom * 1.2);
    if (event.key === '-') return setZoom(crop.zoom / 1.2);
    const [dx, dy] = directions[event.key], step = event.shiftKey ? 0.1 : 0.025;
    crop.x += dx * originalPhoto.width / crop.zoom * step;
    crop.y += dy * originalPhoto.height / crop.zoom * step;
    renderPhoto();
  });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fitPhoto).observe(stage);
  window.addEventListener('resize', fitPhoto);
  function stopStream() {
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
  }
  function reset() {
    revision++;
    stopStream();
    endDrag();
    if (originalPhoto) originalPhoto.width = originalPhoto.height = 0;
    originalPhoto = null;
    busy = false;
    crop = { zoom: 1, x: 0, y: 0 };
    show(editor, false);
    updateControls();
    photo.width = photo.height = 0;
  }
  function close() {
    reset();
    if (dialog.open) dialog.close();
    origin?.focus();
  }
  function error(message) {
    stopStream();
    show(video, false);
    show(placeholder, true);
    placeholder.textContent = '暂时无法拍照';
    status.textContent = message;
    shutter.disabled = true;
    show(shutter, false);
    show(retry, true);
    retry.textContent = '重试';
  }
  async function start() {
    reset();
    const request = revision;
    show(photo, false);
    show(video, false);
    show(placeholder, true);
    show(confirm, false);
    show(retry, false);
    show(shutter, true);
    shutter.disabled = confirm.disabled = true;
    placeholder.textContent = '正在准备摄像头…';
    status.textContent = '请允许浏览器使用摄像头。';
    if (!window.isSecureContext) return error('当前地址不支持拍照，请使用 HTTPS 或本机 localhost 打开，也可以选择上传文件。');
    if (!navigator.mediaDevices?.getUserMedia) return error('当前浏览器不支持调用摄像头，请用新版 Chrome、Edge 或选择上传文件。');
    try {
      const incoming = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      // Permission may resolve after the dialog was closed or reopened.
      if (request !== revision || !dialog.open) { incoming.getTracks().forEach(track => track.stop()); return; }
      stream = incoming;
      video.srcObject = stream;
      show(video, true);
      await video.play();
      if (request !== revision || !dialog.open) return;
      show(placeholder, false);
      shutter.disabled = !(video.videoWidth && video.videoHeight);
      status.textContent = '将实验记录放入画面，准备好后点击“拍摄”。';
      stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
        if (request === revision && dialog.open && !originalPhoto) error('摄像头已断开，请检查设备后重试，或上传文件。');
      }));
    } catch (failure) {
      if (request !== revision || !dialog.open) return;
      const messages = {
        NotAllowedError: '未获得摄像头权限。请在浏览器的网站设置中允许摄像头后重试，或上传文件。',
        NotFoundError: '没有检测到摄像头，请连接摄像头后重试，或上传文件。',
        NotReadableError: '摄像头可能被其他程序占用，请关闭占用程序后重试，或上传文件。'
      };
      error(messages[failure.name] || '摄像头暂时无法启动，请检查设备和浏览器权限后重试，或上传文件。');
    }
  }
  video.addEventListener('loadeddata', () => {
    if (stream && dialog.open) shutter.disabled = !(video.videoWidth && video.videoHeight);
  });
  shutter.addEventListener('click', () => {
    if (!stream || !video.videoWidth || !video.videoHeight || shutter.disabled) return;
    shutter.disabled = true;
    photo.width = video.videoWidth;
    photo.height = video.videoHeight;
    try {
      originalPhoto = document.createElement('canvas');
      originalPhoto.width = photo.width;
      originalPhoto.height = photo.height;
      originalPhoto.getContext('2d').drawImage(video, 0, 0);
      crop = { zoom: 1, x: 0, y: 0 };
      renderPhoto();
      show(photo, true);
      show(editor, true);
      show(video, false);
      show(shutter, false);
      show(retry, true);
      retry.textContent = '重拍';
      show(confirm, true);
      stopStream();
      fitPhoto();
      status.textContent = readyText;
    } catch {
      reset();
      show(photo, false);
      show(video, false);
      show(placeholder, true);
      placeholder.textContent = '暂时无法生成照片';
      show(confirm, false);
      status.textContent = '照片生成失败，请重拍。';
      show(shutter, false);
      show(retry, true);
      retry.textContent = '重拍';
    }
  });
  confirm.addEventListener('click', async () => {
    if (!originalPhoto || busy || confirm.disabled) return;
    const request = revision;
    endDrag();
    busy = true;
    updateControls();
    status.textContent = '正在生成调整后的照片…';
    try {
      // Encode the visible crop only after confirmation, never the original capture.
      const blob = await new Promise(resolve => photo.toBlob(resolve, 'image/jpeg', 0.92));
      if (request !== revision || !dialog.open) return;
      if (!blob) throw new Error('照片生成失败，请重试或重拍。');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = new File([blob], `实验照片-${stamp}.jpg`, { type: 'image/jpeg' });
      status.textContent = '正在上传照片，请稍候…';
      const accepted = await onConfirm(file);
      if (request !== revision) return;
      if (accepted !== false) close();
      else status.textContent = '照片尚未上传成功，请查看提示后重试；也可继续调整。';
    } catch {
      if (request !== revision) return;
      status.textContent = '照片生成或上传失败，请重试或重拍。';
    } finally {
      if (request === revision) { busy = false; updateControls(); }
    }
  });
  retry.addEventListener('click', () => { if (!busy) start(); });
  find('cameraClose').addEventListener('click', close);
  fileButton.addEventListener('click', () => { if (!busy) { close(); onFile(); } });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => { if (!dialog.open) reset(); });
  window.addEventListener('pagehide', close);
  document.addEventListener('visibilitychange', () => { if (document.hidden && dialog.open) close(); });
  return { open(options = {}) {
    if (dialog.open) return;
    confirm.textContent = options.confirmText || '确认上传';
    readyText = options.readyText || '检查照片是否清晰，可以重拍或确认上传。';
    origin = document.activeElement; dialog.showModal(); start();
  }, close };
}
