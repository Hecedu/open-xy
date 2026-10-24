"""Compiled inspection counts packets, never guesses iteration counts or cycles."""
from types import SimpleNamespace
import unittest

from tooling.cpu_static import inventory, notice


def report(body, kind='sample'):
    module = bytearray(32)
    slot = 16 if kind == 'effect' else 8
    module[slot:slot + 4] = (0x1100).to_bytes(4, 'little')
    suffix = '_fx_vtable' if kind == 'effect' else '_vtable'
    return inventory(body, module, 0x1000, {'_m' + suffix: {'value': 0x1000}},
                     [SimpleNamespace(id='m', prefix='m', kind=kind)])


class CompiledCost(unittest.TestCase):
    def test_parallel_packet_and_continuation_count_once(self):
        text = '''00001100 <render>:
00001100:\tb2 e0 03 20 \tLSETUP(0x1104 <render+4>, 0x110c <render+12>) LC1 = P2;
00001104:\t00 00 00 00 \tR0 = R1 + R2 || R3 = [P0++] || [P1++] = R4;
00001108:\t00 00 00 00
0000110c:\t00 00 \tR0 = R0 + R1;
0000110e:\t00 00 \tRTS;'''
        for kind in ('synth', 'sample', 'effect'):
            entry = report(text, kind)['m']
            self.assertEqual(entry['straight_line_loops'][0]['packets_per_iteration'], 2)
            self.assertIsNone(entry['straight_line_loops'][0]['iterations_per_block'])
            self.assertIsNone(entry['packets_per_block'])
            self.assertIsNone(entry['cycles_per_block'])
            self.assertEqual(entry['unit'], 'effect track' if kind == 'effect' else 'sounding note')
            self.assertIn('UNESTIMATED', notice({'m': entry}))

    def test_calls_and_tail_jumps_find_loops_and_exclude_display(self):
        text = '''00001100 <render>:
00001100:\t00 00 \tCALL 0x1120 <helper>;
00001102:\t00 00 \tJUMP.L 0x1140 <tail>;
00001120 <helper>:
00001120:\t00 00 \tLSETUP(0x1124 <helper+4>, 0x1124 <helper+4>) LC1 = P2;
00001124:\t00 00 \tR0 = 0;
00001126:\t00 00 \tRTS;
00001140 <tail>:
00001140:\t00 00 \tCALL (P0);
00001142:\t00 00 \tJUMP.L 0x9900 <stock>;
00001160 <display>:
00001160:\t00 00 \tLSETUP(0x1164, 0x1164) LC1 = P2;
00001164:\t00 00 \tR0 = 0;'''
        entry = report(text)['m']
        self.assertEqual([loop['function'] for loop in entry['straight_line_loops']], ['helper'])
        self.assertEqual(len(entry['unresolved_transfers']), 2)

    def test_branch_nested_loop_and_call_are_not_constant_iteration_cost(self):
        for instruction in ('IF CC JUMP 0x1104;', 'CALL 0x1104;', 'LSETUP(0x1104, 0x1104) LC0 = P1;'):
            text = f'''00001100 <render>:
00001100:\t00 00 \tLSETUP(0x1104, 0x1106) LC1 = P2;
00001104:\t00 00 \t{instruction}
00001106:\t00 00 \tRTS;'''
            self.assertEqual(report(text)['m']['straight_line_loops'], [])


if __name__ == '__main__':
    unittest.main()
