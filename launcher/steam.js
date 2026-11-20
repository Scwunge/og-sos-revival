// Steam install lookup shared by launcher/launcher.js and tools/host_classic.js.
'use strict';
const fs = require('fs');
const path = require('path');

const STEAM_DIR = 'C:\\Program Files (x86)\\Steam';
const APPS = {
  main: { id: '619080', name: 'SOS', dir: 'SOS' },
  classic: { id: '802240', name: 'SOS: Classic', dir: 'SOS Test Server' },
};

// Find a Steam app's install folder from libraryfolders.vdf and appmanifest_<id>.acf.
function findSteamApp(app) {
  const libs = [STEAM_DIR];
  try {
    const vdf = fs.readFileSync(path.join(STEAM_DIR, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, '\\'));
  } catch { /* no Steam here */ }
  for (const lib of libs) {
    try {
      const acf = fs.readFileSync(path.join(lib, 'steamapps', `appmanifest_${app.id}.acf`), 'utf8');
      const dir = acf.match(/"installdir"\s+"([^"]+)"/);
      if (dir) return path.join(lib, 'steamapps', 'common', dir[1]);
    } catch { /* not in this library */ }
  }
  return path.join(STEAM_DIR, 'steamapps', 'common', app.dir);
}

module.exports = { STEAM_DIR, APPS, findSteamApp };
