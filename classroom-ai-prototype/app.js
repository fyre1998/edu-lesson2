const groupData = [
  { id: 1, name: '第 1 组', status: 'active', statusText: '讨论中', progress: 84, messages: 14, files: 3, members: ['王', '赵', '许', '江'], preview: '如果氧气是限制条件，两个装置的产气速度应该会……', chat: [
    ['学生', '我们认为有氧组产生的能量更多，但气球大小不能直接说明能量多少。'],
    ['AI', '这个区分很重要。你们能找到一个更直接反映能量差异的指标吗？'],
    ['学生', '可以比较繁殖速度或者葡萄糖消耗量。']
  ]},
  { id: 2, name: '第 2 组', status: 'attention', statusText: '需要关注', progress: 35, messages: 5, files: 1, members: ['孙', '章', '董', '徐'], preview: '我们不知道怎么判断澄清石灰水的结果……', chat: [
    ['学生', '石灰水都变浑浊了，所以结果是不是一样？'],
    ['AI', '“都变浑浊”能说明产生的气体种类相同，但还能比较什么？']
  ]},
  { id: 3, name: '第 3 组', status: 'active', statusText: '讨论中', progress: 72, messages: 12, files: 2, members: ['林', '陈', '周', '蒋'], preview: '气球变大说明两组都产生了气体。结合酵母菌……', chat: [
    ['学生', '有氧组的气球变大了，无氧组也变大了，但是小一些。这能说明什么？'],
    ['AI', '气球变大说明两组都有气体生成。但仅凭这一点还不能证明气体一定是 CO₂。'],
    ['学生', '我们的石灰水也变浑浊了，可以把它作为第二条证据。']
  ]},
  { id: 4, name: '第 4 组', status: 'active', statusText: '整理结论', progress: 91, messages: 18, files: 4, members: ['吴', '郑', '冯', '何'], preview: '证据链：葡萄糖减少、产生 CO₂、温度升高……', chat: [
    ['学生', '我们整理了三条证据：葡萄糖减少、产生 CO₂、装置温度升高。'],
    ['AI', '结构已经很完整。建议说明每条证据分别支持“物质变化”还是“能量变化”。']
  ]},
  { id: 5, name: '第 5 组', status: 'attention', statusText: '暂未提问', progress: 20, messages: 2, files: 1, members: ['孔', '曹', '严', '华'], preview: '已上传实验记录，尚未开始与 AI 讨论。', chat: [
    ['系统', '小组已上传“实验数据记录表.xlsx”。'],
    ['AI', '我已经读取记录表。你们想先从哪一组数据开始分析？']
  ]},
  { id: 6, name: '第 6 组', status: 'active', statusText: '核查证据', progress: 68, messages: 16, files: 3, members: ['金', '魏', '陶', '姜'], preview: '酒精气味是否可以作为无氧呼吸的可靠证据？', chat: [
    ['学生', '闻到了酒精味，这能证明发生了无氧呼吸吗？'],
    ['AI', '它可以作为线索，但闻气味主观性较强。可以考虑用重铬酸钾检测来增强证据。']
  ]}
];

const els = {
  studentView: document.querySelector('#studentView'), teacherView: document.querySelector('#teacherView'),
  placeholderView: document.querySelector('#placeholderView'), pageTitle: document.querySelector('#pageTitle'),
  roleToggle: document.querySelector('#roleToggle'), profileName: document.querySelector('#profileName'),
  profileRole: document.querySelector('#profileRole'), profileButton: document.querySelector('#profileButton'),
  roleMenu: document.querySelector('#roleMenu'), messages: document.querySelector('#messages'),
  chatInput: document.querySelector('#chatInput'), sendButton: document.querySelector('#sendButton'),
  fileInput: document.querySelector('#fileInput'), sideFileInput: document.querySelector('#sideFileInput'),
  uploadPreview: document.querySelector('#uploadPreview'), fileList: document.querySelector('#fileList'),
  fileCount: document.querySelector('#fileCount'), groupGrid: document.querySelector('#groupGrid'),
  inspectEmpty: document.querySelector('#inspectEmpty'), inspectContent: document.querySelector('#inspectContent'),
  inspectTitle: document.querySelector('#inspectTitle'), inspectMembers: document.querySelector('#inspectMembers'),
  inspectProgress: document.querySelector('#inspectProgress'), progressBar: document.querySelector('#progressBar'),
  miniChat: document.querySelector('#miniChat'), presentationMode: document.querySelector('#presentationMode'),
  presentationGroup: document.querySelector('#presentationGroup'), presentationChat: document.querySelector('#presentationChat'),
  toast: document.querySelector('#toast')
};

