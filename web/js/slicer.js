// Koru page slicer (runs in a background worker). Decodes a page file and draws it straight into the
// reader's slice canvases from here, so the main thread never touches the big pictures.
'use strict';
const pics = new Map(), canv = new Map();
onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'decode') {
      const b = await createImageBitmap(m.blob);
      pics.set(m.id, b);
      // tiny picture for the ambient light
      const sh = Math.min(b.height, Math.round(b.width * m.ah / m.aw)), sy = Math.round((b.height - sh) / 2);
      const amb = await createImageBitmap(b, 0, sy, b.width, sh, { resizeWidth: m.aw, resizeHeight: m.ah, resizeQuality: 'low' });
      postMessage({ type: 'size', id: m.id, w: b.width, h: b.height, amb }, [amb]);
    } else if (m.type === 'draw') {
      const b = pics.get(m.id);
      if (!b) { postMessage({ type: 'drawn', id: m.id }); return; }
      pics.delete(m.id);
      m.canvases.forEach((oc, k) => {
        const y = k * m.slice;
        oc.getContext('2d', { alpha: false }).drawImage(b, 0, y, oc.width, oc.height, 0, 0, oc.width, oc.height);
      });
      b.close();
      canv.set(m.id, m.canvases);
      postMessage({ type: 'drawn', id: m.id });
    } else if (m.type === 'thumb') {
      const src = await createImageBitmap(m.blob);
      const w = Math.min(m.w, src.width), h = Math.max(1, Math.round(src.height * w / src.width));
      const oc = new OffscreenCanvas(w, h), c = oc.getContext('2d');
      c.imageSmoothingQuality = 'high';
      c.drawImage(src, 0, 0, w, h);
      src.close();
      const blob = await oc.convertToBlob({ type: 'image/webp', quality: 0.86 });
      postMessage({ type: 'thumb', id: m.id, blob });
    } else if (m.type === 'free') {
      pics.get(m.id)?.close(); pics.delete(m.id);
      for (const oc of canv.get(m.id) || []) { oc.width = 0; oc.height = 0; }
      canv.delete(m.id);
    }
  } catch (e) { postMessage({ type: 'error', id: m.id, error: String(e && e.message || e) }); }
};
