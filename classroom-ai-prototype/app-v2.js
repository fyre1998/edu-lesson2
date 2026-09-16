const groups = [
  ['王晓彤', '赵文博', '许佳宁', '江子航'], ['孙语桐', '章明宇', '董欣然', '徐一帆'],
  ['林小雨', '陈思远', '周可欣', '蒋子墨'], ['吴思齐', '郑安然', '冯嘉树', '何若琳'],
  ['孔令仪', '曹煜城', '严舒宁', '华景行'], ['金悦', '魏承泽', '陶乐然', '姜予安']
].map((members, index) => ({ id: index + 1, members, files: [], chat: [], status: 'attention', statusText: '尚未提问' }));

const teachers = ['沈老师', '王老师'];
const memberRoles = ['记录员', '实验员', '汇报员', '提问者'];
const avatarColors = ['coral', 'mint', 'blue', 'gold'];
let currentUser = null;
let loginRole = 'student';
let selectedGroupId = 3;
let syncing = false, sending = false, uploading = false, sessionVersion = 0, lastSnapshot = '';
const selectedImages = new Map();
let pendingMessage = null;

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const els = {
  loginScreen: $('#loginScreen'), loginForm: $('#loginForm'), loginRoleTabs: $('#loginRoleTabs'),
  loginGroupField: $('#loginGroupField'), loginGroup: $('#loginGroup'), loginAccount: $('#loginAccount'),
  loginAccountLabel: $('#loginAccountLabel'), loginSubmit: $('#loginSubmit'), classCode: $('#classCode'),
  studentView: $('#studentView'), teacherView: $('#teacherView'), placeholderView: $('#placeholderView'),
  pageTitle: $('#pageTitle'), roleToggle: $('#roleToggle'), profileButton: $('#profileButton'),
  profileName: $('#profileName'), profileRole: $('#profileRole'), roleMenu: $('#roleMenu'),
  messages: $('#messages'), chatInput: $('#chatInput'), sendButton: $('#sendButton'),
  fileInput: $('#fileInput'), sideFileInput: $('#sideFileInput'), uploadPreview: $('#uploadPreview'),
  fileList: $('#fileList'), fileCount: $('#fileCount'), groupGrid: $('#groupGrid'),
  inspectEmpty: $('#inspectEmpty'), inspectContent: $('#inspectContent'), inspectTitle: $('#inspectTitle'),
  inspectMembers: $('#inspectMembers'), inspectProgress: $('#inspectProgress'), progressBar: $('#progressBar'),
  miniChat: $('#miniChat'), presentationMode: $('#presentationMode'), presentationGroup: $('#presentationGroup'),
  presentationChat: $('#presentationChat'), toast: $('#toast')
};

async function api(path, options = {}) {
  const headers = { 'X-Workbench': '1' };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch('/api/classroom' + path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') resetSession();
    throw new Error(typeof data.detail === 'string' ? data.detail : '请求失败，请稍后重试');
  }
  return data;
}

function resetSession() {
  sessionVersion++;
  lastSnapshot = '';
  currentUser = null;
  pendingMessage = null;
  $('.app-shell').classList.add('hidden');
  els.chatInput.value = '';
  selectedImages.clear();
  els.uploadPreview.replaceChildren();
  $('#sendState').textContent = '文字和选中的图片将发送给 AI；可结合近期已发送图片追问。';
  groups.forEach(group => { group.files = []; group.chat = []; });
  els.messages.replaceChildren();
  els.fileList.replaceChildren();
  els.miniChat.replaceChildren();
  $('#teacherFileList').replaceChildren();
  els.groupGrid.replaceChildren();
  els.presentationChat.replaceChildren();
  els.presentationMode.classList.add('hidden');
  els.studentView.classList.add('hidden');
  els.teacherView.classList.add('hidden');
  showLogin(false);
}

