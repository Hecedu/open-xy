import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as Core from '../builder/core.mjs';
import {shownControls} from '../sdk/browser/controls.mjs';
import {headerSvg} from '../sdk/browser/display.mjs';

// Exercise snapshot scheduling, caching and mode changes in the real app.
// The retained renderer and WASM transport have separate contract tests.
class Element {
  constructor(tag = 'div') { this.tag = tag; }
  children = []; attributes = {}; dataset = {}; listeners = {};
  textContent = ''; hidden = false; open = false;
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  focus() {}
  showModal() { assert.equal(this.open, false); this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
}

const original = '<g id="anim_panel"><circle id="anim_node_0" cx="0" cy="0" r="10" fill="#ff3300" stroke="#00aaff" stroke-width="1"/><circle id="anim_palette_0" cx="640" cy="0" r="1" fill="#00aaff" stroke="#ff3300" stroke-width="1"/></g>';
const grayscale = original.replaceAll('#ff3300', '#bbbbbb').replaceAll('#00aaff', '#666666');
const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0); // Public empty WASM module.
const screenTemplate = readFileSync(new URL('../sdk/platform/opxy-1.2.1/screen.svg', import.meta.url), 'utf8');
const machine = {
  id:'animated', name:'Animated', artwork:original, grayscaleArtwork:grayscale,
  controls:['Blend', 'Width', 'Level', 'Motion'],
  preview:{wasm:Buffer.from(wasm).toString('base64'), sha256:await Core.sha256(wasm), defaults:[0, 1073741824, 1395864371, 1073741824],
    graphics:{nodes:['anim_node_0'], texts:[], palette:['anim_palette_0'], paths:0, points:0}},
};

