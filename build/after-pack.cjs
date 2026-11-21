// Runs after electron-builder lays out the app, before the installer is made.
// dxcompiler.dll (about 25 MB) is only used by WebGPU, which Koru doesn't use (WebGL goes through ANGLE and
// d3dcompiler_47.dll), so leaving it out makes the installer smaller without changing anything Koru does.
const fs = require('fs'), path = require('path');
exports.default = async ctx => {
  for (const f of ['dxcompiler.dll', 'dxil.dll']) {
    const p = path.join(ctx.appOutDir, f);
    if (fs.existsSync(p)) { fs.rmSync(p); console.log('  • left out ' + f); }
  }
};