async function syncGroups() {
  if (!currentUser || syncing) return;
  if (currentUser.role === 'student' && sending) return;
  syncing = true;
  const version = sessionVersion;
  try {
    const data = await api('/groups');
    if (!currentUser || version !== sessionVersion) return;
    $('#syncState').textContent = '已同步 · ' + new Date().toLocaleTimeString('zh-CN');
    const snapshot = JSON.stringify(data);
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;
    for (const updated of data) {
      const group = groupById(updated.id);
      Object.assign(group, updated);
      group.files = updated.files.map(file => ({ ...file,
        type: file.preview ? 'IMG' : file.name.split('.').pop().toUpperCase(),
        meta: `${file.uploader} · ${(file.size / 1024).toFixed(1)} KB · ${new Date(file.created * 1000).toLocaleString('zh-CN')}`,
        previewUrl: file.preview ? `/api/classroom/files/${file.id}?preview=true` : null
      }));
    }
    if (currentUser.role === 'teacher') {
      renderMetrics();
      renderGroups($('#filterTabs .active')?.dataset.filter || 'all');
      if (selectedGroupId) selectGroup(selectedGroupId);
      if (!els.presentationMode.classList.contains('hidden')) openPresentation();
    } else {
      renderStudentWorkspace();
    }
    $('#syncState').textContent = '已同步 · ' + new Date().toLocaleTimeString('zh-CN');
  } finally { syncing = false; }
}

function fileHtml(file) {
  const url = '/api/classroom/files/' + encodeURIComponent(file.id);
  const select = currentUser?.role === 'student' && file.preview
    ? `<button type="button" class="image-select" data-image-id="${escapeHtml(file.id)}" aria-pressed="${selectedImages.has(file.id)}" ${sending ? 'disabled' : ''}>${selectedImages.has(file.id) ? '已选图片' : '发给 AI'}</button>` : '';
  return `<div class="file-item">${file.previewUrl ? `<a href="${url}?preview=true" target="_blank" rel="noopener"><img class="file-thumbnail" src="${escapeHtml(file.previewUrl)}" alt="${escapeHtml(file.name)}" /></a>` : `<span class="file-icon doc">${escapeHtml(file.type)}</span>`}<p><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.meta)}</small></p><div class="file-actions"><a class="file-download" href="${url}" download="${escapeHtml(file.name)}">下载</a>${select}</div></div>`;
}

function messageImages(message) {
  return (message.images || []).length ? `<div class="message-images">${message.images.map(file => `<a href="/api/classroom/files/${encodeURIComponent(file.id)}?preview=true" target="_blank" rel="noopener"><img src="/api/classroom/files/${encodeURIComponent(file.id)}?preview=true" alt="${escapeHtml(file.name)}" loading="lazy" /><span>${escapeHtml(file.name)}</span></a>`).join('')}</div>` : '';
}

function selectImage(file) {
  if (selectedImages.has(file.id)) return true;
  if (selectedImages.size >= 4 || [...selectedImages.values()].reduce((sum, image) => sum + image.size, file.size) > 20 * 1024 * 1024) {
    return false;
  }
  selectedImages.set(file.id, file);
  return true;
}

