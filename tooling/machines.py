"""Machine discovery: each machine folder's machine.json declares what the SDK builds.

A machine lives in machines/<id>/ or in a folder of its own anywhere, such as
its own repository. Its definition's id is its stock name: the engine type the
device lists, its catalog and preset entries, its screen file and its symbol
prefix. machine.json declares the kind, the SDK version it targets, stock IDs
and build inputs. Saved presets and Open-XY layouts refer to the name and IDs,
so they never change once published; the SDK checks them against the stock
tables and the collection.
"""
from dataclasses import dataclass, replace
import json
import os
from pathlib import Path
import re

from .definitions import ANALYSIS_HEAP_LIMIT, ROOT, stock_name, own_screen, validate_definition
from .formats import require
from .pipeline import config

KINDS = ('synth', 'sample', 'effect')
FIELDS = {'schema', 'sdk', 'kind', 'description', 'identity', 'sources', 'includes', 'icon', 'presetDefaults',
          'dryParameter'}
# The public machine contract: headers, definition schema, artwork rules and
# callbacks. A machine names the version it was written for; the SDK builds a
# machine of the same major version and an equal or older minor version.
SDK_VERSION = (1, 1)
# Builder card glyph: SVG path data in a 46 x 48 box, drawn as a stroke.
ICON = re.compile(r'[MLHVCSQTAZmlhvcsqtaz][MLHVCSQTAZmlhvcsqtaz0-9 .,-]{0,511}')
COLLECTION = ROOT / 'profiles/collection.json'
# Folders inside a machine that are never its source: version control, caches, tools.
IGNORED = {'.git', '__pycache__', 'node_modules', '.venv'}


def tree(root):
    """Every file under a machine folder, in name order, without walking ignored folders."""
    found = []
    for folder, folders, files in os.walk(root):
        folders[:] = sorted(f for f in folders if f not in IGNORED)
        found += [Path(folder) / name for name in files]
    return sorted(found)


@dataclass(frozen=True)
class Machine:
    id: str
    kind: str
    name: str
    description: str
    display: str
    sources: tuple
    includes: tuple
    definition: dict
    identity: dict
    preset_defaults: dict
    root: Path = None
    icon: str = ''
    dry_parameter: int | None = None
    requested: dict = None  # the numbers machine.json asks for, when a layout gave others

    # The stock name and the symbol prefix are the machine's name.
    @property
    def native_name(self):
        return self.id

    @property
    def prefix(self):
        return self.id

    @property
    def bundled(self):
        """A machine of this repository's machines/ folder, rather than a folder elsewhere."""
        return self.root == ROOT / 'machines' / self.id

    def source(self, relative=''):
        """A machine file as the build names it: machines/<id>/... for a bundled machine, so
        rebuilds stay byte-identical, and an absolute path for a machine elsewhere."""
        base = 'machines/' + self.id if self.bundled else self.root.as_posix()
        return base + ('/' + relative if relative else '')

    def files(self):
        """Every authored file, keyed as the build's provenance names it."""
        key = 'machines/' + self.id if self.bundled else 'external/' + self.id
        return {key + '/' + p.relative_to(self.root).as_posix(): p for p in tree(self.root) if p.suffix != '.md'}

    def contains(self, path):
        """Whether a path lies inside this machine's folder, where build output must never go."""
        return Path(os.path.abspath(path)).is_relative_to(self.root)


def relative_path(value):
    """A path inside a folder, written with forward slashes: no '..' and no root."""
    return (isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_./-]+', value) is not None and
            '..' not in value.split('/') and not value.startswith('/'))


def _relative(machine_root, value):
    require(relative_path(value), 'Invalid machine path: ' + str(value))
    path = (machine_root / value).resolve()
    require(path.is_relative_to(machine_root.resolve()) and path.exists(), 'Missing machine path: ' + value)
    return value


