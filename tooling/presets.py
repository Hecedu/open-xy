"""Repository-owned instrument defaults and their device installation paths."""
import argparse
import json
from pathlib import Path
import sys

from .formats import require

SOURCE = 'presets/default.json'


def initial(identity, params, amp=None):
    """An authored, sample-free version-4 init; no stock preset data."""
    return {
        'engine': {
            'bendrange': 8191, 'highpass': 0,
            'modulation': {source: {'amount': 16384, 'target': 0}
                           for source in ('aftertouch', 'modwheel', 'pitchbend', 'velocity')},
            'params': list(params), 'playmode': 'poly',
            'portamento.amount': 0, 'portamento.type': 0, 'transpose': 0,
            'tuning.root': 0, 'tuning.scale': 0, 'velocity.sensitivity': 0, 'volume': 16384, 'width': 0,
        },
        'envelope': {
            # The device stores its minimum amp release as 32767.
            'amp': dict(attack=128, decay=8192, release=32767, sustain=32767) | (amp or {}),
            'filter': dict(attack=0, decay=0, release=0, sustain=32767),
        },
        'fx': dict(active=False, params=[0, 0, 0, 0, 0, 32767, 0, 0], type='svf'),
        'lfo': dict(active=False, params=[0] * 8, type='value'),
        'octave': 0, 'platform': 'OP-XY', 'regions': [], 'type': identity, 'version': 4,
    }


def validate(value, identity):
    """The supported init structure: bounded values, exact engine, no sample references.

    Mirrors builder/core.mjs validatePreset. Unknown device preset fields are
    rejected rather than silently dropping content that was not packaged.
    """
    def visit(actual, expected, path):
        message = f'{identity}: invalid {SOURCE} at {path or "root"}'
        if isinstance(expected, dict):
            require(isinstance(actual, dict) and actual.keys() == expected.keys(), message)
            for key, item in expected.items():
                visit(actual[key], item, path + '.' + key if path else key)
        elif isinstance(expected, list):
            require(isinstance(actual, list) and len(actual) == len(expected), message)
            for i, item in enumerate(expected):
                visit(actual[i], item, f'{path}[{i}]')
        elif type(expected) is int and path != 'version':
            minimum = -32768 if path in ('octave', 'engine.transpose') else 0
            require(type(actual) is int and minimum <= actual <= 32767, message)
        elif type(expected) is bool:
            require(type(actual) is bool, message)
        else:
            require(type(actual) is type(expected) and actual == expected, message)
    visit(value, initial(identity, [0] * 8), '')
    return value


def read(root, identity, kind):
    path = root / SOURCE
    if not path.exists() and not path.is_symlink():
        return None
    require(kind != 'effect', 'Send effects use definition defaults, not instrument presets')
    require(path.resolve() == path.absolute() and path.is_file() and path.stat().st_size <= 16384,
            f'{identity}: missing, redirected or oversized {SOURCE}')
    return validate(json.loads(path.read_text(encoding='utf-8')), identity)


def require_default(machine):
    require(machine.kind == 'effect' or machine.default_preset is not None,
            f'{machine.id}: submissions need {SOURCE}; create one with sdk.py preset '
            '--machine <folder> --out <folder>/presets/default.json and audition it')


def default(machine):
    if machine.kind == 'effect':
        return None
    if machine.default_preset is not None:
        return validate(machine.default_preset, machine.id)
    # Existing SDK 1.0 personal machines remain buildable; submissions require
    # an authored file through require_default, including published kit exports.
    from .adapters import catalog_defaults
    return initial(machine.id, catalog_defaults(machine.definition), machine.preset_defaults.get('amp'))


def encode(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode('utf-8')


def assets(machine):
    value = default(machine)
    return {} if value is None else {f'content/presets/{machine.id}/default.json': encode(value)}


def main(argv=None):
    parser = argparse.ArgumentParser(description='Create an editable device default from machine controls')
    parser.add_argument('--machine', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        from .machines import machine_at
        value = default(machine_at(args.machine))
        require(value is not None, 'Send effects use definition defaults, not instrument presets')
        args.out.parent.mkdir(parents=True, exist_ok=True)
        with args.out.open('xb') as stream:
            stream.write(encode(value))
        print('Created default preset: ' + str(args.out))
        return 0
    except (ValueError, OSError) as error:
        print('FAIL: ' + str(error), file=sys.stderr)
        return 1
