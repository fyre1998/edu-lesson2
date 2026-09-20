/* Camera lifecycle is independent of the attachment destination. */
function createCameraCapture({ onConfirm, onFile }) {
  const find = id => document.getElementById(id);
  const dialog = find('cameraDialog'), video = find('cameraVideo'), photo = find('cameraPhoto');
  const status = find('cameraStatus'), placeholder = find('cameraPlaceholder');
  const shutter = find('cameraShutter'), confirm = find('cameraConfirm'), retry = find('cameraRetry');
  let stream = null, pendingPhoto = null, revision = 0, origin = null;
  let readyText = '检查照片是否清晰，可以重拍或确认上传。';
  const show = (element, visible) => element.classList.toggle('hidden', !visible);
  function stopStream() {
    if (stream) stream.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
  }
  function reset() {
    revision++;
    stopStream();
    pendingPhoto = null;
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
        if (request === revision && dialog.open && !pendingPhoto) error('摄像头已断开，请检查设备后重试，或上传文件。');
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
    const request = revision;
    shutter.disabled = true;
    photo.width = video.videoWidth;
    photo.height = video.videoHeight;
    try {
      photo.getContext('2d').drawImage(video, 0, 0);
      show(photo, true);
      show(video, false);
      show(shutter, false);
      show(retry, true);
      retry.textContent = '重拍';
      show(confirm, true);
      stopStream();
      status.textContent = '正在生成照片…';
      photo.toBlob(blob => {
        if (request !== revision || !dialog.open) return;
        if (!blob) { status.textContent = '照片生成失败，请重拍。'; return; }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        pendingPhoto = new File([blob], `实验照片-${stamp}.jpg`, { type: 'image/jpeg' });
        confirm.disabled = false;
        status.textContent = readyText;
      }, 'image/jpeg', 0.92);
    } catch {
      status.textContent = '照片生成失败，请重拍。';
      stopStream();
      show(shutter, false);
      show(retry, true);
      retry.textContent = '重拍';
    }
  });
  confirm.addEventListener('click', async () => {
    if (!pendingPhoto || confirm.disabled) return;
    const request = revision;
    confirm.disabled = true;
    status.textContent = '正在上传照片，请稍候…';
    try {
      const accepted = await onConfirm(pendingPhoto);
      if (request !== revision) return;
      if (accepted !== false) close();
      else { status.textContent = '照片尚未上传成功，请查看提示后重试。'; confirm.disabled = false; }
    } catch {
      if (request !== revision) return;
      status.textContent = '添加失败，请重试。';
      confirm.disabled = false;
    }
  });
  retry.addEventListener('click', start);
  find('cameraClose').addEventListener('click', close);
  find('cameraFile').addEventListener('click', () => { close(); onFile(); });
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