def check_identity(rules, kind, value, screen=False):
    """IDs a machine may claim under the profile's identity rules (the browser builder applies the same rules).

    Engines take a free entry of the relocated table, never the stock "none" value; a
    synth draws its own page above the stock "none" page, a sample engine an ID only
    the relocated table holds and a stock sample page (or a relocated page with screen=True),
    an effect a free FX ID on the FX page.
    """
    require(isinstance(value, dict), 'machine.json needs an identity')
    slot = 'effect' if kind == 'effect' else 'engine'
    require(set(value) == {slot, 'page'}, 'Unexpected identity fields')
    number, page = value[slot], value['page']
    require(type(number) is int and type(page) is int, 'IDs must be integers')
    if kind == 'effect':
        require(number in rules['effects'] and page == rules['effect_page'],
                'Effects use an FX ID stock leaves unregistered, on the stock FX page')
        return {slot: number, 'page': page}
    require(0 < number < rules['engines'] and number != rules['engine_none'] and number not in rules['stock_engines'],
            'Engine ID outside the relocated table, the stock "none" value or registered by stock')
    if kind == 'sample':
        require(rules['engine_none'] < number, 'Sample engines need a relocated-table engine ID')
        require(rules['page_none'] < page < rules['pages'] if screen else page in rules['sample_pages'],
                'Sample engines need a relocated page with a display, otherwise a stock sample page')
    else:
        require(rules['page_none'] < page < rules['pages'], 'A machine with its own screen needs a relocated page')
    return {slot: number, 'page': page}


def sdk_version(text):
    """A machine's declared SDK version, checked against this SDK."""
    require(text is not None, 'machine.json needs "sdk": "%d.%d". A machine from before SDK 1.0: '
            'see docs/display.md#migrating-from-before-sdk-10' % SDK_VERSION)
    require(isinstance(text, str) and re.fullmatch(r'\d+\.\d+', text), 'machine.json needs "sdk": "<major>.<minor>"')
    major, minor = map(int, text.split('.'))
    current = '%d.%d' % SDK_VERSION
    require(major == SDK_VERSION[0] and minor <= SDK_VERSION[1],
            f'The machine targets SDK {text}; this SDK is {current} and builds {SDK_VERSION[0]}.0 to {current}')
    return text


def machine(identity):
    """A bundled machine, machines/<identity>/."""
    stock_name(identity)
    return machine_at(ROOT / 'machines' / identity, identity)


def machine_at(root, identity=None):
    """The machine in a folder; its definition names it."""
    root = Path(os.path.abspath(root))
    path = root / 'machine.json'
    require(path.is_file() and path.resolve() == path.absolute() and root.resolve() == root,
            'Unknown or redirected machine: ' + str(identity or root))
    value = json.loads(path.read_text(encoding='utf-8'))
    if identity is None:
        named = json.loads((root / 'definition.json').read_text(encoding='utf-8'))
        identity = named.get('id') if isinstance(named, dict) else None
        stock_name(identity)
    require(isinstance(value, dict) and value.get('schema') == 1 and
            set(value) <= FIELDS,
            'Unexpected machine.json fields: ' + identity)
    sdk_version(value.get('sdk'))
    kind = value.get('kind')
    require(kind in KINDS, 'Unknown machine kind: ' + str(kind))
    require(isinstance(value.get('description'), str) and 0 < len(value['description']) <= 160,
            'Machine needs a short description')
    sources = tuple(_relative(root, s) for s in value.get('sources', ()))
    includes = tuple(_relative(root, s) for s in value.get('includes', ()))
    require(all(s.endswith(('.cc', '.cpp')) for s in sources), 'Extra sources must be C++ translation units')
    icon = value.get('icon', '')
    require(icon == '' or isinstance(icon, str) and ICON.fullmatch(icon), 'icon is SVG path data')
    definition = validate_definition(json.loads((root / 'definition.json').read_text(encoding='utf-8')), kind)
    require(definition['id'] == identity, 'Machine directory and definition identity disagree')
    require(root == ROOT / 'machines' / identity or not (ROOT / 'machines' / identity).exists(),
            f'A machine named {identity} is bundled with the SDK; choose another ID')
    dry_parameter = None
    if 'dryParameter' in value:
        require(kind == 'effect' and isinstance(value['dryParameter'], str),
                'dryParameter names a normalized control on an effect')
        matches = [i for i, p in enumerate(definition['parameters']) if p['id'] == value['dryParameter']]
        require(len(matches) == 1, 'dryParameter must name a declared control')
        dry_parameter = matches[0]
        require(definition['parameters'][dry_parameter]['mapping'] ==
                dict(kind='linear', minimum=0, maximum=1), 'dryParameter must map linearly from 0 to 1')
    # Drawing is independent of the machine's audio kind.
    screen = own_screen(definition, kind)
    display = 'drawing' if screen else 'stock'
    numbers = check_identity(config()['identities'], kind, value.get('identity'), screen)
    if kind == 'sample' and (screen or 'singleSample' in definition['resources']):
        require(tuple(map(int, value['sdk'].split('.'))) >= (1, 1),
                'Sample displays and singleSample require sdk 1.1 or newer')
        require(not definition['resources'].get('singleSample', 0) or numbers['page'] != 7,
                'singleSample uses stock page 2 or a drawing display, not drum page 7')
    # The native plan compiles extra translation units only into synths.
    if kind != 'synth':
        require(not sources and not includes, 'Sample engines and effects compile one fx.cpp or sample.cpp')
    # Pad settings live in the stock drum page's pad records, whose fade the SDK then owns.
    if kind == 'sample' and definition['resources'].get('padSettings', 0):
        require(numbers['page'] == 7, 'Pad settings and drum controls need stock page 7')
    defaults = value.get('presetDefaults', {})
    require(isinstance(defaults, dict) and set(defaults) <= {'amp'}, 'Invalid preset defaults')
    amp = defaults.get('amp', {})
    require(isinstance(amp, dict) and set(amp) <= {'attack', 'decay', 'release', 'sustain'} and
            all(type(v) is int and 0 <= v <= 32767 for v in amp.values()), 'Invalid preset amp defaults')
    return Machine(id=identity, kind=kind, name=definition['name'], description=value['description'],
                   display=display, sources=sources, includes=includes,
                   definition=definition,
                   identity=numbers, preset_defaults=defaults,
                   root=root, icon=icon, dry_parameter=dry_parameter)