async function harness({machines = [machine], delayed = false} = {}) {
  const html = readFileSync(new URL('../builder/index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const $ = id => { assert.ok(elements.has(id), id); return elements.get(id); };
  const graphicsInput = $('grayscale-graphics');
  $('preview-graphics-grayscale').value = 'grayscale';
  $('preview-graphics-original').value = 'colorful';
  $('preview-graphics-configured').value = 'configured';
  const steps = [1, 2, 3, 4].map(step => Object.assign(new Element(), {dataset:{step:String(step)}}));
  const pages = steps.map(step => Object.assign(new Element(), {dataset:{page:step.dataset.step}}));
  const titles = ['input-title', 'machines-title', 'extensions-title', 'download-title'];
  const document = {
    hidden:false, getElementById:$, addEventListener() {},
    createElement:tag => new Element(tag), createElementNS:(_ns, tag) => new Element(tag),
    querySelectorAll:selector => ({'[data-page]':pages, '.steps button':steps, '[data-step]':steps,
      'input[name="graphics"]':[]}[selector] ?? []),
    querySelector:selector => {
      const step = /data-step="(\d)"/.exec(selector);
      if (step) return steps[Number(step[1]) - 1];
      const page = /data-page="(\d)"/.exec(selector);
      assert.ok(page, selector);
      return selector.endsWith(' h1') ? $(titles[Number(page[1]) - 1]) : pages[Number(page[1]) - 1];
    },
  };
  const blobs = new Map();
  let invalidations = 0, nextUrl = 0;
  const location = {hash:'#preview/settings', pathname:'/', search:''};
  const events = {};
  const unexpectedRuntime = () => { throw new Error('Snapshots must not schedule animation'); };
  const compilations = [], ticks = [], scenes = [], rawFrames = [], module = {};
  const retained = {headerSvg,
    PreviewDisplay:class {
      constructor(compiled) { assert.equal(compiled, module); }
      tick(input, elapsed, serial, track, reduced, activity) {
        ticks.push({input, elapsed, serial, track, reduced, activity});
        const frame = Int32Array.of(17); rawFrames.push(frame); return frame;
      }
    },
    SvgDisplay:class {
      constructor(artwork) { this.artwork = artwork; scenes.push(this); }
      header = ['', 'WIDE', '', ''];
      apply(frame) { this.frame = frame; }
      svg() { return '<g transform="translate(80 60)">' + this.artwork + '<text>Default frame ' + this.frame[0] + '</text></g>'; }
    },
  };
  const dependencies = {
    Core:{...Core, openKit:async () => { throw new Error('Fixture is configured after initialization'); }},
    Wizard:{createWizard:() => ({navigate() {}, previewLink:() => false, invalidate() { invalidations++; }})},
    Retained:retained, Visuals:{reveal() {}, graphicsExamples:() => ({elements:[], setGraphics() {}})},
    supportsDeviceApis:() => true, shownControls,
    screenTemplate, document, window:{addEventListener(type, handler) { events[type] = handler; }}, location,
    history:{replaceState() { location.hash = ''; }}, localStorage:{setItem() {}},
    matchMedia:() => ({matches:false}), requestAnimationFrame:unexpectedRuntime, cancelAnimationFrame:unexpectedRuntime,
    WebAssembly:{compile:bytes => {
      assert.deepEqual(bytes, wasm);
      return new Promise((resolve, reject) => {
        compilations.push({finish:() => resolve(module), reject});
        if (!delayed) resolve(module);
      });
    }},
    URL:{createObjectURL(blob) { const url = 'blob:preview-' + ++nextUrl; blobs.set(url, blob); return url; },
      revokeObjectURL(url) { blobs.delete(url); }},
  };
  const source = readFileSync(new URL('../builder/app.mjs', import.meta.url), 'utf8').replace(/^import .*\r?\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const app = await new AsyncFunction(...Object.keys(dependencies), source + `
    return {configure(machines, extensions = [], chosenExtensions = []) {
      selectedExtensions = [...chosenExtensions];
      kit = {machines, extensions, screenTemplate}; selected = machines.map(machine => machine.id); builderPreview = true; updateOverrideCount(); ready();
    }, graphics:() => graphics, extensions:() => [...selectedExtensions], renderEmptyExtensions:() => renderExtensions(),
      async settle() {
        for (const machine of kit.machines) {
          const cached = machineSnapshots.get(machine);
          if (cached) await Promise.allSettled(cached.artwork.values());
        }
        await Promise.resolve();
      }};`)(...Object.values(dependencies));
  app.configure(machines);
  return {
    $, app, blobs, events, compilations, ticks, scenes, rawFrames, invalidations:() => invalidations,
    artwork:index => blobs.get($('selected-previews-list').children[index].children[1].children[0].src).text(),
    figures:() => $('selected-previews-list').children,
    open:() => $('preview-selected').onclick(), close:() => $('close-selected-previews').onclick(),
    override(index, value) {
      const select = $('selected-previews-list').children[index].children[3].children[1];
      select.value = value; select.onchange();
    },
    defaultGraphics(value) {
      graphicsInput.checked = value === 'grayscale';
      graphicsInput.onchange();
    },
    compare(value) {
      const input = $(value === 'configured' ? 'preview-graphics-configured' : value === 'grayscale' ? 'preview-graphics-grayscale' : 'preview-graphics-original');
      input.checked = true; input.onchange();
    },

  };
}

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Snapshot did not reach the expected asynchronous state');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test('default UI is rendered once with default controls, frozen, and reused across comparisons and reopen', async () => {
  const h = await harness();
  h.defaultGraphics('grayscale');
  h.open(); await h.app.settle();
  assert.equal(h.figures()[0].children[1].children[0].tag, 'img');
  const gray = await h.artwork(0);
  assert.match(gray, /translate\(80 60\)/);
  assert.match(gray, /Default frame 17/);
  assert.ok(gray.includes(grayscale));
  assert.ok(gray.includes('width')); assert.ok(gray.includes('WIDE')); assert.ok(gray.includes('65'));
  assert.match(h.$('selected-previews-note').textContent, /Default UI snapshots; no animation or audio/);
  assert.equal(h.compilations.length, 1); assert.equal(h.ticks.length, 1);
  assert.deepEqual(h.ticks[0], {input:shownControls([...machine.preview.defaults, 0, 0, 0, 0], [0, 1, 2, 3]),
    elapsed:0, serial:0, track:0, reduced:true, activity:{held_notes:0, note_off_serial:0}});
  h.rawFrames[0][0] = 99; // A snapshot must not retain the WASM memory view.
  h.compare('colorful'); await h.app.settle();
  assert.ok((await h.artwork(0)).includes(original));
  assert.match(await h.artwork(0), /Default frame 17/);
  assert.equal(h.scenes.length, 2);
  assert.equal(h.scenes[0].frame, h.scenes[1].frame);
  h.compare('grayscale'); await h.app.settle();
  assert.equal(await h.artwork(0), gray);
  assert.equal(h.blobs.size, 1);
  assert.equal(h.scenes.length, 2); // Both SVG variants are cached.
  assert.equal(h.app.graphics(), 'grayscale'); assert.equal(h.invalidations(), 1);
  h.close(); assert.equal(h.blobs.size, 0); assert.equal(h.figures().length, 0);
  assert.equal(h.$('preview-graphics-original').onchange, null);
  h.open(); await h.app.settle();
  assert.equal(await h.artwork(0), gray);
  assert.equal(h.compilations.length, 1); assert.equal(h.ticks.length, 1); assert.equal(h.scenes.length, 2);
  h.events.pagehide(); assert.equal(h.blobs.size, 0); assert.equal(h.figures().length, 0);
});

test('As configured snapshots reflect mixed policies while comparison modes leave installation unchanged', async () => {
  const machines = [machine, {...machine, id:'second', name:'Second'}, {id:'stock', name:'Stock'}];
  const h = await harness({machines});
  h.defaultGraphics('colorful'); h.open();
  assert.equal(h.figures()[2].children.length, 3);
  assert.match(h.figures()[2].children[2].textContent, /Stock screen/);
  assert.equal(h.figures()[1].children[3].children[1].children[0].textContent, 'Use default (Original)');
  h.override(0, 'colorful'); h.override(1, 'grayscale'); await h.app.settle();
  const changes = h.invalidations();
  const secondUrl = h.figures()[1].children[1].children[0].src;
  h.override(0, 'default'); await h.app.settle();
  assert.equal(h.figures()[1].children[1].children[0].src, secondUrl);
  h.override(0, 'colorful'); await h.app.settle();
  const afterOverrideChanges = h.invalidations();
  assert.ok((await h.artwork(0)).includes(original)); assert.ok((await h.artwork(1)).includes(grayscale));
  h.compare('grayscale'); await h.app.settle();
  assert.ok((await h.artwork(0)).includes(grayscale)); assert.ok((await h.artwork(1)).includes(grayscale));
  h.compare('colorful'); await h.app.settle();
  assert.ok((await h.artwork(0)).includes(original)); assert.ok((await h.artwork(1)).includes(original));
  h.compare('configured'); await h.app.settle();
  assert.ok((await h.artwork(0)).includes(original)); assert.ok((await h.artwork(1)).includes(grayscale));
  assert.ok(afterOverrideChanges > changes);
  assert.equal(h.invalidations(), afterOverrideChanges); assert.equal(h.app.graphics(), 'colorful');
  h.compare('colorful'); h.override(0, 'grayscale'); await h.app.settle();
  assert.equal(h.$('preview-graphics-configured').checked, true);
  assert.ok((await h.artwork(0)).includes(grayscale));
  h.override(0, 'colorful'); h.close();
  h.app.configure(machines.slice(1)); assert.equal(h.$('graphics-overrides-count').textContent, '1 machine customized');
  h.app.configure(machines); h.defaultGraphics('grayscale'); h.open(); await h.app.settle();
  assert.equal(h.figures()[0].children[3].children[1].value, 'colorful');
  assert.equal(h.$('graphics-overrides-count').textContent, '2 machines customized');
  h.override(0, 'default'); assert.equal(h.$('graphics-overrides-count').textContent, '1 machine customized');
  assert.equal(h.ticks.length, 2);
  h.close();
});

test('latest comparison wins while rendering and closed dialogs receive no late images', async () => {
  const h = await harness({delayed:true});
  h.open(); await until(() => h.compilations.length === 1);
  h.compare('colorful'); h.close();
  h.compilations[0].finish(); await h.app.settle();
  assert.equal(h.blobs.size, 0); assert.equal(h.figures().length, 0);
  h.open(); h.compare('colorful'); await h.app.settle();
  assert.ok((await h.artwork(0)).includes(original));
  assert.equal(h.compilations.length, 1); assert.equal(h.ticks.length, 1);
  h.compare('grayscale'); h.compare('colorful'); await h.app.settle();
  assert.ok((await h.artwork(0)).includes(original));
  assert.equal(h.blobs.size, 1); h.close();
});

test('failed modules leave other snapshots usable and missing modules have an explicit static fallback', async () => {
  const h = await harness({machines:[{...machine, id:'bad', preview:{...machine.preview, sha256:'invalid'}},
    machine, {...machine, id:'static', preview:undefined}]});
  h.open(); await h.app.settle();
  assert.match(h.figures()[0].children[1].children[0].textContent, /Preview unavailable: Preview module hash mismatch/);
  assert.match(h.figures()[2].children[2].textContent, /Static artwork; rendered snapshot unavailable/);
  assert.equal(await h.artwork(2), screenTemplate.replace('</svg>', original + '</svg>'));
  assert.ok((await h.artwork(1)).includes('Default frame 17'));
  h.override(1, 'colorful'); await h.app.settle();
  assert.ok((await h.artwork(1)).includes(original));
  assert.equal(h.ticks.length, 1); h.close(); assert.equal(h.blobs.size, 0);
});

test('an invalid artwork does not hide another machine’s rendered snapshot', async () => {
  const bad = {...machine, id:'bad', artwork:original.replaceAll('#ff3300', 'url(#missing)'), grayscaleArtwork:undefined};
  const h = await harness({machines:[bad, machine]});
  h.defaultGraphics('grayscale');
  h.open(); await h.app.settle();
  assert.match(h.figures()[0].children[1].children[0].textContent, /Preview unavailable/);
  assert.ok((await h.artwork(1)).includes('Default frame 17'));
  h.close(); assert.equal(h.blobs.size, 0);
});

test('graphics stays available without firmware extensions and stays separate from their selection', async () => {
  const h = await harness();
  h.app.renderEmptyExtensions();
  assert.equal(h.$('extensions-empty').hidden, false);
  assert.notEqual(h.$('grayscale-graphics').disabled, true);
  assert.equal(h.$('preview-selected').disabled, false);
  assert.equal(h.$('extension-count').textContent, 'None selected');
  assert.equal(h.$('grayscale-graphics').checked, false);
  const summary = () => h.$('build-selection').children.map(e => e.textContent);
  assert.deepEqual(summary().slice(-4), ['Extensions', 'None', 'Machine graphics', 'Original designs']);
  h.defaultGraphics('colorful');
  assert.equal(h.$('extension-count').textContent, 'None selected');
  assert.deepEqual(h.app.extensions(), []);
  assert.equal(summary().at(-1), 'Original designs');
  h.open(); await h.app.settle();
  h.compare('grayscale'); await h.app.settle();
  assert.equal(h.app.graphics(), 'colorful');
  assert.equal(h.$('grayscale-graphics').checked, false);
  h.close();
  h.app.configure([machine], [{id:'capture', name:'Capture'}], ['capture']);
  h.defaultGraphics('grayscale');
  assert.deepEqual(h.app.extensions(), ['capture']);
  assert.equal(h.$('extension-count').textContent, '2 selected');
  assert.deepEqual(summary().slice(-4), ['Extensions', 'Capture', 'Machine graphics', 'Grayscale']);
  h.defaultGraphics('colorful');
  assert.deepEqual(h.app.extensions(), ['capture']);
  assert.equal(h.$('extension-count').textContent, '1 selected');
});
