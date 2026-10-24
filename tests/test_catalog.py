"""The catalog: unique IDs, and fetching exactly the pinned commit."""
import contextlib
import copy
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

from tooling import catalog
from tooling.machines import ROOT

PUBLISHED = dict(id='probe', kind='synth', maintainer='someone',
                 status='published', repository='https://github.com/someone/opxy-probe', tag='v1.0.0',
                 commit='0' * 40, path='.')


def document(*entries):
    return {'schema': 1, 'machines': list(entries)}


class Validation(unittest.TestCase):
    def test_the_repository_catalog_is_valid(self):
        entries = catalog.load()
        self.assertTrue(all(e['status'] in catalog.STATUSES for e in entries))

    def test_entries_by_status(self):
        catalog.validate(document(PUBLISHED))
        reserved = {k: PUBLISHED[k] for k in catalog.COMMON} | {'status': 'reserved'}
        catalog.validate(document(reserved))
        catalog.validate(document(dict(PUBLISHED, status='retired')))
        for broken in (dict(reserved, tag='v1'), dict(reserved, status='retired', repository=PUBLISHED['repository']),
                       dict(reserved, status='retired', commit='xyz'), {k: v for k, v in PUBLISHED.items() if k != 'commit'},
                       dict(PUBLISHED, status='draft'), dict(PUBLISHED, extra=1)):
            with self.subTest(entry=broken), self.assertRaises(ValueError):
                catalog.validate(document(broken))

    def test_fields_are_checked(self):
        for change in (dict(id='Bad'), dict(id='sdk_probe'), dict(kind='player'), dict(identity=dict(engine=36, page=85)),
                       dict(maintainer='not a user'), dict(repository='https://example.com/a/b'),
                       dict(repository='https://github.com/someone/..'),
                       dict(repository='git@github.com:a/b'), dict(commit='abc'), dict(tag='v 1'),
                       dict(path='../x'), dict(path='/x')):
            with self.subTest(change=change), self.assertRaises(ValueError):
                catalog.validate(document(dict(PUBLISHED, **change)))

    def test_ids_are_held_once(self):
        other = dict(PUBLISHED, id='other')
        catalog.validate(document(PUBLISHED, other))
        for clash in (dict(other, id='probe'), dict(other, status='retired', id='probe'), dict(PUBLISHED, id='fm2op')):
            with self.subTest(clash=clash), self.assertRaisesRegex(ValueError, 'already'):
                catalog.validate(document(PUBLISHED, clash) if clash['id'] == 'probe' else document(clash))


class BuilderPatterns(unittest.TestCase):
    def test_the_builder_checks_kits_with_the_catalogs_patterns(self):
        source = (ROOT / 'builder/core.mjs').read_text(encoding='utf-8')
        for key, pattern in (('repository', catalog.REPOSITORY), ('tag', catalog.TAG), ('commit', catalog.COMMIT),
                             ('maintainer', catalog.MAINTAINER)):
            found = re.search(key + r": /\^(.*?)\$/[,}]", source)
            self.assertIsNotNone(found, key)
            self.assertEqual(found.group(1).replace('\\/', '/'), pattern, key)


class Changes(unittest.TestCase):
    def test_entries_keep_their_kind_and_only_move_forward(self):
        reserved = {k: PUBLISHED[k] for k in catalog.COMMON} | {'status': 'reserved'}
        catalog.changes([reserved], [PUBLISHED])
        catalog.changes([PUBLISHED], [dict(PUBLISHED, tag='v1.1.0', commit='1' * 40)])
        catalog.changes([PUBLISHED], [dict(PUBLISHED, status='retired')])
        catalog.changes([], [PUBLISHED])
        for after in ([], [dict(PUBLISHED, kind='effect')],
                      [dict(reserved)], [dict(PUBLISHED, id='other')],
                      [dict(PUBLISHED, repository='https://github.com/other/opxy-probe')],
                      [dict(PUBLISHED, maintainer='other')]):
            with self.subTest(after=after), self.assertRaises(ValueError):
                catalog.changes([PUBLISHED], after)
        with self.assertRaises(ValueError):
            catalog.changes([dict(PUBLISHED, status='retired')], [PUBLISHED])