let role = 'student';
let selectedGroup = 3;
let fileTotal = 2;
let conversationTotal = 67;

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

function setRole(nextRole) {
  role = nextRole;
  const teacher = role === 'teacher';
  els.studentView.classList.toggle('hidden', teacher);
  els.teacherView.classList.toggle('hidden', !teacher);
  els.placeholderView.classList.add('hidden');
  els.pageTitle.textContent = teacher ? '课堂观察台' : '细胞为什么需要呼吸？';
  els.roleToggle.textContent = teacher ? '返回学生视图' : '切换教师视图';
  els.profileName.textContent = teacher ? '赵老师' : '林小雨';
  els.profileRole.textContent = teacher ? '生物教师 · 主讲' : '第 3 组 · 学生';
  document.querySelector('.profile-button .avatar').textContent = teacher ? '沈' : '林';
  document.querySelector('.profile-button .avatar').classList.toggle('avatar-student', !teacher);
  els.roleMenu.classList.remove('open');
  document.querySelectorAll('.nav-item').forEach((button, index) => button.classList.toggle('active', index === 0));
}

els.roleToggle.addEventListener('click', () => setRole(role === 'student' ? 'teacher' : 'student'));
els.profileButton.addEventListener('click', () => els.roleMenu.classList.toggle('open'));
els.roleMenu.addEventListener('click', event => {
  const target = event.target.closest('[data-role]');
  if (target) setRole(target.dataset.role);
});

document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
  button.classList.add('active');
  if (button.dataset.view === 'classroom') return setRole(role);
  els.studentView.classList.add('hidden');
  els.teacherView.classList.add('hidden');
  els.placeholderView.classList.remove('hidden');
  const resourceMode = button.dataset.view === 'resources';
  document.querySelector('#placeholderTitle').textContent = resourceMode ? '课程资料库' : '学习记录';
  els.pageTitle.textContent = resourceMode ? '课程资料' : '我的记录';
}));
document.querySelector('#backClassroom').addEventListener('click', () => setRole(role));

