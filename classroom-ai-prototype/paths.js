'use strict';
(() => {
  const script = new URL(document.currentScript.src);
  const directory = script.pathname.slice(0, script.pathname.lastIndexOf('/'));
  const prefix = directory.replace(/\/(classroom|workspace)$/, '');
  function url(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || !prefix) return value;
    if (value === prefix || value.startsWith(prefix + '/')) return value;
    return prefix + value;
  }
  globalThis.PublicPaths = Object.freeze({prefix, url});
})();
