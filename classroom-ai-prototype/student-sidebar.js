'use strict';

// 两节课使用相同的学生导航交互；教师仍使用原来的常驻侧栏。
(() => {
  const app = document.querySelector('#app');
  const sidebar = document.querySelector('#classroomSidebar');
  const toggle = document.querySelector('#sidebarToggle');
  let expanded = false;
  let closeTimer;
  let keyboardNavigation = false;
  const isStudent = () => app.classList.contains('student-view');
  const cancelClose = () => clearTimeout(closeTimer);

  function setOpen(value) {
    cancelClose();
    const student = isStudent();
    expanded = student && value;
    // 隐藏前移出焦点，收起后的控件不进入 Tab 顺序或读屏导航。
    if (student && !expanded && sidebar.contains(document.activeElement)) toggle.focus();
    sidebar.inert = student && !expanded;
    app.classList.toggle('sidebar-open', expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', expanded ? '收起课堂导航' : '展开课堂导航');
    toggle.title = expanded ? '收起课堂导航' : '展开课堂导航';
  }

  toggle.addEventListener('click', () => {
    setOpen(!expanded);
    if (expanded && keyboardNavigation) sidebar.querySelector('select, button')?.focus();
  });
  sidebar.addEventListener('pointerenter', cancelClose);
  toggle.addEventListener('pointerenter', cancelClose);
  function scheduleClose(event) {
    if (event.pointerType !== 'mouse' || !expanded) return;
    if (sidebar.contains(event.relatedTarget) || toggle.contains(event.relatedTarget)) return;
    if (keyboardNavigation && sidebar.contains(document.activeElement)) return;
    // 原生下拉选项可能在浏览器窗口外显示，选择期间不收起。
    if (!event.relatedTarget && document.activeElement?.tagName === 'SELECT') return;
    closeTimer = setTimeout(() => setOpen(false), 350);
  }
  sidebar.addEventListener('pointerleave', scheduleClose);
  toggle.addEventListener('pointerleave', scheduleClose);
  sidebar.addEventListener('focusout', event => {
    if (event.relatedTarget && !sidebar.contains(event.relatedTarget) && !toggle.contains(event.relatedTarget)) setOpen(false);
  });
  sidebar.addEventListener('click', event => {
    if (event.target.closest('#legacyButton')) setOpen(false);
  });
  document.addEventListener('pointerdown', () => { keyboardNavigation = false; }, true);
  document.addEventListener('click', event => {
    if (expanded && !sidebar.contains(event.target) && !toggle.contains(event.target)) setOpen(false);
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Tab') keyboardNavigation = true;
    if (event.key === 'Escape' && expanded) {
      event.preventDefault();
      setOpen(false);
      toggle.focus();
    }
  });

  globalThis.classroomSidebar = { reset: () => setOpen(false) };
  setOpen(false);
})();
