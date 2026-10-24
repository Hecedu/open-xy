"""Inventory compiled audio loops, without inventing trip counts or cycle costs.

One objdump instruction line is one issue packet, including its parallel ||
operations. Byte-continuation lines are not additional packets. Only straight
line hardware-loop bodies have an unambiguous packet count per iteration.
"""
import re

FUNCTION = re.compile(r'^([0-9a-f]{8}) <([^>]+)>:$')
INSTRUCTION = re.compile(r'^([0-9a-f]+):\s+(?:[0-9a-f]{2}\s+)+\t(\S.*)$')
DIRECT = re.compile(r'\b(?:CALL|JUMP)(?:\.S|\.L)?\s+0x([0-9a-f]+)')
LOOP = re.compile(r'LSETUP\(0x([0-9a-f]+)[^,]*,\s*0x([0-9a-f]+)[^)]*\)')
CONTROL = re.compile(r'\b(?:CALL|JUMP|RTS|RTI|RTX|RTN|RTE|LSETUP|EXCPT|RAISE)\b')


def inventory(disassembly, module, base, symbols, machines):
    functions, current = {}, None
    for line in disassembly.splitlines():
        if match := FUNCTION.match(line):
            current = int(match[1], 16)
            functions[current] = dict(name=match[2], body={})
        elif current is not None and (match := INSTRUCTION.match(line)):
            functions[current]['body'][int(match[1], 16)] = match[2].split('/*')[0].strip()
    owners = {address: start for start, function in functions.items() for address in function['body']}
    result = {}
    for machine in machines:
        table, slot = (f'_{machine.prefix}_fx_vtable', 16) if machine.kind == 'effect' else (f'_{machine.prefix}_vtable', 8)
        offset = symbols[table]['value'] + slot - base
        entry = int.from_bytes(module[offset:offset + 4], 'little')
        visited, pending, unknown, loops = set(), [entry], set(), []
        while pending:
            start = pending.pop()
            if start in visited:
                continue
            visited.add(start)
            function = functions.get(start)
            if function is None:
                unknown.add(f'Unresolved entry 0x{start:08x}')
                continue
            body = function['body']
            for address, text in body.items():
                if re.search(r'\b(?:CALL|JUMP)\b', text):
                    target = DIRECT.search(text)
                    owner = owners.get(int(target[1], 16)) if target else None
                    if owner is None:
                        unknown.add(f'Unresolved transfer at 0x{address:08x}')
                    elif owner != start:
                        pending.append(owner)
                if match := LOOP.search(text):
                    first, last = int(match[1], 16), int(match[2], 16)
                    packets = [instruction for at, instruction in body.items() if first <= at <= last]
                    if first not in body or last not in body or first > last or any(CONTROL.search(p) for p in packets):
                        continue
                    loops.append(dict(function=function['name'], start=f'0x{first:08x}', end=f'0x{last:08x}',
                                      packets_per_iteration=len(packets), iterations_per_block=None))
        result[machine.id] = dict(status='unestimated', unit='effect track' if machine.kind == 'effect' else 'sounding note',
                                 packets_per_block=None, cycles_per_block=None,
                                 straight_line_loops=sorted(loops, key=lambda loop: (-loop['packets_per_iteration'], loop['start'])),
                                 unresolved_transfers=sorted(unknown))
    return result


def notice(report):
    lines = ['Compiled CPU inspection (issue packets, NOT cycles or a worst-case bound):']
    for name, entry in report.items():
        loops = entry['straight_line_loops']
        detail = (f"largest straight-line hardware loop: {loops[0]['packets_per_iteration']} packets/iteration "
                  f"at {loops[0]['start']}" if loops else 'no straight-line hardware loops identified')
        lines.append(f"  {name}: {detail}; cost per {entry['unit']}/block UNESTIMATED.")
        if entry['unresolved_transfers']:
            lines.append('    Indirect/external calls or jumps prevent a complete call graph.')
    lines.append('Loop sizes do not identify the hottest path or its repetition count. See cpu_static in compile-report.json.')
    return '\n'.join(lines)
