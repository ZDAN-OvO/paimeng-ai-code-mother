(() => {
  if (window.parent === window) return;

  const channel = 'paimeng-visual-editor';
  const hoverAttribute = 'data-paimeng-visual-hover';
  const selectedAttribute = 'data-paimeng-visual-selected';
  let parentOrigin;
  let connectionId;
  let editId;
  let hovered;
  let selected;
  let style;
  let tip;
  let tipTimer;

  function send(type, data = {}) {
    window.parent.postMessage(
      { channel, connectionId, type, pageUrl: window.location.href, ...data },
      parentOrigin,
    );
  }

  function selectorFor(element) {
    const path = [];
    for (let current = element; current && current !== document.body; current = current.parentElement) {
      let selector = CSS.escape(current.localName);
      if (current.id) {
        path.unshift(selector + '#' + CSS.escape(current.id));
        break;
      }
      for (const className of current.classList) {
        selector += '.' + CSS.escape(className);
      }
      const siblings = Array.from(current.parentElement?.children || []);
      path.unshift(selector + ':nth-child(' + (siblings.indexOf(current) + 1) + ')');
    }
    return path.join(' > ');
  }

  function pickable(target) {
    return target instanceof Element && target !== document.body && target !== document.documentElement
      && !['script', 'style'].includes(target.localName);
  }

  function clearHover() {
    hovered?.removeAttribute(hoverAttribute);
    hovered = undefined;
  }

  function clearSelection() {
    selected?.removeAttribute(selectedAttribute);
    selected = undefined;
  }

  function onMouseOver(event) {
    const target = event.target;
    if (!pickable(target) || target === hovered || target === selected) return;
    clearHover();
    target.setAttribute(hoverAttribute, '');
    hovered = target;
  }

  function onMouseOut(event) {
    if (hovered && hovered === event.target && !hovered.contains(event.relatedTarget)) clearHover();
  }

  function onClick(event) {
    const target = event.target;
    if (!pickable(target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    clearHover();
    clearSelection();

    target.setAttribute(selectedAttribute, '');
    selected = target;
    send('selected', {
      editId,
      element: {
        tagName: target.tagName,
        id: target.id,
        className: Array.from(target.classList).join(' '),
        textContent: target.textContent?.trim().slice(0, 100) || '',
        selector: selectorFor(target),
      },
    });
  }

  function startEditing() {
    style = document.createElement('style');
    style.textContent =
      '[' + hoverAttribute + '] { outline: 2px dashed #1890ff !important; outline-offset: 2px !important; cursor: crosshair !important; }' +
      '[' + selectedAttribute + '] { outline: 3px solid #52c41a !important; outline-offset: 2px !important; }';
    document.head.appendChild(style);

    tip = document.createElement('div');
    tip.textContent = '🎯 编辑模式已开启\n悬浮查看元素，点击选中元素';
    tip.setAttribute('aria-hidden', 'true');
    tip.style.cssText = 'position: fixed; top: 20px; right: 20px; background: #1890ff; color: white;'
      + 'padding: 12px 16px; border-radius: 6px; font-size: 14px; z-index: 9999; white-space: pre-line; pointer-events: none;';
    document.body.appendChild(tip);
    tipTimer = setTimeout(() => tip?.remove(), 3000);

    window.addEventListener('mouseover', onMouseOver, true);
    window.addEventListener('mouseout', onMouseOut, true);
    window.addEventListener('click', onClick, true);
  }

  function stopEditing() {
    if (editId === undefined) return;
    editId = undefined;
    window.removeEventListener('mouseover', onMouseOver, true);
    window.removeEventListener('mouseout', onMouseOut, true);
    window.removeEventListener('click', onClick, true);
    clearHover();
    clearSelection();
    clearTimeout(tipTimer);
    style?.remove();
    tip?.remove();
    style = undefined;
    tip = undefined;
  }

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window.parent || !/^https?:\/\//.test(event.origin)
      || (parentOrigin && event.origin !== parentOrigin) || !data || typeof data !== 'object'
      || data.channel !== channel || typeof data.connectionId !== 'string' || !data.connectionId) return;

    if (data.type === 'connect') {
      stopEditing();
      parentOrigin = event.origin;
      connectionId = data.connectionId;
      send('ready');
      return;
    }
    if (connectionId !== data.connectionId || !Number.isSafeInteger(data.editId) || data.editId < 1) return;
    if (data.type === 'set-edit-mode' && typeof data.enabled === 'boolean') {
      if (!data.enabled) {
        if (data.editId === editId) stopEditing();
      } else if (document.head && document.body) {
        stopEditing();
        editId = data.editId;
        startEditing();
        send('editing', { editId });
      }
    } else if (data.type === 'clear-selection' && data.editId === editId) {
      clearSelection();
    }
  });

  function onHistoryChange() {
    if (editId === undefined) return;
    clearHover();
    clearSelection();
    send('selection-cleared', { editId });
  }

  // Vue Router 使用 History API 导航时，浏览器不会触发 hashchange 或 popstate。
  for (const method of ['pushState', 'replaceState']) {
    const changeHistory = window.history[method];
    window.history[method] = function (...args) {
      const previousUrl = window.location.href;
      const result = changeHistory.apply(this, args);
      if (window.location.href !== previousUrl) onHistoryChange();
      return result;
    };
  }

  window.addEventListener('hashchange', onHistoryChange);
  window.addEventListener('popstate', onHistoryChange);
  window.addEventListener('pagehide', () => {
    if (connectionId) send('leaving');
    connectionId = undefined;
    stopEditing();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && parentOrigin) send('restored');
  });
})();