class Fetching(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name).resolve()
        # A machine repository: fm2op renamed to probe, committed and tagged.
        self.repository = root / 'opxy-probe'
        shutil.copytree(ROOT / 'machines/fm2op', self.repository)
        definition = json.loads((self.repository / 'definition.json').read_text(encoding='utf-8'))
        definition['id'] = 'probe'
        (self.repository / 'definition.json').write_text(json.dumps(definition), encoding='utf-8')
        preset_path = self.repository / 'presets/default.json'
        preset = json.loads(preset_path.read_text(encoding='utf-8'))
        preset['type'] = 'probe'
        preset['engine']['params'][0] = 7312
        preset_path.write_text(json.dumps(preset), encoding='utf-8')
        record = json.loads((self.repository / 'machine.json').read_text(encoding='utf-8'))
        record['identity'] = dict(engine=5, page=85)
        (self.repository / 'machine.json').write_text(json.dumps(record), encoding='utf-8')
        for command in (['init', '-q', '-b', 'main'], ['add', '-A'],
                        ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'probe'],
                        ['tag', 'v1.0.0']):
            subprocess.run(['git', *command], cwd=self.repository, check=True, capture_output=True,
                           creationflags=catalog.NO_WINDOW)
        commit = catalog.git('rev-parse', 'HEAD', cwd=self.repository).strip()
        self.entry = dict(PUBLISHED, repository=self.repository.as_uri(), commit=commit)
        self.cache = root / 'cache'

    def test_fetch_takes_exactly_the_pinned_commit(self):
        self.assertEqual(catalog.tag_commit(self.entry['repository'], 'v1.0.0'), self.entry['commit'])
        m = catalog.fetch(self.entry, self.cache)
        self.assertEqual((m.id, m.identity), ('probe', dict(engine=5, page=85)))
        self.assertEqual(m.default_preset['engine']['params'][0], 7312)
        self.assertEqual(catalog.fetch(self.entry, self.cache).root, m.root)  # reused when unchanged
        (m.root / 'engine.cpp').write_text('// changed\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'changed'):
            catalog.fetch(self.entry, self.cache)
        # An edit git status cannot see is still a change.
        catalog.git('checkout', '--', 'engine.cpp', cwd=m.root)
        catalog.git('update-index', '--assume-unchanged', 'engine.cpp', cwd=m.root)
        (m.root / 'engine.cpp').write_text('// hidden\n', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'changed'):
            catalog.fetch(self.entry, self.cache)

    def test_an_interrupted_fetch_is_started_again(self):
        broken = self.cache / f"probe-{self.entry['commit'][:12]}"
        broken.mkdir(parents=True)
        catalog.git('init', '--quiet', cwd=broken)
        self.assertEqual(catalog.fetch(self.entry, self.cache).root, broken)

    def test_submission_without_default_is_rejected_but_old_controls_can_be_compared(self):
        catalog.git('rm', 'presets/default.json', cwd=self.repository)
        catalog.git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'missing preset', cwd=self.repository)
        entry = dict(self.entry, commit=catalog.head(self.repository))
        with self.assertRaisesRegex(ValueError, 'submissions need presets/default.json'):
            catalog.fetch(entry, self.cache)
        self.assertIsNone(catalog.fetch(entry, self.cache, submission=False).default_preset)

    def test_fetch_refuses_a_machine_that_differs_from_its_entry(self):
        for change in (dict(kind='effect'), dict(kind='sample')):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'differs'):
                catalog.fetch(dict(self.entry, **change), self.cache / str(len(change)))

    def test_pinned_means_fetched_and_unchanged(self):
        m = catalog.fetch(self.entry, self.cache)
        listing = Path(self.temporary.name) / 'machines.json'
        listed = dict(self.entry, repository=PUBLISHED['repository'])  # pinned() never contacts it
        listing.write_text(json.dumps(document(listed)), encoding='utf-8')
        self.assertTrue(catalog.pinned(m, catalog.load(listing)))
        listing.write_text(json.dumps(document(dict(listed, commit='1' * 40))), encoding='utf-8')
        self.assertFalse(catalog.pinned(m, catalog.load(listing)))


