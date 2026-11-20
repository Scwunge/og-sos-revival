"""Tiny UE4 uasset reader (names, imports, exports) for cooked single-file assets. stdlib only."""
import struct, sys

class R:
    def __init__(s, b): s.b = b; s.o = 0
    def i32(s): v, = struct.unpack_from('<i', s.b, s.o); s.o += 4; return v
    def u32(s): v, = struct.unpack_from('<I', s.b, s.o); s.o += 4; return v
    def i64(s): v, = struct.unpack_from('<q', s.b, s.o); s.o += 8; return v
    def f32(s): v, = struct.unpack_from('<f', s.b, s.o); s.o += 4; return v
    def u8(s): v = s.b[s.o]; s.o += 1; return v
    def fstr(s):
        n = s.i32()
        if n == 0: return ''
        if n < 0:
            n = -n; v = s.b[s.o:s.o+2*n-2].decode('utf-16le'); s.o += 2*n
        else:
            v = s.b[s.o:s.o+n-1].decode('utf-8', 'replace'); s.o += n
        return v

def parse(b):
    r = R(b)
    assert r.u32() == 0x9E2A83C1
    leg = r.i32()
    if leg != -4: r.i32()
    ver = r.i32()
    lic = r.i32()
    if leg <= -2:
        for _ in range(r.i32()):
            r.o += 16; r.i32()
    hdr = r.i32(); r.fstr(); r.u32()
    nc, no = r.i32(), r.i32()
    r.i32(); r.i32()
    ec, eo = r.i32(), r.i32()
    ic, io = r.i32(), r.i32()
    r.o = no
    names = []
    for _ in range(nc):
        names.append(r.fstr()); r.o += 4
    r.o = io
    imports = []
    for _ in range(ic):
        pk, cl, nm = r.i32(), r.i32(), r.i32(); r.i32() if False else None
        r.o += 8 - 8
        nm_num = r.i32(); outer = r.i32(); nm2 = r.i32(); n2 = r.i32()
        imports.append((names[pk], names[cl], names[nm], outer))
    return dict(r=r, ver=ver, leg=leg, names=names, ec=ec, eo=eo, ic=ic, io=io, hdr=hdr, imports=imports)

if __name__ == '__main__':
    d = parse(open(sys.argv[1], 'rb').read())
    print(d['ver'], d['leg'], len(d['names']), d['ec'], d['eo'], d['ic'], d['hdr'])
    print(d['names'][:60])

def exports(d, b):
    r = d['r']; r.o = d['eo']; out = []
    names = d['names']
    for _ in range(d['ec']):
        cl, sup, outer = r.i32(), r.i32(), r.i32()
        nm, num = r.i32(), r.i32()
        flags = r.u32(); sz = r.i64(); off = r.i64()
        r.o += 12 + 16 + 4 + 4  # forced/notclient/notserver, guid, pkgflags, notalways
        # remaining are version dependent; detect via next export start heuristic
        out.append((cl, sup, outer, names[nm], sz, off, r.o))
    return out
