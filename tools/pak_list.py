"""Minimal UE4 .pak (v3, unencrypted) reader. stdlib only. Read-only.
Usage:
  python -I pak_list.py list  <pak> <out_listing.txt>
  python -I pak_list.py extract <pak> <regex> <outdir> [--max-size N]
"""
import struct, sys, re, zlib, os

def read_fstring(b, o):
    n, = struct.unpack_from('<i', b, o); o += 4
    if n == 0: return '', o
    if n < 0:
        n = -n
        s = b[o:o+n*2-2].decode('utf-16le'); o += n*2
    else:
        s = b[o:o+n-1].decode('utf-8', 'replace'); o += n
    return s, o

def read_index(f):
    f.seek(0, 2); size = f.tell()
    f.seek(size-44); foot = f.read(44)
    magic, ver, ioff, isz = struct.unpack_from('<IIqq', foot, 0)
    assert magic == 0x5A6F12E1 and ver == 3, (hex(magic), ver)
    f.seek(ioff); idx = f.read(isz)
    mount, o = read_fstring(idx, 0)
    cnt, = struct.unpack_from('<i', idx, o); o += 4
    ents = []
    for _ in range(cnt):
        name, o = read_fstring(idx, o)
        off, sz, usz, comp = struct.unpack_from('<qqqi', idx, o); o += 28
        o += 20
        blocks = []
        if comp:
            nb, = struct.unpack_from('<i', idx, o); o += 4
            for _ in range(nb):
                blocks.append(struct.unpack_from('<qq', idx, o)); o += 16
        enc, bs = struct.unpack_from('<BI', idx, o); o += 5
        ents.append(dict(name=name, off=off, size=sz, usize=usz, comp=comp, blocks=blocks, enc=enc, bs=bs))
    return mount, ents

def header_len(e):
    # in-data FPakEntry copy: 8+8+8+4+20 (+4+16*nb if compressed) +1 +4
    n = 53 + (4 + 16*len(e['blocks']) if e['comp'] else 0) + 0
    return n - 0 if False else 48 + 20 - 20 + (4 + 16*len(e['blocks']) if e['comp'] else 0) + 5 + 0

def read_entry(f, e):
    hl = 28 + 20 + (4 + 16*len(e['blocks']) if e['comp'] else 0) + 5
    if e['comp'] == 0:
        f.seek(e['off'] + hl); return f.read(e['usize'])
    out = bytearray()
    for s, en in e['blocks']:
        f.seek(s); out += zlib.decompress(f.read(en - s))
    return bytes(out[:e['usize']])

def main():
    cmd, pak = sys.argv[1], sys.argv[2]
    with open(pak, 'rb') as f:
        mount, ents = read_index(f)
        if cmd == 'list':
            with open(sys.argv[3], 'w', encoding='utf-8') as o:
                for e in ents:
                    o.write(f"{e['size']}\t{e['usize']}\t{e['comp']}\t{mount}{e['name']}\n")
            print(len(ents), 'entries; mount', mount)
        elif cmd == 'extract':
            rx = re.compile(sys.argv[3], re.I); outdir = sys.argv[4]
            mx = int(sys.argv[6]) if len(sys.argv) > 6 and sys.argv[5] == '--max-size' else 1 << 26
            n = 0
            for e in ents:
                if rx.search(e['name']) and e['usize'] <= mx and not e['enc']:
                    data = read_entry(f, e)
                    p = os.path.join(outdir, *[x for x in e['name'].split('/') if x not in ('', '..')])
                    os.makedirs(os.path.dirname(p), exist_ok=True)
                    open(p, 'wb').write(data); n += 1
            print('extracted', n)
if __name__ == '__main__':
    main()