def discovered():
    """Every machine folder in the repository, in name order."""
    return [machine(path.parent.name) for path in sorted((ROOT / 'machines').glob('*/machine.json'))]


# Machine numbers. Projects store a track's engine, effect and page numbers, so a
# machine keeps its numbers in a firmware for good. Bundled machines' numbers are
# fixed. Every other machine is given numbers by a layout: the firmware's record of
# every number it has given out, including to machines since dropped, which stay
# held so an old project never opens another machine. A machine new to a layout
# gets the numbers it asks for when they are free, else the lowest free ones.
# builder/core.mjs assignNumbers applies the same rules (tests/fixtures/numbers.json).
LAYOUT_FORMAT = 'opxy-layout/1'


def number_pools(rules):
    """The numbers a machine new to a layout may be given, lowest first. Engines come only
    from the relocated table above stock's "none" value: the gaps in stock's own table
    below it are left for stock."""
    engines = [n for n in range(rules['engine_none'] + 1, rules['engines']) if n not in rules['stock_engines']]
    return dict(engine=engines, page=list(range(rules['page_none'] + 1, rules['pages'])), effect=list(rules['effects']))


def occupied(rules, identity):
    """What an identity holds: its engine or effect number, and its own page. Effects share
    the FX page and sample engines a stock sample page."""
    keys = [(slot, identity[slot]) for slot in ('engine', 'effect') if slot in identity]
    if 'effect' not in identity and identity['page'] not in rules['sample_pages']:
        keys.append(('page', identity['page']))
    return keys


def read_layout(path):
    """A layout file's numbers by machine ID. The builder's saved selection is a layout too."""
    value = json.loads(Path(path).read_text(encoding='utf-8'))
    profile = config()
    require(isinstance(value, dict) and value.get('format') == LAYOUT_FORMAT and isinstance(value.get('machines'), dict),
            f'{path} is not a machine layout ({LAYOUT_FORMAT})')
    require(value.get('profile') == profile['id'], f"{path} is a layout for {value.get('profile')}, not {profile['id']}")
    for name, identity in value['machines'].items():
        stock_name(name)
        require(isinstance(identity, dict) and set(identity) in ({'engine', 'page'}, {'effect', 'page'}) and
                all(type(n) is int for n in identity.values()), f'{name}: invalid numbers in the layout')
    return value['machines']


def layout_document(numbers):
    return {'format': LAYOUT_FORMAT, 'profile': config()['id'], 'machines': dict(sorted(numbers.items()))}


def number_layout(rules, fixed, layout, machines):
    """The layout after numbering `machines`: every number `layout` held, the fixed
    machines' and any given out now. Machines are (id, kind, requested identity[, drawing]), fixed
    ones (id, kind, identity); a stock-page sample engine keeps that page."""
    pools = number_pools(rules)
    numbers, holders = {}, {}

    def hold(name, identity):
        for key in occupied(rules, identity):
            require(holders.setdefault(key, name) == name,
                    f'{name} and {holders[key]} both hold {key[0]} {key[1]} in this layout')
        numbers[name] = dict(identity)

    for name, _kind, identity in fixed:
        hold(name, identity)
    for name, identity in (layout or {}).items():
        if name in numbers:
            require(numbers[name] == identity, f'{name} is bundled with fixed numbers; the layout gives it others')
        else:
            hold(name, identity)
    for entry in machines:
        name, kind, requested = entry[:3]
        screen = entry[3] if len(entry) == 4 else False
        if name in numbers:
            check_identity(rules, kind, numbers[name], screen)
            require(kind != 'sample' or screen or numbers[name]['page'] == requested['page'],
                    f'{name} now asks for stock page {requested["page"]}; the layout holds another')
            continue
        identity = dict(requested)
        for slot in ('effect',) if kind == 'effect' else ('engine', 'page') if kind == 'synth' or screen else ('engine',):
            choices = ([requested[slot]] if requested[slot] in pools[slot] else []) + pools[slot]
            identity[slot] = next((n for n in choices if (slot, n) not in holders), None)
            require(identity[slot] is not None, f'No free {slot} number for {name}: every one is held in this layout')
        hold(name, check_identity(rules, kind, identity, screen))
    return numbers


