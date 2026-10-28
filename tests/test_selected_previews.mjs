import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as Core from '../builder/core.mjs';

// Exercise the real app and artwork selector while controlling asynchronous
// compilation and animation time. Retained drawing itself has separate tests.
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
const module = await WebAssembly.compile(wasm);
const machine = {
  id:'animated', name:'Animated', artwork:original, grayscaleArtwork:grayscale,
  controls:['Blend', 'Width', 'Level', 'Motion'],
  preview:{wasm:Buffer.from(wasm).toString('base64'), sha256:await Core.sha256(wasm), defaults:[0, 0, 0, 0],
    graphics:{nodes:['anim_node_0'], texts:[], palette:['anim_palette_0'], paths:0, points:0}},
};

async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Preview did not reach the expected asynchronous state');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

async function harness({machines = [machine], reducedMotion = false} = {}) {
  const html = readFileSync(new URL('../builder/index.html', import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const $ = id => { assert.ok(elements.has(id), id); return elements.get(id); };
  const radios = ['grayscale', 'colorful'].map(value => Object.assign(new Element('input'), {value}));
  $('preview-graphics-grayscale').value = 'grayscale';
  $('preview-graphics-original').value = 'colorful';
  const steps = [1, 2, 3, 4].map(step => Object.assign(new Element(), {dataset:{step:String(step)}}));
  const pages = steps.map(step => Object.assign(new Element(), {dataset:{page:step.dataset.step}}));
  const titles = ['input-title', 'machines-title', 'settings-title', 'download-title'];
  const document = {
    hidden:false, getElementById:$, addEventListener() {},
    createElement:tag => new Element(tag), createElementNS:(_ns, tag) => new Element(tag),
    querySelectorAll:selector => ({'[data-page]':pages, '.steps button':steps, '[data-step]':steps,
      'input[name="graphics"]':radios}[selector] ?? []),
    querySelector:selector => {
      const step = /data-step="(\d)"/.exec(selector);
      if (step) return steps[Number(step[1]) - 1];
      const page = /data-page="(\d)"/.exec(selector);
      assert.ok(page, selector);
      return selector.endsWith(' h1') ? $(titles[Number(page[1]) - 1]) : pages[Number(page[1]) - 1];
    },
  };
  const callbacks = new Map(), compilations = [], displays = [], scenes = [];
  let nextFrame = 0, invalidations = 0;
  const requestAnimationFrame = callback => { callbacks.set(++nextFrame, callback); return nextFrame; };
  const cancelAnimationFrame = handle => callbacks.delete(handle);
  const location = {hash:'#preview/settings', pathname:'/', search:''};
  const events = {};
  const retained = {
    PreviewDisplay:class {
      constructor(compiled) { assert.equal(compiled, module); displays.push(this); }
      elapsed = 0;
      tick(_input, elapsed, serial) { this.elapsed += elapsed; return {elapsed:this.elapsed, serial}; }
    },
    SvgDisplay:class {
      constructor(artwork) { this.artwork = artwork; scenes.push(this); }
      root = new Element('g'); header = [];
      apply(frame) { this.frame = {...frame}; }
    },
    headerSvg:() => '<g/>',
  };
  const dependencies = {
    Core:{...Core, openKit:async () => { throw new Error('Fixture is configured after initialization'); }},
    Wizard:{createWizard:() => ({navigate() {}, previewLink:() => false, invalidate() { invalidations++; }})},
    Retained:retained, Visuals:{reveal() {}, graphicsExamples:() => ({elements:[], setGraphics() {}})},
    supportsDeviceApis:() => true, shownControls:parameters => parameters,
    document, window:{addEventListener(type, handler) { events[type] = handler; }}, location,
    history:{replaceState() { location.hash = ''; }}, localStorage:{setItem() {}},
    matchMedia:() => ({matches:reducedMotion}), requestAnimationFrame, cancelAnimationFrame,
    WebAssembly:{compile:bytes => new Promise((resolve, reject) => {
      assert.deepEqual(bytes, wasm);
      compilations.push({finish:() => resolve(module), reject});
    })},
  };
  const source = readFileSync(new URL('../builder/app.mjs', import.meta.url), 'utf8').replace(/^import .*\r?\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const app = await new AsyncFunction(...Object.keys(dependencies), source + `
    return {configure(machines) {
      kit = {machines}; selected = machines.map(machine => machine.id); builderPreview = true; ready();
    }, graphics:() => graphics};`)(...Object.values(dependencies));
  app.configure(machines);
  return {
    $, app, compilations, displays, scenes, callbacks, events, invalidations:() => invalidations,
    figures:() => $('selected-previews-list').children,
    open:() => $('preview-selected').onclick(), close:() => $('close-selected-previews').onclick(),
    compare(value) {
      const input = $(value === 'grayscale' ? 'preview-graphics-grayscale' : 'preview-graphics-original');
      input.checked = true; input.onchange();
    },
    frame(time) {
      const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(callback => callback(time));
    },
  };
}

test('animated modal swaps artwork without recompiling, resetting animation, or changing installation settings', async () => {
  const h = await harness();
  await h.open();
  await until(() => h.compilations.length === 1);
  h.compilations[0].finish();
  await until(() => h.scenes.length === 1);
  assert.equal(h.scenes[0].artwork, grayscale);
  const canvas = h.figures()[0].children[1].children[0];
  h.frame(34); h.frame(68); canvas.onclick();
  const pose = {...h.scenes.at(-1).frame};
  assert.ok(pose.elapsed > 0); assert.equal(pose.serial, 2);
  h.compare('colorful');
  assert.equal(h.scenes.at(-1).artwork, original);
  assert.deepEqual(h.scenes.at(-1).frame, pose);
  assert.equal(h.figures()[0].children[1].children[0], canvas);
  h.compare('grayscale');
  assert.equal(h.scenes.at(-1).artwork, grayscale);
  assert.deepEqual(h.scenes.at(-1).frame, pose);
  assert.equal(h.displays.length, 1); assert.equal(h.compilations.length, 1);
  assert.equal(h.app.graphics(), 'grayscale'); assert.equal(h.invalidations(), 0);
  assert.equal(h.$('selected-previews').open, true);
  h.close();
  assert.equal(h.callbacks.size, 0);
  assert.equal(h.$('preview-graphics-original').onchange, null);
});

test('changing the modal toggle during compilation uses the latest choice when ready', async () => {
  const h = await harness();
  await h.open();
  await until(() => h.compilations.length === 1);
  h.compare('colorful');
  h.compilations[0].finish();
  await until(() => h.scenes.length === 1);
  assert.equal(h.scenes[0].artwork, original);
  assert.equal(h.figures()[0].children[2].textContent, 'Original design');
  assert.equal(h.$('selected-previews').open, true);
  assert.equal(h.app.graphics(), 'grayscale');
  h.close();
});

test('closing and reopening during compilation rejects stale results and restarts with the installation choice', async () => {
  const h = await harness();
  await h.open();
  await until(() => h.compilations.length === 1);
  h.compare('colorful'); h.close();
  assert.equal(h.figures().length, 0);
  await h.open();
  await until(() => h.compilations.length === 2);
  h.compilations[0].finish();
  // A later queued promise confirms the earlier result has settled too.
  h.compilations[1].finish();
  await until(() => h.scenes.length === 1);
  assert.equal(h.displays.length, 1); assert.equal(h.figures().length, 1);
  assert.equal(h.scenes[0].artwork, grayscale);
  assert.equal(h.callbacks.size, 1);
  h.close();
  assert.equal(h.callbacks.size, 0);
});

test('one compilation failure leaves other selected animated previews and their toggle working', async () => {
  const h = await harness({machines:[{...machine, id:'first', name:'First'}, {...machine, id:'second', name:'Second'}]});
  await h.open();
  await until(() => h.compilations.length === 2);
  h.compilations[0].reject(new Error('Unavailable module'));
  h.compilations[1].finish();
  await until(() => h.scenes.length === 1);
  // Hashing may finish in either order; either machine can fail independently.
  assert.equal(h.figures().filter(figure => /Preview unavailable: Unavailable module/.test(figure.children[1].children[0].textContent)).length, 1);
  assert.equal(h.figures().filter(figure => figure.children[1].children[0].tag === 'svg').length, 1);
  h.compare('colorful');
  assert.equal(h.scenes.at(-1).artwork, original);
  assert.equal(h.displays.length, 1);
  h.close();
});

test('reduced-motion previews update and trigger without scheduling animation, and pagehide disposes them', async () => {
  const h = await harness({reducedMotion:true});
  await h.open();
  await until(() => h.compilations.length === 1);
  h.compilations[0].finish();
  await until(() => h.scenes.length === 1);
  assert.equal(h.callbacks.size, 0);
  const canvas = h.figures()[0].children[1].children[0];
  canvas.onkeydown({key:'Enter', preventDefault() {}});
  assert.equal(h.scenes.at(-1).frame.serial, 2);
  h.compare('colorful');
  assert.equal(h.scenes.at(-1).frame.serial, 2);
  assert.equal(h.callbacks.size, 0);
  h.events.pagehide();
  assert.equal(h.figures().length, 0);
  assert.equal(h.$('preview-graphics-grayscale').onchange, null);
});
