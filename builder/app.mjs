import * as Core from './core.mjs';
import * as Wizard from './wizard.mjs';
import * as Retained from '../sdk/browser/display.mjs';
import * as Visuals from './visuals.mjs';
import {Audition} from './audition.mjs';
import {shownControls} from '../sdk/browser/controls.mjs';
import {supportsDeviceApis} from './browser.mjs';

const $ = id => document.getElementById(id);
document.querySelectorAll('[data-icon]').forEach(el => el.append(Visuals.icon(el.dataset.icon)));
document.querySelectorAll('[data-device-art]').forEach(el => el.append(Visuals.device()));
// Preview links can show the guide immediately; using the builder still needs acknowledgement.
let acknowledged = false;
const browserAllowed = supportsDeviceApis();
$('browser-blocked').hidden = browserAllowed;
$('risk-acknowledgement').checked = false;
$('risk-acknowledgement').disabled = !browserAllowed;
$('risk-continue').disabled = true;
const colors = ['var(--machine-1)', 'var(--machine-2)', 'var(--machine-3)', 'var(--machine-4)'];
const kib = n => (n / 1024).toFixed(1) + ' KiB';
let kit, stock, catalog, selected = [], inspected, linked, downloadUrl, built, layout, revision = 0;
// The machine numbers of this person's firmware (core.mjs assignNumbers): from their
// last build here, or a layout.json they load. Kept in this browser as a convenience;
// the layout.json in every download is the record.
const NUMBERS_KEY = 'open-xy-machine-numbers';
let numbers = null;
function rememberNumbers(value) {
  numbers = value;
  try { localStorage.setItem(NUMBERS_KEY, JSON.stringify({profile: kit.profile.id, machines: value})); } catch {}
}
let stopPreview = () => {}, previewRevision = 0;
let stopAudio = () => {};
window.addEventListener('blur', () => stopAudio());
window.addEventListener('pagehide', () => stopPreview());
document.addEventListener('visibilitychange', () => { if (document.hidden) stopAudio(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') stopAudio(); });
const status = (message = '', error = false) => { $('status').textContent = message; $('status').dataset.error = String(error); };
const fail = error => status(error.message || String(error), true);
function invalidate() {
  wizard.invalidate();
  revision++; layout = built = null;
  if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
  $('download').removeAttribute('href');
  $('flow-download').removeAttribute('href');
  document.querySelector('[data-step="3"]').disabled = true;
}
function navigate(step) {
  stopAudio();
  wizard.navigate(step);
  document.querySelectorAll('[data-page]').forEach(p => p.hidden = Number(p.dataset.page) !== step);
  document.querySelectorAll('.steps button').forEach(b => {
    if (Number(b.dataset.step) === step) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
  });
  document.querySelector(`[data-page="${step}"] h1`).focus();
  Visuals.reveal(document.querySelector(`[data-page="${step}"]`));
}
function ready() {
  $('choose').disabled = !(kit && stock);
  document.querySelector('.steps [data-step="2"]').disabled = $('choose').disabled;
  $('build').disabled = !(stock && linked);
}

const wizard = Wizard.createWizard({getKit: () => kit, getSelected: () => selected, hasDownload: () => !!downloadUrl, getFiles: () => built,
  onFirmware: (file, isCurrent) => acceptFirmware(file, isCurrent),
  onPreviewExit() {
    history.replaceState(null, '', location.pathname + location.search);
    if (acknowledged) navigate(1); else showEntryGate();
  },
});
function showEntryGate() {
  wizard.navigate(1);
  $('browser-gate').hidden = browserAllowed;
  $('risk-gate').hidden = !browserAllowed;
  $('phase-nav').hidden = true;
  $('builder-workspace').hidden = true;
  $('builder-workspace').inert = true;
}
function openPreviewLink() {
  if (wizard.previewLink(location.hash)) {
    $('browser-gate').hidden = true;
    $('risk-gate').hidden = true;
    $('builder-workspace').hidden = false;
    $('builder-workspace').inert = false;
    if (!acknowledged) $('status').textContent = '';
    navigate(wizard.previewPage());
  } else if (!acknowledged) showEntryGate();
}
window.addEventListener('hashchange', openPreviewLink);
openPreviewLink();
// Keep the full builder paused while browsing preview links. Leaving a preview
// returns to this unchecked notice instead of treating the preview as consent.
await new Promise(resolve => {
  $('risk-acknowledgement').onchange = () => {
    $('risk-continue').disabled = !browserAllowed || !$('risk-acknowledgement').checked;
  };
  $('risk-form').onsubmit = event => {
    event.preventDefault();
    if (!browserAllowed || !$('risk-acknowledgement').checked || !$('risk-form').reportValidity()) return;
    acknowledged = true;
    $('risk-gate').hidden = true;
    $('phase-nav').hidden = false;
    $('builder-workspace').hidden = false;
    $('builder-workspace').inert = false;
    navigate(1);
    resolve();
  };
});

async function readBounded(file, limit) {
  Core.requireThat(file && file.size > 0 && file.size <= limit, 'Missing or oversized file');
  return new Uint8Array(await file.arrayBuffer());
}
let ticket = 0;
async function acceptFirmware(file, isCurrent = () => true) {
  if (!file || !kit || !isCurrent()) return false;
  wizard.clearSourceBackup();
  const current = ++ticket; invalidate();
  stock = null; ready();
  wizard.setFirmwareState('checking');
  $('firmware-result').textContent = 'Verifying ' + file.name + '…';
  try {
    const recovered = await Core.recoverFirmware(kit, await readBounded(file, 16 * 1024 ** 2), numbers);
    if (current !== ticket || !isCurrent()) return false;
    stock = recovered.stock;
    if (recovered.selected) {
      selected = recovered.selected; renderMachines(); recalculate();
      $('firmware-result').textContent = '✓ open-xy OS with ' +
        kit.machines.filter(m => selected.includes(m.id)).map(m => m.name).join(' + ');
    } else $('firmware-result').textContent = '✓ OP–XY OS 1.2.0 verified · ' + file.name;
    wizard.setFirmwareState('loaded');
    $('files-title').focus();
    status(); ready();
    return true;
  } catch (error) {
    if (current !== ticket || !isCurrent()) return false;
    $('firmware-result').textContent = 'OS not loaded';
    fail(error); ready();
    return false;
  } finally {
    if (current === ticket && !stock) {
      wizard.setFirmwareState('empty');
      $('firmware-result').textContent = 'OS not loaded';
    }
  }
}
function node(tag, text, className) {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text;
  if (className) el.className = className; return el;
}
function facts(target, values) {
  target.replaceChildren(...Object.entries(values).flatMap(([name, value]) => [node('dt', name), node('dd', value)]));
}
async function inspect(id) {
  stopPreview();
  const ticket = ++previewRevision;
  inspected = id; const m = kit.machines.find(x => x.id === id);
  $('detail-kind').textContent = {synth: 'Synthesizer', effect: 'Send effect', sample: 'Sample engine'}[m.kind];
  $('detail-name').textContent = m.name; $('detail-description').textContent = m.description;
  // Who makes it and where its code lives: a catalog machine links to its pinned commit.
  if (m.origin === 'catalog') {
    const link = node('a', Core.sourceName(m.source) + ' ' + m.source.tag);
    link.href = Core.sourceUrl(m.source); link.target = '_blank'; link.rel = 'noopener noreferrer';
    $('detail-source').replaceChildren('Community machine by ' + m.source.maintainer + ' · ', link);
  } else $('detail-source').textContent = m.origin === 'bundled' ? 'Bundled with Open-XY' : 'Your machine, from this kit';
  $('art-preview').replaceChildren();
  $('audition-controls').replaceChildren();
  stopAudio = () => {};
  if (m.preview) {
    $('art-caption').textContent = 'Audition the sound and screen. The OP–XY’s own envelopes and effects aren’t included.';
  } else {
    $('art-preview').append(node('span', 'No browser preview for this machine yet.', 'art-placeholder'));
    $('art-caption').textContent = '';
  }
  $('controls').replaceChildren(...m.controls.map(c => node('div', c, 'control')));
  const own = kit.objects.filter(o => o.owner === id).flatMap(o => o.sections.filter(s => s.group));
  facts($('machine-facts'), {'Code and data': kib(own.filter(s => s.type !== 8).reduce((n, s) => n + s.size, 0)),
    'Working memory': kib(own.filter(s => s.type === 8).reduce((n, s) => n + s.size, 0)),
    // The numbers this selection gives it, or those it asks for.
    ...(own => ({[m.kind === 'effect' ? 'Effect number' : 'Engine number']: own.effect ?? own.engine, 'Page': own.page}))(
      linked?.numbers?.[m.id] ?? m.identity),
    ...(m.origin === 'catalog' ? {'Release': m.source.tag, 'Commit': m.source.commit.slice(0, 12)} : {})});
  document.querySelectorAll('.machine button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
  if (m.preview) {
    try {
      const wasm = Core.decode64(m.preview.wasm);
      Core.requireThat(await Core.sha256(wasm) === m.preview.sha256, 'Preview module hash mismatch');
      const compiled = await WebAssembly.compile(wasm);
      if (ticket !== previewRevision) return;
      const display = new Retained.PreviewDisplay(compiled);
      const renderer = new Retained.SvgDisplay(m.artwork, m.preview.graphics);
      const ns = 'http://www.w3.org/2000/svg', canvas = document.createElementNS(ns, 'svg');
      canvas.setAttribute('viewBox', '0 0 480 220'); canvas.setAttribute('aria-label', m.name + ' display preview');
      // The device page: the machine's drawing under the stock four-control header.
      const header = document.createElementNS(ns, 'g');
      canvas.append(renderer.root, header); $('art-preview').replaceChildren(canvas);
      // Eight parameter words; each control position shows the parameter last edited there.
      const parameters = Object.assign(Array(8).fill(0), m.preview.defaults), shown = [0, 1, 2, 3];
      let serial = 0, previous = 0, handle, cancelled = false;
      // A small keyboard from middle C: a key plays its note while held. The preview plays
      // one note at a time, the newest held key; letting it go returns to the one before.
      const names = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'], held = [];
      const keyboard = node('div', undefined, 'preview-keys');
      keyboard.id = 'preview-keys'; keyboard.setAttribute('role', 'group'); keyboard.setAttribute('aria-label', 'Preview keyboard');
      for (let note = 60; note <= 77; note++) {
        const black = [1, 3, 6, 8, 10].includes(note % 12), name = names[note % 12] + (Math.floor(note / 12) - 1);
        const key = node('button', note % 12 === 0 ? name : undefined, 'preview-key' + (black ? ' black' : ''));
        key.type = 'button'; key.setAttribute('aria-label', name);
        const press = () => {
          if (key.dataset.down === 'true') return;
          key.dataset.down = 'true'; held.push(note); trigger(); audio.play(note);
        };
        const lift = () => {
          if (key.dataset.down !== 'true') return;
          key.dataset.down = 'false';
          const sounding = held.at(-1) === note;
          held.splice(held.indexOf(note), 1);
          if (sounding && held.length) audio.play(held.at(-1)); else audio.release(note);
        };
        key.onpointerdown = e => { e.preventDefault(); key.setPointerCapture(e.pointerId); key.focus(); press(); };
        key.onpointerup = key.onpointercancel = key.onlostpointercapture = lift;
        key.onkeydown = e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) press(); } };
        key.onkeyup = e => { if (e.key === ' ' || e.key === 'Enter') lift(); };
        key.onblur = lift;
        keyboard.append(key);
      }
      const volume = node('label', 'Volume', 'audition-volume'), level = node('input');
      level.type = 'range'; level.min = '0'; level.max = '100'; level.value = '50'; level.setAttribute('aria-label', 'Preview volume');
      volume.append(level);
      const audio = new Audition(compiled, parameters, (playing, error) => {
        if (!cancelled) frame(0);
        if (error && ticket === previewRevision) $('art-caption').textContent = 'Audio unavailable: ' + error;
      });
      stopAudio = () => audio.stop();
      level.oninput = () => audio.setVolume(Number(level.value) / 100);
      $('audition-controls').append(keyboard, volume);
      const reduced = matchMedia('(prefers-reduced-motion: reduce)');
      function frame(dt = 34) {
        const input = shownControls(parameters, shown);
        // The preview is one track: a changing track would tell the machine to start over.
        renderer.apply(display.tick(input, dt, serial, 0, reduced.matches));
        // The machine's header text, or the stock percentage of the shown parameter.
        header.innerHTML = Retained.headerSvg(shown.map(slot => m.controls[slot].toLowerCase()),
          shown.map((slot, i) => renderer.header[i] || String(Math.round(parameters[slot] / 0x7fffffff * 100))));
      }
      const controls = m.controls.map((name, i) => {
        const label = node('label', name, 'preview-control'), input = node('input');
        input.type = 'range'; input.min = '0'; input.max = '1000'; input.step = '1';
        input.value = String(parameters[i] / 0x7fffffff * 1000); input.setAttribute('aria-label', name + ' preview');
        input.oninput = () => {
          parameters[i] = Math.round(Number(input.value) / 1000 * 0x7fffffff); shown[m.positions[i]] = i;
          frame(0); audio.setParameters(parameters);
        };
        label.append(input); return label;
      });
      $('controls').replaceChildren(...controls);
      const trigger = () => { serial = serial + 1 >>> 0; frame(0); };
      canvas.setAttribute('role', 'button'); canvas.setAttribute('tabindex', '0'); canvas.setAttribute('aria-label', 'Trigger ' + m.name + ' display preview');
      canvas.onclick = trigger; canvas.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); } };
      frame(0); trigger();
      function animate(time) {
        if (cancelled) return;
        if (time - previous >= 32 && !document.hidden && !document.querySelector('[data-page="2"]').hidden) {
          frame(Math.min(100, Math.round((time - previous) * 1024 / 1000))); previous = time;
        }
        handle = requestAnimationFrame(animate);
      }
      if (!reduced.matches) handle = requestAnimationFrame(animate);
      stopPreview = () => { cancelled = true; cancelAnimationFrame(handle); audio.destroy(); };
    } catch (error) { if (ticket === previewRevision) $('art-caption').textContent = 'Display preview unavailable: ' + error.message; }
  }
}
function renderMachines(filter = 'all') {
  $('machines').style.setProperty('--machine-count', kit.machines.length);
  $('machines').replaceChildren();
  kit.machines.forEach((m, index) => {
    if (filter !== 'all' && m.kind !== filter) return;
    const row = node('article', undefined, 'machine' + (selected.includes(m.id) ? ' selected' : ''));
    row.style.setProperty('--machine', colors[index % colors.length]);
    const label = node('label'), input = node('input'); input.type = 'checkbox'; input.checked = selected.includes(m.id);
    input.setAttribute('aria-label', 'Include ' + m.name); label.append(input);
    const button = node('button'); button.dataset.id = m.id; button.setAttribute('aria-pressed', String(inspected === m.id));
    button.append(node('span', m.name, 'machine-name'), node('span', m.description, 'machine-desc'));
    const meta = node('span', undefined, 'machine-meta');
    meta.append(node('span', {synth: 'Synth', effect: 'Effect', sample: 'Sample'}[m.kind]), node('span', m.controls.length + (m.controls.length === 1 ? ' control' : ' controls')));
    const ownBytes = kit.objects.filter(o => o.owner === m.id)
      .flatMap(o => o.sections.filter(s => s.group)).reduce((total, s) => total + s.size, 0);
    const memory = node('span', kib(ownBytes), 'machine-memory');
    memory.title = 'Code, data and working memory. Shared code is counted separately below.';
    meta.append(memory);
    if (m.origin !== 'bundled') meta.append(node('span', m.origin === 'catalog' ? 'Community' : 'Yours', 'machine-origin'));
    button.append(meta); button.onclick = () => inspect(m.id);
    input.onchange = () => {
      selected = input.checked ? [...selected, m.id] : selected.filter(id => id !== m.id);
      row.classList.toggle('selected', input.checked); invalidate(); recalculate();
    };
    const glyph = node('span', undefined, 'machine-icon');
    glyph.append(Visuals.icon(m.kind, m.icon));
    row.append(label, glyph, button); $('machines').append(row);
  });
}
function recalculate() {
  linked = null; $('selection-count').textContent = selected.length + ' selected';
  $('memory-map').replaceChildren(); $('memory-legend').replaceChildren();
  try {
    if (!selected.length) { $('room-value').textContent = 'Choose at least one machine'; $('capacity-details').replaceChildren(); ready(); return; }
    linked = Core.linkKit(kit, selected, numbers);
    const allocations = kit.machines.filter(m => selected.includes(m.id)).map(m => ({name: m.name,
      size: linked.segments.filter(s => s.owner === m.id).reduce((n, s) => n + s.size, 0),
      color: colors[kit.machines.indexOf(m) % colors.length]}));
    allocations.push({name: 'Shared', size: linked.sizes.allocated - allocations.reduce((n, a) => n + a.size, 0), color: 'var(--shared)'},
      {name: 'Available', size: linked.sizes.available, color: 'var(--paper)'}, {name: 'System', size: kit.profile.table_bytes, color: 'var(--tables)'});
    for (const a of allocations) {
      const segment = node('div', undefined, 'memory-segment'); segment.style.width = a.size / kit.profile.reserved_bytes * 100 + '%';
      segment.style.background = a.color; segment.title = a.name + ': ' + kib(a.size); $('memory-map').append(segment);
      const legend = node('span', a.name + ' ' + kib(a.size)); legend.style.setProperty('--swatch', a.color); $('memory-legend').append(legend);
    }
    $('room-value').textContent = kib(linked.sizes.allocated) + ' of ' + kib(Core.moduleBytes(kit.profile)) + ' used';
    $('memory-map').setAttribute('aria-label', allocations.map(a => a.name + ': ' + kib(a.size)).join(', '));
    facts($('capacity-details'), {'Code and data': kib(linked.sizes.initialized),
      'Working memory': kib(linked.sizes.bss),
      'Available': kib(linked.sizes.available)});
    status();
  } catch (error) { $('room-value').textContent = 'Selection cannot be built'; fail(error); }
  ready();
}
async function build() {
  const ticket = revision; $('build').disabled = true; status('Linking and checking your build…');
  try {
    const selection = [...selected], result = Core.linkKit(kit, selection, numbers);
    const files = await Core.buildAssets(kit, selection, catalog, result.numbers);
    files['os.ldr'] = await Core.patchFirmware(kit, result, stock);
    const hashes = {};
    for (const [name, bytes] of Object.entries(files)) hashes[name] = await Core.sha256(bytes);
    // Every number this firmware has given out, for the next build (Core.readLayout).
    const nextLayout = {format: 'opxy-layout/1', profile: kit.profile.id, selected: selection, machines: result.numbers};
    const encode = value => new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n');
    files['layout.json'] = encode(nextLayout);
    files['build.json'] = encode({format: 'opxy-kit-build/1', version: kit.version, source_sha256: kit.profile.stock_sha256,
      sizes: result.sizes, files: hashes, hardware_qualified: false, cpu_measured: false});
    const zip = Core.zipFiles(files);
    if (ticket !== revision) return;
    layout = nextLayout; built = files; rememberNumbers(result.numbers); downloadUrl = URL.createObjectURL(new Blob([zip], {type: 'application/zip'}));
    $('download').href = $('flow-download').href = downloadUrl;
    $('download-summary').textContent = kit.machines.filter(m => selection.includes(m.id)).map(m => m.name).join(' + ');
    $('bundle-art').replaceChildren(Visuals.bundle(Object.keys(files)));
    $('output-hash').textContent = 'OS (os.ldr) SHA-256: ' + hashes['os.ldr'];
    document.querySelector('.steps [data-step="3"]').disabled = false;
    status(); navigate(3);
  } catch (error) { if (ticket === revision) fail(error); } finally { ready(); }
}
document.querySelectorAll('[data-step]').forEach(b => b.onclick = () => navigate(Number(b.dataset.step)));
$('choose').onclick = () => { navigate(2); recalculate(); };
$('build').onclick = build;
$('firmware').onchange = e => acceptFirmware(e.target.files[0]);
const drop = $('firmware-drop');
for (const type of ['dragover', 'dragleave', 'drop']) drop.addEventListener(type, e => {
  e.preventDefault(); drop.dataset.drag = String(type === 'dragover');
  if (type === 'drop') acceptFirmware(e.dataTransfer.files[0]);
});
document.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-filter]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  renderMachines(b.dataset.filter);
});
$('restore').onchange = async e => {
  try {
    const saved = JSON.parse(new TextDecoder().decode(await readBounded(e.target.files[0], 65536)));
    const loaded = Core.readLayout(kit, saved);
    rememberNumbers(loaded.machines);
    if (loaded.selected) selected = [...loaded.selected];
    invalidate(); renderMachines(); recalculate();
    status('Layout loaded: your machines keep their numbers.');
  } catch (error) { fail(error); }
};
$('save-layout').onclick = () => {
  if (!layout) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(layout, null, 2)], {type: 'application/json'}));
  const a = node('a'); a.href = url; a.download = 'layout.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
try {
  const data = $('kit-data').textContent.trim();
  Core.requireThat(data, 'The machines couldn’t load. Reload this page.');
  kit = await Core.openKit(JSON.parse(data));
  // A tap opens the memory breakdown on screens without hover.
  document.querySelector('.memory-bar').onclick = e => e.currentTarget.classList.toggle('open');
  $('builder-version').textContent = 'v' + kit.version;
  selected = kit.machines.map(machine => machine.id);
  try {
    const remembered = JSON.parse(localStorage.getItem(NUMBERS_KEY) ?? 'null');
    if (remembered) numbers = Core.readLayout(kit, {format: 'opxy-layout/1', ...remembered}).machines;
  } catch { numbers = null; }
  catalog = Core.decode64(kit.stockCatalog);
  $('notices').textContent = kit.notices;
  $('notices').closest('details').hidden = false;
  renderMachines(); inspect(kit.machines[0].id); recalculate();
} catch (error) { fail(error); }
openPreviewLink();
