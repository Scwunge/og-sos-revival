"""Dump or diff the string literals of two exes (UTF-16LE and ASCII). stdlib only. Read-only.
Usage:
  python -I exe_strings.py dump <exe> <out.txt> [minlen]
  python -I exe_strings.py diff <exeA> <exeB> <outdir> [minlen]
     writes only_a.txt, only_b.txt, common.txt (each line: "u|<str>" for UTF-16, "a|<str>" for ASCII)
  python -I exe_strings.py grep <exe> <regex> [minlen]
"""
import re, sys, os

def strings(path, minlen=5):
    data = open(path, 'rb').read()
    out = set()
    for m in re.finditer(rb'(?:[\x20-\x7e]\x00){%d,}' % minlen, data):
        out.add('u|' + m.group().decode('utf-16le'))
    for m in re.finditer(rb'[\x20-\x7e]{%d,}' % minlen, data):
        out.add('a|' + m.group().decode('ascii'))
    return out

def write(p, s):
    with open(p, 'w', encoding='utf-8') as f:
        for x in sorted(s): f.write(x + '\n')

def main():
    cmd = sys.argv[1]
    if cmd == 'dump':
        mn = int(sys.argv[4]) if len(sys.argv) > 4 else 5
        write(sys.argv[3], strings(sys.argv[2], mn))
    elif cmd == 'diff':
        mn = int(sys.argv[5]) if len(sys.argv) > 5 else 5
        a, b = strings(sys.argv[2], mn), strings(sys.argv[3], mn)
        d = sys.argv[4]; os.makedirs(d, exist_ok=True)
        write(os.path.join(d, 'only_a.txt'), a - b)
        write(os.path.join(d, 'only_b.txt'), b - a)
        write(os.path.join(d, 'common.txt'), a & b)
        print(f'only_a {len(a-b)}  only_b {len(b-a)}  common {len(a&b)}')
    elif cmd == 'grep':
        mn = int(sys.argv[4]) if len(sys.argv) > 4 else 4
        rx = re.compile(sys.argv[3])
        for x in sorted(strings(sys.argv[2], mn)):
            if rx.search(x): print(x)

if __name__ == '__main__':
    main()