class Controls(unittest.TestCase):
    """A moved release keeps what each saved parameter value means."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name).resolve()
        self.repository = root / 'opxy-probe'
        shutil.copytree(ROOT / 'machines/fm2op', self.repository)
        record = json.loads((self.repository / 'machine.json').read_text(encoding='utf-8'))
        record['identity'] = dict(engine=5, page=85)
        (self.repository / 'machine.json').write_text(json.dumps(record), encoding='utf-8')
        self.definition = json.loads((self.repository / 'definition.json').read_text(encoding='utf-8'))
        self.definition['id'] = 'probe'
        preset_path = self.repository / 'presets/default.json'
        preset = json.loads(preset_path.read_text(encoding='utf-8'))
        preset['type'] = 'probe'
        preset_path.write_text(json.dumps(preset), encoding='utf-8')
        # Four positions and one alternate, so a release can remove a parameter.
        self.parameters = self.definition['parameters'] + [self.alternate('spread')]
        subprocess.run(['git', 'init', '-q', '-b', 'main'], cwd=self.repository, check=True, capture_output=True,
                       creationflags=catalog.NO_WINDOW)
        self.before = dict(PUBLISHED, repository=self.repository.as_uri(), commit=self.release(self.parameters))
        self.cache = root / 'cache'

    @staticmethod
    def alternate(name):
        return dict(id=name, label=name.title(), default=0.5, mapping=dict(kind='linear', minimum=0, maximum=1),
                    display='percent', control=0)

    def release(self, parameters):
        definition = dict(self.definition, parameters=parameters,
                          presets={'Init': {p['id']: p['default'] for p in parameters}})
        (self.repository / 'definition.json').write_text(json.dumps(definition), encoding='utf-8')
        for command in (['add', '-A'], ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q',
                                        '--allow-empty', '-m', 'release']):
            subprocess.run(['git', *command], cwd=self.repository, check=True, capture_output=True,
                           creationflags=catalog.NO_WINDOW)
        return catalog.git('rev-parse', 'HEAD', cwd=self.repository).strip()

    def update(self, parameters, allow=False):
        after = dict(self.before, tag='v1.1.0', commit=self.release(parameters))
        return catalog.release_controls([self.before], [after], self.cache, allow)

    def test_unchanged_controls_pass_and_new_text_is_reported(self):
        self.assertEqual(self.update(copy.deepcopy(self.parameters)), [])
        relabelled = copy.deepcopy(self.parameters)
        relabelled[0].update(label='Harmonic', default=0.5)
        self.assertEqual(self.update(relabelled), ['probe v1.0.0 -> v1.1.0: parameter 0 (ratio): label Ratio -> Harmonic',
                                                   'probe v1.0.0 -> v1.1.0: parameter 0 (ratio): default 0.3333333333333333 -> 0.5'])
        # A release that keeps its commit is not fetched.
        self.assertEqual(catalog.release_controls([self.before], [dict(self.before, repository='file:///missing')]), [])

    def test_an_appended_parameter_passes(self):
        report = self.update(self.parameters + [self.alternate('width')])
        self.assertEqual(report, ['probe v1.0.0 -> v1.1.0: parameter 5 (width): added'])

    def test_control_changes_fail_naming_the_parameter(self):
        reordered = copy.deepcopy(self.parameters)
        reordered[1], reordered[2] = reordered[2], reordered[1]
        remapped = copy.deepcopy(self.parameters)
        remapped[3]['mapping']['maximum'] = 8000
        renamed = copy.deepcopy(self.parameters)
        renamed[3]['id'] = 'release'
        moved = copy.deepcopy(self.parameters)
        moved[4]['control'] = 2
        for parameters, message in ((self.parameters[:4], r'parameter 4 \(spread\): removed'),
                                    (reordered, r'parameter 1 \(amount\): moved to parameter 2'),
                                    (remapped, r'parameter 3 \(decay\): mapping changed'),
                                    (renamed, r'parameter 3 \(decay\): id changed to release'),
                                    (moved, r'parameter 4 \(spread\): control position changed from 0 to 2')):
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, '(?s)' + message + '.*controls-changed'):
                    self.update(parameters)
                # A catalog maintainer's approval lets it through, still reported.
                self.assertTrue(any(re.search(message, line) for line in self.update(parameters, allow=True)))

    def test_the_check_command_compares_with_the_base_catalog(self):
        # Without a moved release, check --base needs no network or flag.
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(catalog.main(['check', '--base', 'HEAD', '--cache', str(self.cache)]), 0)


if __name__ == '__main__':
    unittest.main()