function renderSelectedImages() {
  els.uploadPreview.innerHTML = [...selectedImages.values()].map(file => `<div class="pending-image"><img src="/api/classroom/files/${encodeURIComponent(file.id)}?preview=true" alt="${escapeHtml(file.name)}" /><span>${escapeHtml(file.name)}</span><button type="button" data-remove-image="${escapeHtml(file.id)}" aria-label="移除图片 ${escapeHtml(file.name)}" ${sending ? 'disabled' : ''}>×</button></div>`).join('');
  $('#imageSelectionHint').textContent = selectedImages.size ? `待发送 ${selectedImages.size}/4 张图片 · 点击发送后交给 AI` : '拍照或上传图片后可发送给 AI，也可从资料夹选择。';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

function groupById(id) {
  return groups.find(group => group.id === Number(id));
}

function populateGroups() {
  els.loginGroup.innerHTML = groups.map(group => `<option value="${group.id}">第 ${group.id} 组</option>`).join('');
}

function populateAccounts() {
  const accounts = loginRole === 'teacher' ? teachers : groupById(els.loginGroup.value || 1).members;
  els.loginAccount.innerHTML = accounts.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  els.loginSubmit.textContent = loginRole === 'teacher' ? '进入教师控制台' : `进入第 ${els.loginGroup.value || 1} 组`;
}

function chooseLoginRole(role) {
  loginRole = role;
  $$('#loginRoleTabs button').forEach(button => button.classList.toggle('active', button.dataset.loginRole === role));
  els.loginGroupField.classList.toggle('hidden', role === 'teacher');
  els.loginAccountLabel.textContent = role === 'teacher' ? '选择教师账号' : '选择你的姓名';
  $('#teacherPasswordField').classList.toggle('hidden', role !== 'teacher');
  $('#teacherPassword').required = role === 'teacher';
  populateAccounts();
}

function showLogin(preserveSelection = true) {
  camera.close();
  if (preserveSelection && currentUser) {
    chooseLoginRole(currentUser.role);
    if (currentUser.groupId) {
      els.loginGroup.value = currentUser.groupId;
      populateAccounts();
    }
    els.loginAccount.value = currentUser.name;
  }
  els.roleMenu.classList.remove('open');
  els.loginScreen.classList.remove('hidden');
}

function activateSession(session) {
  currentUser = session;
  sessionVersion++;
  lastSnapshot = '';
  $('.app-shell').classList.remove('hidden');
  $('.ai-state').textContent = session.ai_ready ? 'AI 已配置' : 'AI 待配置';
  $('.ai-state').title = session.ai_model || '';
  $('#teacherPassword').value = '';
  els.loginScreen.classList.add('hidden');
  els.placeholderView.classList.add('hidden');
  updateProfile();
  showAuthorizedClassroom();
}

function updateProfile() {
  const teacher = currentUser.role === 'teacher';
  els.profileName.textContent = currentUser.name;
  els.profileRole.textContent = teacher ? '生物教师 · 主讲' : `第 ${currentUser.groupId} 组 · 学生`;
  $('.profile-button .avatar').textContent = currentUser.name[0];
  $('.profile-button .avatar').className = `avatar ${teacher ? 'blue' : 'coral'}`;
}

function showAuthorizedClassroom() {
  if (!currentUser) return showLogin(false);
  const teacher = currentUser.role === 'teacher';
  els.studentView.classList.toggle('hidden', teacher);
  els.teacherView.classList.toggle('hidden', !teacher);
  els.placeholderView.classList.add('hidden');
  els.pageTitle.textContent = teacher ? '课堂观察台' : '细胞为什么需要呼吸？';
  $('.breadcrumb span:first-child').textContent = teacher ? '教师控制台' : '课堂空间';
  $$('.nav-item').forEach((button, index) => button.classList.toggle('active', index === 0));
  if (teacher) {
    renderMetrics();
    renderGroups($('#filterTabs .active')?.dataset.filter || 'all');
    selectGroup(selectedGroupId);
  } else {
    renderStudentWorkspace();
  }
}

function renderStudentWorkspace() {
  const group = groupById(currentUser.groupId);
  $('#studentGroupTitle').textContent = `第 ${group.id} 组`;
  $('#studentOnlineCount').textContent = `${group.members.length} 位成员`;
  $('.task-copy span').textContent = `本组探究任务 · 第 ${group.id} 组`;
  $('#studentMemberList').innerHTML = group.members.map((name, index) => `
    <div><span class="avatar ${avatarColors[index]}">${escapeHtml(name[0])}</span><p><strong>${escapeHtml(name)}</strong><small>${memberRoles[index]}</small></p><i class="online"></i></div>
  `).join('');
  renderStudentMessages(group);
  renderStudentFiles(group);
}

function renderStudentMessages(group) {
  const welcome = `<div class="message ai-message"><div class="ai-avatar">AI</div><div class="bubble"><p>你好，第 ${group.id} 组！可以发送文字，也可以拍照或选择图片，让我帮你们观察实验现象、辨认记录和分析证据。文档资料请先将相关内容粘贴到对话中。</p><div class="message-meta">课堂助手 · 本组会话</div></div></div>`;
  els.messages.innerHTML = welcome + group.chat.map(messageHtml).join('');
  if (pendingMessage) {
    els.messages.insertAdjacentHTML('beforeend', messageHtml(pendingMessage));
    const status = pendingMessage.error
      ? `<p>${escapeHtml(pendingMessage.error)}</p><button type="button" class="outline-btn retry-message" data-retry-message>重试这条消息</button>`
      : '<p class="thinking-message" role="status">AI 正在思考…</p>';
    els.messages.insertAdjacentHTML('beforeend', `<div class="message ai-message pending-reply"><div class="ai-avatar">AI</div><div class="bubble">${status}</div></div>`);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

function messageHtml(message) {
  if (message.role === 'student') {
    return `<div class="message user-message"><div class="bubble"><p>${escapeHtml(message.text)}</p>${messageImages(message)}<div class="message-meta">${escapeHtml(message.speaker)} · ${message.pending ? (message.error ? '回复失败，可重试' : '等待 AI 回复') : '小组会话'}</div></div><span class="avatar avatar-small coral">${escapeHtml(message.speaker[0])}</span></div>`;
  }
  return `<div class="message ai-message"><div class="ai-avatar">${message.role === 'system' ? '系' : 'AI'}</div><div class="bubble"><p>${escapeHtml(message.text)}</p><div class="message-meta">${escapeHtml(message.speaker)} · 小组会话</div></div></div>`;
}

function renderStudentFiles(group) {
  els.fileList.innerHTML = group.files.length ? group.files.map(fileHtml).join('') : '<p class="files-empty">本组还没有上传资料。</p>';
  els.fileCount.textContent = `${group.files.length} 份`;
  renderSelectedImages();
}

async function sendMessage() {
  if (!currentUser || currentUser.role !== 'student' || sending) return;
  if (uploading) return showToast('图片正在上传，请完成后再发送');
  const text = els.chatInput.value.trim();
  const imageIds = [...selectedImages.keys()];
  if (!text && !imageIds.length) return;
  const version = sessionVersion;
  const group = groupById(currentUser.groupId);
  pendingMessage = { speaker: currentUser.name, role: 'student',
    text: text || '请观察这些图片，描述主要内容，并帮助我们分析。',
    images: [...selectedImages.values()], pending: true, error: null };
  sending = true;
  els.chatInput.value = '';
  els.chatInput.style.height = 'auto';
  selectedImages.clear();
  renderStudentMessages(group);
  renderStudentFiles(group);
  els.sendButton.disabled = true;
  els.chatInput.readOnly = true;
  $('#sendState').textContent = 'AI 正在思考…';
  try {
    const reply = await api('/chats', { method: 'POST', body: { message: text, image_ids: imageIds } });
    if (version !== sessionVersion) return;
    pendingMessage = null;
    group.chat.push({speaker: currentUser.name, role: 'student', text: reply.question, images: reply.images || []},
      {speaker: '课堂助手', role: 'ai', text: reply.answer});
    renderStudentMessages(group);
    $('#sendState').textContent = '回复已保存';
    // A refresh failure must not turn a successful AI response into a failed send.
    await syncGroups().catch(() => { $('#sendState').textContent = '回复已保存，列表稍后同步'; });
  } catch (error) {
    if (version === sessionVersion && pendingMessage) {
      pendingMessage.error = error.message;
      renderStudentMessages(group);
      $('#sendState').textContent = '回复失败，可点击消息下方重试';
      showToast(error.message);
    }
  } finally {
    sending = false;
    els.sendButton.disabled = false;
    els.chatInput.readOnly = false;
    if (currentUser?.role === 'student') renderStudentFiles(groupById(currentUser.groupId));
  }
}

async function addFiles(fileList) {
  if (!currentUser || currentUser.role !== 'student' || uploading) return false;
  if (sending) { showToast('请等待本次回复完成后再上传'); return false; }
  const files = [...fileList];
  if (files.some(file => file.size > 20 * 1024 * 1024)) {
    showToast('单份资料不能超过 20 MB，请重新选择'); return false;
  }
  if (!files.length) return false;
  const version = sessionVersion;
  uploading = true;
  let count = 0, unselected = 0;
  try {
    for (const file of files) {
      if (version !== sessionVersion) return false;
      showToast(`正在上传 ${count + 1}/${files.length}：${file.name}`);
      const body = new FormData(); body.append('file', file);
      const uploaded = await api('/files', { method: 'POST', body });
      if (version !== sessionVersion) return false;
      if (uploaded.preview && !selectImage(uploaded)) unselected++;
      renderSelectedImages();
      count++;
    }
    if (version === sessionVersion) {
      showToast(unselected ? `资料已保存；${unselected} 张图片未加入待发送，每次最多 4 张且合计不超过 20 MB` : `已保存 ${count} 份资料${selectedImages.size ? '，图片已加入待发送' : '，教师可查看'}`);
      await syncGroups();
    }
    return true;
  } catch (error) {
    showToast(`已上传 ${count} 份；${error.message}`);
    if (version === sessionVersion) await syncGroups().catch(() => {});
    return false;
  } finally { uploading = false; }
}

function renderMetrics() {
  const conversationCount = groups.reduce((sum, group) => sum + group.chat.length, 0);
  const uploadCount = groups.reduce((sum, group) => sum + group.files.length, 0);
  $('#conversationCount').textContent = conversationCount;
  $('#uploadCount').textContent = uploadCount;
  $('#groupCount').textContent = groups.length;
  $('#attentionCount').textContent = groups.filter(group => !group.chat.length).length;
}

function groupPreview(group) {
  return group.chat.at(-1)?.text || '尚未开始讨论。';
}

function renderGroups(filter = 'all') {
  if (!currentUser || currentUser.role !== 'teacher') return;
  els.groupGrid.innerHTML = '';
  groups.filter(group => filter === 'all' || group.status === filter).forEach(group => {
    const tile = document.createElement('button');
    tile.className = `group-tile ${selectedGroupId === group.id ? 'selected' : ''}`;
    tile.dataset.id = group.id;
    tile.innerHTML = `<div class="group-tile-head"><h3>第 ${group.id} 组</h3><span class="status-pill ${group.status}">${group.statusText}</span></div><p>${escapeHtml(groupPreview(group))}</p><div class="group-footer"><span>${group.chat.length} 条对话 · ${group.files.length} 份资料</span></div>`;
    tile.addEventListener('click', () => selectGroup(group.id));
    els.groupGrid.appendChild(tile);
  });
}

function selectGroup(id) {
  if (!currentUser || currentUser.role !== 'teacher') return;
  const group = groupById(id);
  if (!group) return;
  selectedGroupId = group.id;
  els.inspectEmpty.classList.add('hidden');
  els.inspectContent.classList.remove('hidden');
  els.inspectTitle.textContent = `第 ${group.id} 组`;
  els.inspectProgress.textContent = group.statusText;
  els.progressBar.parentElement.classList.add('hidden');
  els.inspectMembers.innerHTML = group.members.map((name, index) => `<span class="avatar ${avatarColors[index]}">${escapeHtml(name[0])}</span>`).join('') + `<span>${group.members.join('、')}</span>`;
  els.miniChat.innerHTML = group.chat.map(message => `<div class="mini-message ${message.role === 'student' ? 'student' : ''}"><span>${escapeHtml(message.speaker)}</span><p>${escapeHtml(message.text)}</p>${messageImages(message)}</div>`).join('');
  $('#teacherFileCount').textContent = `${group.files.length} 份`;
  $('#teacherFileList').innerHTML = group.files.length ? group.files.map(fileHtml).join('') : '<p class="files-empty">本组还没有上传资料。</p>';
  renderGroups($('#filterTabs .active')?.dataset.filter || 'all');
}

function openPresentation() {
  if (!currentUser || currentUser.role !== 'teacher') return;
  if (!selectedGroupId) selectedGroupId = groups[0].id;
  const group = groupById(selectedGroupId);
  els.presentationGroup.textContent = `第 ${group.id} 组 · 对话记录`;
  els.presentationChat.innerHTML = group.chat.map(message => `<div class="mini-message ${message.role === 'student' ? 'student' : ''}"><span>${escapeHtml(message.speaker)}</span><p>${escapeHtml(message.text)}</p>${messageImages(message)}</div>`).join('');
  els.presentationMode.classList.remove('hidden');
}

function cyclePresentation(direction) {
  if (!currentUser || currentUser.role !== 'teacher') return;
  const index = groups.findIndex(group => group.id === selectedGroupId);
  selectedGroupId = groups[(index + direction + groups.length) % groups.length].id;
  openPresentation();
}

populateGroups();
populateAccounts();

els.loginGroup.addEventListener('change', populateAccounts);
els.loginRoleTabs.addEventListener('click', event => {
  const button = event.target.closest('[data-login-role]');
  if (button) chooseLoginRole(button.dataset.loginRole);
});
els.loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (els.loginSubmit.disabled) return;
  els.loginSubmit.disabled = true;
  try {
    const session = await api('/login', { method: 'POST', body: {
      role: loginRole, name: els.loginAccount.value,
      groupId: loginRole === 'student' ? Number(els.loginGroup.value) : null,
      code: els.classCode.value.trim(), teacherPassword: $('#teacherPassword').value
    }});
    activateSession(session);
    await syncGroups();
    showToast(`欢迎，${session.name}`);
  } catch (error) { showToast(error.message); }
  finally { els.loginSubmit.disabled = false; }
});

async function logout() {
  try { await api('/logout', { method: 'POST' }); resetSession(); showToast('已退出课堂'); }
  catch (error) { showToast(error.message); }
}
els.roleToggle.addEventListener('click', logout);
els.profileButton.addEventListener('click', () => els.roleMenu.classList.toggle('open'));
$('#switchAccount').addEventListener('click', logout);
$('#logoutButton').addEventListener('click', logout);

$$('.nav-item').forEach(button => button.addEventListener('click', () => {
  if (!currentUser) return showLogin(false);
  $$('.nav-item').forEach(item => item.classList.remove('active'));
  button.classList.add('active');
  if (button.dataset.view === 'classroom') return showAuthorizedClassroom();
  els.studentView.classList.add('hidden');
  els.teacherView.classList.add('hidden');
  els.placeholderView.classList.remove('hidden');
  const resources = button.dataset.view === 'resources';
  $('#placeholderTitle').textContent = resources ? '课程资料库' : (currentUser.role === 'teacher' ? '课堂记录' : '学习记录');
  els.pageTitle.textContent = resources ? '课程资料' : '历史记录';
}));
$('#backClassroom').addEventListener('click', showAuthorizedClassroom);

els.sendButton.addEventListener('click', sendMessage);
els.chatInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
});
els.chatInput.addEventListener('input', () => {
  els.chatInput.style.height = 'auto';
  els.chatInput.style.height = `${Math.min(els.chatInput.scrollHeight, 100)}px`;
});
$('#quickPrompts').addEventListener('click', event => {
  if (event.target.tagName === 'BUTTON') { els.chatInput.value = event.target.textContent; els.chatInput.focus(); }
});
const camera = createCameraCapture({ onConfirm: file => addFiles([file]), onFile: () => els.fileInput.click() });
els.messages.addEventListener('click', event => {
  if (!event.target.closest('[data-retry-message]') || !pendingMessage?.error || sending) return;
  if (els.chatInput.value.trim() || selectedImages.size) {
    showToast('输入框中有新草稿，请先发送或清空后再重试'); return;
  }
  els.chatInput.value = pendingMessage.text;
  pendingMessage.images.forEach(file => selectedImages.set(file.id, file));
  sendMessage();
});
els.fileList.addEventListener('click', event => {
  const button = event.target.closest('[data-image-id]');
  if (!button || currentUser?.role !== 'student' || sending) return;
  const file = groupById(currentUser.groupId).files.find(file => file.id === button.dataset.imageId);
  if (!file?.preview) return;
  if (selectedImages.has(file.id)) selectedImages.delete(file.id);
  else if (!selectImage(file)) showToast('每次最多 4 张图片，合计不超过 20 MB');
  renderStudentFiles(groupById(currentUser.groupId));
});
els.uploadPreview.addEventListener('click', event => {
  const button = event.target.closest('[data-remove-image]');
  if (!button || currentUser?.role !== 'student' || sending) return;
  selectedImages.delete(button.dataset.removeImage);
  renderStudentFiles(groupById(currentUser.groupId));
});
$$('.camera-trigger').forEach(button => button.addEventListener('click', () => {
  if (currentUser?.role === 'student') camera.open();
}));
$('#uploadFileButton').addEventListener('click', () => els.fileInput.click());
$('#sideUploadFileButton').addEventListener('click', () => els.sideFileInput.click());
[els.fileInput, els.sideFileInput].forEach(input => input.addEventListener('change', async event => {
  await addFiles(event.target.files);
  event.target.value = '';
}));

