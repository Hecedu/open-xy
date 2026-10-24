"""The CPU estimate sdk.py test prints: its control sweep, its benchmarks and its advice."""
import re
import tempfile
import unittest
from unittest import mock

from tooling import cpu
from tooling.machines import machine
from test_sample_services import HOST_CXX


class Sweep(unittest.TestCase):
    def test_lists_take_each_option_and_ranges_nine_positions(self):
        options = cpu.sweep({'mapping': {'kind': 'enum', 'labels': ['a', 'b', 'c', 'd']}})
        self.assertEqual(len(options), 4)
        self.assertTrue(all(0 < v < 0x7fffffff for v in options) and options == sorted(options))
        positions = cpu.sweep({'mapping': {'kind': 'linear', 'minimum': 0, 'maximum': 1}})
        self.assertEqual((len(positions), positions[0], positions[-1]), (9, 0, 0x7fffffff))


class Advice(unittest.TestCase):
    def test_an_estimate_that_cannot_run_is_reported_not_failed(self):
        with mock.patch.object(cpu, 'block_cost', side_effect=ValueError('fm2op: the CPU estimate does not compile:\nerror')):
            line = cpu.summary(machine('fm2op'), 'c++', '.')
        self.assertTrue(line.startswith('CPU: not estimated (fm2op: the CPU estimate does not compile:)'), line)

    def test_limits_frame_the_estimate(self):
        m = machine('fm2op')
        for cost, ending in ((5000, '(docs/api.md#cpu)'), (20000, 'make it lighter where you can'),
                             (30000, 'may drop audio')):
            with self.subTest(cost=cost), \
                 mock.patch.object(cpu, 'block_cost', return_value=cost * 10.0), \
                 mock.patch.object(cpu, 'reference_cost', return_value=cpu.REFERENCE_INSTRUCTIONS * 10.0):
                line = cpu.summary(m, 'c++', '.')
            self.assertIn(f'about {cost:,} instruction-equivalents per voice block', line)
            self.assertIn(ending, line)


@unittest.skipUnless(HOST_CXX, 'No working host C++ compiler (set OPXY_TEST_HOST_CXX)')
class Benchmarks(unittest.TestCase):
    def test_the_bundled_synth_and_effect_benchmarks_build_and_run(self):
        with tempfile.TemporaryDirectory() as scratch:
            cpu._reference.clear()
            self.assertGreater(cpu.reference_cost(HOST_CXX, scratch), 0)
            for name in ('fm2op', 'ringmod'):
                with self.subTest(machine=name):
                    line = cpu.summary(machine(name), HOST_CXX, scratch)
                    self.assertRegex(line, r'about [\d,]+ instruction-equivalents per (voice|effect) block')
            self.assertIsNone(cpu.block_cost(machine('timestretch'), HOST_CXX, scratch))


if __name__ == '__main__':
    unittest.main()
