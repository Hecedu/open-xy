"""Exercise the actual bounded recording history without firmware or a device."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from test_sample_services import HOST_CXX

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(HOST_CXX, 'No working host C++ compiler (set OPXY_TEST_HOST_CXX)')
class RecordingHistory(unittest.TestCase):
    def run_fixture(self, name):
        hidden = dict(creationflags=subprocess.CREATE_NO_WINDOW) if os.name == 'nt' else {}
        with tempfile.TemporaryDirectory(prefix='recording-history-') as folder:
            binary = Path(folder) / ('history.exe' if os.name == 'nt' else 'history')
            command = [HOST_CXX, '-std=c++11', '-O2', '-Wall', '-Wextra', '-Werror',
                       '-I' + str(ROOT / 'sdk/include'), '-I' + str(ROOT / 'sdk/platform'),
                       str(ROOT / 'tests/fixtures' / (name + '.cpp')), '-o', str(binary)]
            built = subprocess.run(command, capture_output=True, text=True, timeout=120, **hidden)
            self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
            ran = subprocess.run([str(binary)], capture_output=True, text=True, timeout=30, **hidden)
            self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)

    def test_rolling_time_context_and_note_lifetimes(self):
        self.run_fixture('recording_history')

    def test_double_tap_without_holds_chords_or_repeats(self):
        self.run_fixture('record_tap')