def assign_numbers(machines, layout=None, fixed=None):
    """The machines with their numbers in this layout, and the layout after. `fixed` are
    the bundled machines, by default this repository's."""
    numbers = number_layout(config()['identities'],
                            [(m.id, m.kind, m.identity) for m in (discovered() if fixed is None else fixed)],
                            layout, [(m.id, m.kind, m.identity, m.display != 'stock') for m in machines])
    assigned = [m if numbers[m.id] == m.identity else replace(m, identity=numbers[m.id], requested=m.identity)
                for m in machines]
    return assigned, numbers


def free_synth_identity():
    """Numbers to ask for in a new synth's machine.json: the lowest that no bundled machine holds."""
    rules = config()['identities']
    held = {key for m in discovered() for key in occupied(rules, m.identity)}
    pools = number_pools(rules)
    return {slot: next(n for n in pools[slot] if (slot, n) not in held) for slot in ('engine', 'page')}


def read_collection(path=COLLECTION, extra=()):
    """A collection file's entries, resolved: a bundled machine's ID, or the absolute
    folder of a machine elsewhere ({"path": ...}, relative to the file). Folders
    in `extra` follow them."""
    path = Path(path)
    value = json.loads(path.read_text(encoding='utf-8'))
    require(isinstance(value, dict) and set(value) == {'schema', 'machines'} and value['schema'] == 1 and
            isinstance(value['machines'], list), 'Unsupported collection file: ' + str(path))
    entries = []
    for entry in value['machines']:
        if isinstance(entry, dict):
            require(set(entry) == {'path'} and isinstance(entry['path'], str),
                    'Collection entries are IDs or {"path": ...}')
            entries.append({'path': str((path.parent / entry['path']).resolve())})
        else:
            entries.append(entry)
    return entries + [{'path': str(Path(folder).resolve())} for folder in extra]


def free_effect_identity():
    """Numbers to ask for in a new effect's machine.json: the lowest effect number no bundled machine holds."""
    rules = config()['identities']
    used = {m.identity.get('effect') for m in discovered()}
    free = [n for n in rules['effects'] if n not in used]
    require(free, 'Every effect number is held by a bundled machine')
    return {'effect': free[0], 'page': rules['effect_page']}


def collection(entries=None, layout=None):
    """Machines in firmware order, with their numbers in the layout: the order sets
    startup, catalog and link layout, and which machine new to the layout is numbered first.
    Entries come from read_collection; the default is profiles/collection.json."""
    entries = read_collection() if entries is None else entries
    require(isinstance(entries, list) and entries, 'Collection needs machines')
    machines = [machine_at(e['path']) if isinstance(e, dict) else machine(e) for e in entries]
    identities = [m.id for m in machines]
    require(len(set(identities)) == len(identities), 'Collection needs distinct machines')
    machines, _numbers = assign_numbers(machines, layout)
    engines = [m.identity['engine'] for m in machines if 'engine' in m.identity]
    effects = [m.identity['effect'] for m in machines if 'effect' in m.identity]
    pages = [m.identity['page'] for m in machines if m.display != 'stock']
    require(len(set(engines)) == len(engines) and len(set(effects)) == len(effects) and len(set(pages)) == len(pages),
            'Conflicting engine, effect or page ID')
    check_analysis_budgets(machines)
    return machines


def check_analysis_budgets(machines):
    """Every machine's analysis budget comes from one stock-heap allowance."""
    total = sum(m.definition['resources'].get('sampleAnalysis', 0) for m in machines if m.kind == 'sample')
    require(total <= ANALYSIS_HEAP_LIMIT,
            'Sample analysis budgets exceed the collection limit of %d bytes' % ANALYSIS_HEAP_LIMIT)


def by_kind(machines, *kinds):
    return [m for m in machines if m.kind in kinds]
