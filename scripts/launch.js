const { execSync, spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

const ROOT        = path.join(__dirname, '..');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const IS_WIN      = process.platform === 'win32';
const args        = process.argv.slice(2);

if (!fs.existsSync(NODE_MODULES)) {
  console.log('\n📦  Instalando dependencias...\n');
  try { execSync('npm install', { cwd: ROOT, stdio: 'inherit' }); }
  catch (e) { console.error('npm install falló'); process.exit(1); }
}

function findElectron() {
  try {
    const p = require(path.join(NODE_MODULES, 'electron'));
    if (p && fs.existsSync(p)) return { bin: p, shell: false };
  } catch (e) {}
  if (IS_WIN) {
    const cmd = path.join(NODE_MODULES, '.bin', 'electron.cmd');
    if (fs.existsSync(cmd)) return { bin: cmd, shell: true };
  }
  const unix = path.join(NODE_MODULES, '.bin', 'electron');
  if (fs.existsSync(unix)) return { bin: unix, shell: false };
  return null;
}

const el = findElectron();
if (!el) { console.error('Electron no encontrado. Ejecuta: npm install'); process.exit(1); }

console.log('\n🚀  Iniciando EldoradoBot...\n');
const child = spawn(el.bin, [ROOT].concat(args), {
  cwd: ROOT, stdio: 'inherit', shell: el.shell, env: Object.assign({}, process.env),
});
child.on('error', e => { console.error('Error:', e.message); process.exit(1); });
child.on('exit',  c => process.exit(c || 0));
