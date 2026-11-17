// Mini reader: pop the chapter you're reading into a small window that stays on top (Windows app only).
// In that window Koru shows just the reader: no sidebar.
'use strict';
(function () {
  const { el, icon } = K;
  const isMini = new URLSearchParams(location.search).get('mini') === '1';
  if (isMini) document.documentElement.classList.add('mini');
  K.isMini = () => isMini;
  K.miniButton = () => (K.info?.platform === 'desktop' && !isMini)
    ? el('button.btn.icon', { title: 'Mini reader: keep reading in a small window on top', onclick: async () => {
        try { const r = await K.api.post('/k/mini', { hash: location.hash.slice(1) }); if (r?.error) throw new Error(r.error); }
        catch (e) { K.toast(e.message || "Couldn't open the mini reader", 'error'); }
      } }, icon('expand'))
    : null;
})();