function addMessage(text, type = 'user') {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${type}-message`;
  const bubble = `<div class="bubble"><p>${text}</p><div class="message-meta">${type === 'user' ? '林小雨' : '课堂助手'} · 刚刚</div></div>`;
  wrapper.innerHTML = type === 'user' ? `${bubble}<span class="avatar avatar-small coral">林</span>` : `<div class="ai-avatar">AI</div>${bubble}`;
  els.messages.appendChild(wrapper);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function sendMessage() {
  const value = els.chatInput.value.trim();
  if (!value) return;
  addMessage(value);
  els.chatInput.value = '';
  els.chatInput.style.height = 'auto';
  els.sendButton.disabled = true;
  setTimeout(() => {
    const response = value.includes('证据')
      ? '你们已经在关注“结论是否被证据支持”了。建议把每条证据对应到一个具体推论，再检查是否还有其他解释。需要我按“现象—推论—结论”帮你们整理吗？'
      : '这是一个值得追问的问题。请先区分你们直接观察到的现象和根据知识作出的推测，我可以再帮你们检查推理是否完整。';
    addMessage(response, 'ai');
    els.sendButton.disabled = false;
    conversationTotal += 2;
    document.querySelector('#conversationCount').textContent = conversationTotal;
  }, 720);
}

els.sendButton.addEventListener('click', sendMessage);
els.chatInput.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); }
});
els.chatInput.addEventListener('input', () => {
  els.chatInput.style.height = 'auto';
  els.chatInput.style.height = `${Math.min(els.chatInput.scrollHeight, 100)}px`;
});
document.querySelector('#quickPrompts').addEventListener('click', event => {
  if (event.target.tagName === 'BUTTON') { els.chatInput.value = event.target.textContent; els.chatInput.focus(); }
});

function handleFiles(fileList, addToComposer = false) {
  [...fileList].forEach(file => {
    fileTotal += 1;
    const extension = file.name.split('.').pop().toUpperCase().slice(0, 4) || 'FILE';
    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `<span class="file-icon doc">${extension}</span><p><strong>${file.name}</strong><small>林小雨 · 刚刚</small></p><button>⋯</button>`;
    els.fileList.appendChild(item);
    if (addToComposer) {
      const chip = document.createElement('span');
      chip.className = 'upload-chip';
      chip.textContent = `附件 · ${file.name}`;
      els.uploadPreview.appendChild(chip);
    }
  });
  els.fileCount.textContent = `${fileTotal} 份`;
  document.querySelector('#uploadCount').textContent = 12 + fileTotal;
  if (fileList.length) showToast(`已添加 ${fileList.length} 份资料（原型演示）`);
}
els.fileInput.addEventListener('change', event => handleFiles(event.target.files, true));
els.sideFileInput.addEventListener('change', event => handleFiles(event.target.files));

function renderGroups(filter = 'all') {
  els.groupGrid.innerHTML = '';
  groupData.filter(group => filter === 'all' || group.status === filter).forEach(group => {
    const tile = document.createElement('button');
    tile.className = `group-tile ${selectedGroup === group.id ? 'selected' : ''}`;
    tile.dataset.id = group.id;
    tile.innerHTML = `<div class="group-tile-head"><h3>${group.name}</h3><span class="status-pill ${group.status}">${group.statusText}</span></div><p>${group.preview}</p><div class="group-footer"><span>${group.messages} 条对话 · ${group.files} 份资料</span><strong>${group.progress}%</strong></div><div class="group-progress"><i style="width:${group.progress}%"></i></div>`;
    tile.addEventListener('click', () => selectGroup(group.id));
    els.groupGrid.appendChild(tile);
  });
}

function selectGroup(id) {
  selectedGroup = id;
  const group = groupData.find(item => item.id === id);
  els.inspectEmpty.classList.add('hidden');
  els.inspectContent.classList.remove('hidden');
  els.inspectTitle.textContent = group.name;
  els.inspectProgress.textContent = `${group.progress}%`;
  els.progressBar.style.width = `${group.progress}%`;
  els.inspectMembers.innerHTML = group.members.map((name, index) => `<span class="avatar ${['coral','mint','blue','gold'][index]}">${name}</span>`).join('') + `<span>${group.members.length} 名成员在线</span>`;
  els.miniChat.innerHTML = group.chat.map(([speaker, text]) => `<div class="mini-message ${speaker === '学生' ? 'student' : ''}"><span>${speaker}</span><p>${text}</p></div>`).join('');
  renderGroups(document.querySelector('#filterTabs .active').dataset.filter);
}

document.querySelector('#filterTabs').addEventListener('click', event => {
  const button = event.target.closest('[data-filter]');
  if (!button) return;
  document.querySelectorAll('#filterTabs button').forEach(item => item.classList.remove('active'));
  button.classList.add('active');
  renderGroups(button.dataset.filter);
});
document.querySelector('#closeInspect').addEventListener('click', () => {
  els.inspectContent.classList.add('hidden'); els.inspectEmpty.classList.remove('hidden');
  selectedGroup = null; renderGroups(document.querySelector('#filterTabs .active').dataset.filter);
});
document.querySelector('#refreshButton').addEventListener('click', event => {
  event.currentTarget.textContent = '已刷新'; showToast('课堂数据已刷新');
  setTimeout(() => event.currentTarget.textContent = '刷新数据', 1200);
});

function openPresentation() {
  if (!selectedGroup) selectedGroup = 3;
  const group = groupData.find(item => item.id === selectedGroup);
  els.presentationGroup.textContent = `${group.name} · 对话记录`;
  els.presentationChat.innerHTML = group.chat.map(([speaker, text]) => `<div class="mini-message ${speaker === '学生' ? 'student' : ''}"><span>${speaker}</span><p>${text}</p></div>`).join('');
  els.presentationMode.classList.remove('hidden');
}
document.querySelector('#projectButton').addEventListener('click', openPresentation);
document.querySelector('#showGroupButton').addEventListener('click', openPresentation);
document.querySelector('#exitPresentation').addEventListener('click', () => els.presentationMode.classList.add('hidden'));
function cycleGroup(direction) {
  const index = groupData.findIndex(group => group.id === selectedGroup);
  selectedGroup = groupData[(index + direction + groupData.length) % groupData.length].id;
  openPresentation();
}
document.querySelector('#previousGroup').addEventListener('click', () => cycleGroup(-1));
document.querySelector('#nextGroup').addEventListener('click', () => cycleGroup(1));
document.addEventListener('keydown', event => {
  if (els.presentationMode.classList.contains('hidden')) return;
  if (event.key === 'Escape') els.presentationMode.classList.add('hidden');
  if (event.key === 'ArrowLeft') cycleGroup(-1);
  if (event.key === 'ArrowRight') cycleGroup(1);
});

document.querySelector('#expandTask').addEventListener('click', () => document.querySelector('#taskModal').classList.remove('hidden'));
document.querySelector('.modal-close').addEventListener('click', () => document.querySelector('#taskModal').classList.add('hidden'));
document.querySelector('#taskModal').addEventListener('click', event => {
  if (event.target.id === 'taskModal') event.currentTarget.classList.add('hidden');
});

renderGroups();
selectGroup(3);
