"""Submission defaults survive repository fetching and both packaging paths."""
import contextlib
import copy
from dataclasses import replace
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from tooling import native, presets
from tooling.adapters import catalog_entry
from tooling.machines import ROOT, discovered, machine, machine_at
from tooling.custom_preview import scaffold


class Presets(unittest.TestCase):
    def test_native_and_browser_install_the_authored_preset_identically(self):
        profile, machines, _ = native.configuration()
        # An authored patch need not equal the definition's control defaults.
        authored = copy.deepcopy(machines[0].default_preset)
        authored['engine']['params'][0] = 7312
        authored['envelope']['amp']['attack'] = 987
        machines[0] = replace(machines[0], default_preset=authored)
        catalog = (ROOT / 'profiles/opxy-1.2.0/content/op1_factory.json').read_bytes()
        assets = native.prepare_assets(catalog, profile, machines)
        kit = dict(profile=profile, machines=[dict(id=m.id, kind=m.kind, catalog=catalog_entry(m),
                   origin='catalog', defaultPreset=presets.default(m)) for m in machines])
        script = """
import {buildAssets} from './builder/core.mjs';
let input = ''; for await (const part of process.stdin) input += part;
const {kit, catalog, numbers} = JSON.parse(input);
const files = await buildAssets(kit, kit.machines.map(m => m.id), Buffer.from(catalog, 'base64'), numbers);
console.log(JSON.stringify(Object.fromEntries(Object.entries(files).map(([p, b]) => [p, Buffer.from(b).toString('hex')]))));
"""
        import base64
        result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT,
                                input=json.dumps(dict(kit=kit, catalog=base64.b64encode(catalog).decode(),
                                                      numbers={m.id: m.identity for m in machines})),
                                text=True, capture_output=True, check=True)
        browser = json.loads(result.stdout)
        for m in machines:
            if m.kind == 'effect':
                self.assertEqual(presets.assets(m), {})
                continue
            path = f'content/presets/{m.id}/default.json'
            self.assertEqual(bytes.fromhex(browser[path]), assets[path])
            self.assertEqual(json.loads(assets[path]), m.default_preset)

    def test_bundled_and_started_instruments_have_defaults_but_effects_do_not(self):
        for m in discovered():
            presets.require_default(m)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / 'probe'
            with contextlib.redirect_stdout(io.StringIO()):
                scaffold(root, 'probe', 'Probe')
            m = machine_at(root)
            presets.require_default(m)
            self.assertIn('external/probe/presets/default.json', m.files())
            (root / presets.SOURCE).unlink()
            m = machine_at(root)
            with self.assertRaisesRegex(ValueError, 'submissions need'):
                presets.require_default(m)
            self.assertEqual(presets.default(m)['type'], 'probe')  # old personal machines
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(presets.main(['--machine', str(root), '--out', str(root / presets.SOURCE)]), 0)
                before = (root / presets.SOURCE).read_bytes()
                self.assertEqual(presets.main(['--machine', str(root), '--out', str(root / presets.SOURCE)]), 1)
                self.assertEqual((root / presets.SOURCE).read_bytes(), before)

    def test_invalid_defaults_fail_in_python_and_browser(self):
        original = machine('fm2op').default_preset
        cases = [None, {}, dict(original, type='other'), dict(original, version=True),
                 dict(original, regions=[{'sample': '../../user/private.wav'}]), dict(original, mtime=0)]
        for path, value in ((('engine', 'params'), [0]), (('engine', 'params'), [True] * 8),
                            (('engine', 'params'), [32768] * 8), (('engine', 'params'), [0.5] * 8),
                            (('engine', 'params'), [-1] * 8), (('envelope', 'amp', 'release'), None),
                            (('fx', 'active'), 1), (('engine', 'playmode'), 'unknown')):
            broken = copy.deepcopy(original)
            target = broken
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            cases.append(broken)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValueError):
                presets.validate(value, 'fm2op')
        script = """
import {buildAssets, sha256} from './builder/core.mjs';
let input = ''; for await (const part of process.stdin) input += part;
const catalog = new TextEncoder().encode('{"engine_types":[{"type":"stock"}],"fx_types":[{"type":"stock-fx"}]}');
const text = new TextDecoder().decode(catalog);
const profile = {stock_catalog_sha256: await sha256(catalog),
  stock_catalog_inserts: {engine_types: text.indexOf(']'), fx_types: text.lastIndexOf(']')}};
for (const defaultPreset of JSON.parse(input)) {
  const m = {id: 'fm2op', kind: 'synth', origin: 'catalog', defaultPreset,
    catalog: ',{"type":"fm2op","default_params":[0,0,0,0,0,0,0,0]}'};
  try { await buildAssets({machines:[m], profile}, ['fm2op'], catalog, {}); process.exit(1); }
  catch (error) { if (!/presets\\/default.json/.test(error.message)) throw error; }
}
"""
        result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT, input=json.dumps(cases),
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