$('#filterTabs').addEventListener('click', event => {
  const button = event.target.closest('[data-filter]');
  if (!button || currentUser?.role !== 'teacher') return;
  $$('#filterTabs button').forEach(item => item.classList.remove('active'));
  button.classList.add('active');
  renderGroups(button.dataset.filter);
});
$('#closeInspect').addEventListener('click', () => {
  els.inspectContent.classList.add('hidden');
  els.inspectEmpty.classList.remove('hidden');
  selectedGroupId = null;
  renderGroups($('#filterTabs .active')?.dataset.filter || 'all');
});
$('#refreshButton').addEventListener('click', async () => {
  if (currentUser?.role !== 'teacher') return;
  const button = $('#refreshButton'); button.disabled = true;
  try { await syncGroups(); showToast('全班数据已刷新'); }
  catch (error) { showToast(error.message); }
  finally { button.disabled = false; }
});

$('#projectButton').addEventListener('click', openPresentation);
$('#showGroupButton').addEventListener('click', openPresentation);
$('#exitPresentation').addEventListener('click', () => els.presentationMode.classList.add('hidden'));
$('#previousGroup').addEventListener('click', () => cyclePresentation(-1));
$('#nextGroup').addEventListener('click', () => cyclePresentation(1));
document.addEventListener('keydown', event => {
  if (els.presentationMode.classList.contains('hidden')) return;
  if (event.key === 'Escape') els.presentationMode.classList.add('hidden');
  if (event.key === 'ArrowLeft') cyclePresentation(-1);
  if (event.key === 'ArrowRight') cyclePresentation(1);
});

$('#expandTask').addEventListener('click', () => $('#taskModal').classList.remove('hidden'));
$('.modal-close').addEventListener('click', () => $('#taskModal').classList.add('hidden'));
$('#taskModal').addEventListener('click', event => {
  if (event.target.id === 'taskModal') event.currentTarget.classList.add('hidden');
});

sessionStorage.removeItem('classroomSession');
api('/me').then(async session => { activateSession(session); await syncGroups(); }).catch(error => {
  resetSession();
  if (error.message !== '请先登录课堂') showToast('请通过后端服务打开课堂页面：' + error.message);
});
setInterval(() => {
  if (currentUser && !document.hidden) syncGroups().catch(error => { $('#syncState').textContent = '同步失败：' + error.message; });
}, 10000);
