"""Minimal Blueprint (Kismet) bytecode disassembler for cooked UE 4.12 single-file assets. stdlib only.
Read-only. Object references are FPackageIndex (4 bytes on disk, 8 in memory) and names are 8 bytes on disk,
12 in memory (FScriptName); jump targets are in-memory offsets, so the listing shows memory offsets.

Usage:
  python -I kismet_dis.py <asset.uasset> list                 # functions with bytecode
  python -I kismet_dis.py <asset.uasset> dis [FunctionName]   # disassemble (default: all)
  python -I kismet_dis.py <asset.uasset> strings              # string/name constants per function
"""
import struct, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import uasset_dump as U

EXPORT_SIZE = 72    # FObjectExport on disk for this 4.12 cook: 18 int32s, 32-bit SerialSize/SerialOffset

def load(path):
    b = open(path, 'rb').read()
    d = U.parse(b)
    N = d['names']
    r = U.R(b); r.o = d['eo']
    ex = []
    for _ in range(d['ec']):
        o = r.o
        cl, sup, outer = struct.unpack_from('<iii', b, o)
        nm, num = struct.unpack_from('<ii', b, o + 12)
        sz, off = struct.unpack_from('<ii', b, o + 24)
        ex.append(dict(cls=cl, sup=sup, outer=outer, name=N[nm], size=sz, off=off))
        r.o = o + EXPORT_SIZE
    # FObjectImport: ClassPackage FName, ClassName FName, OuterIndex i32, ObjectName FName (28 bytes).
    # (uasset_dump's import tuple does not include ObjectName, so re-read it here.)
    imps = []
    for k in range(d['ic']):
        o = d['io'] + 28 * k
        cp, _, cn, _, outer, on, _ = struct.unpack_from('<7i', b, o)
        imps.append((N[cp], N[cn], N[on], outer))
    d['imports'] = imps
    return b, d, ex

def objname(d, ex, idx):
    if idx == 0: return 'null'
    if idx < 0:
        i = -idx - 1
        return d['imports'][i][2] if i < len(d['imports']) else f'imp?{i}'
    i = idx - 1
    return ex[i]['name'] if i < len(ex) else f'exp?{i}'

def find_script(b, start, end):
    """Find (memsize, disksize, offset) of a script block inside [start,end)."""
    best = None
    for p in range(start, end - 8):
        A, B = struct.unpack_from('<ii', b, p)
        if 0 < B <= A <= 2 * B + 16 and p + 8 + B <= end and b[p + 8 + B - 1] == 0x53:
            if best is None or B > best[1]: best = (A, B, p + 8)
    return best

class Dis:
    def __init__(s, b, d, ex, o, n):
        s.b, s.d, s.ex, s.o, s.end, s.mem = b, d, ex, o, o + n, 0
        s.base = o; s.lines = []; s.strs = []
    def u8(s): v = s.b[s.o]; s.o += 1; s.mem += 1; return v
    def u16(s): v, = struct.unpack_from('<H', s.b, s.o); s.o += 2; s.mem += 2; return v
    def i32(s): v, = struct.unpack_from('<i', s.b, s.o); s.o += 4; s.mem += 4; return v
    def f32(s): v, = struct.unpack_from('<f', s.b, s.o); s.o += 4; s.mem += 4; return v
    def ptr(s):
        v, = struct.unpack_from('<i', s.b, s.o); s.o += 4; s.mem += 8; return objname(s.d, s.ex, v)
    def name(s):
        i, n = struct.unpack_from('<ii', s.b, s.o); s.o += 8; s.mem += 12   # FScriptName is 12 bytes in memory
        N = s.d['names']; return N[i] if 0 <= i < len(N) else f'name?{i}'
    def cstr(s):
        e = s.b.index(b'\0', s.o); v = s.b[s.o:e].decode('latin1'); s.mem += e + 1 - s.o; s.o = e + 1; return v
    def wstr(s):
        o = s.o
        while s.b[o:o+2] != b'\0\0': o += 2
        v = s.b[s.o:o].decode('utf-16le'); s.mem += o + 2 - s.o; s.o = o + 2; return v
    def args(s):
        a = []
        while s.b[s.o] != 0x16: a.append(s.expr())
        s.u8(); return a
    def expr(s):
        t = s.u8()
        if t == 0x00: return 'L.' + s.ptr()
        if t == 0x01: return 'this.' + s.ptr()
        if t == 0x02: return 'def.' + s.ptr()
        if t == 0x48: return 'out.' + s.ptr()
        if t == 0x04: return 'return ' + s.expr()
        if t == 0x06: return f'jump 0x{s.i32():x}'
        if t == 0x07:
            j = s.i32(); return f'if not ({s.expr()}) jump 0x{j:x}'
        if t == 0x09: s.u16(); s.u8(); return 'assert ' + s.expr()
        if t == 0x0B: return 'nothing'
        if t == 0x0F: s.ptr(); a = s.expr(); return f'{a} = {s.expr()}'
        if t in (0x14, 0x5F, 0x60, 0x44, 0x43): a = s.expr(); return f'{a} = {s.expr()}'
        if t == 0x64: p = s.ptr(); return f'frame.{p} = {s.expr()}'
        if t == 0x51: return f'iface({s.expr()})'
        if t in (0x12, 0x19, 0x1A):
            o = s.expr(); s.i32(); s.ptr(); return f'{o}->{s.expr()}'
        if t == 0x13: c = s.ptr(); return f'metacast<{c}>({s.expr()})'
        if t in (0x2E, 0x52, 0x54, 0x55): c = s.ptr(); return f'cast<{c}>({s.expr()})'
        if t == 0x15: return 'endparm'
        if t == 0x17: return 'self'
        if t == 0x18: s.i32(); return 'skip ' + s.expr()
        if t in (0x1B, 0x45): n = s.name(); return f'{n}({", ".join(s.args())})'
        if t in (0x1C, 0x46, 0x68): f = s.ptr(); return f'{f}({", ".join(s.args())})'
        if t == 0x1D: return str(s.i32())
        if t == 0x1E: return repr(s.f32())
        if t == 0x1F: v = s.cstr(); s.strs.append(v); return repr(v)
        if t == 0x34: v = s.wstr(); s.strs.append(v); return 'u' + repr(v)
        if t == 0x20: return 'obj:' + s.ptr()
        if t == 0x21: v = s.name(); s.strs.append('name:' + v); return 'name:' + v
        if t in (0x22, 0x23): s.o += 12; s.mem += 12; return 'vec/rot'
        if t == 0x24: return f'byte {s.u8()}'
        if t == 0x25: return '0'
        if t == 0x26: return '1'
        if t == 0x27: return 'true'
        if t == 0x28: return 'false'
        if t == 0x29:
            k = s.u8()
            if k == 0: return 'text""'
            if k == 1: a = s.expr(); s.expr(); s.expr(); return 'text' + a
            if k in (2, 3): return 'text' + s.expr()
            return f'text?{k}'
        if t == 0x2A: return 'none'
        if t == 0x2B: s.ptr(); s.u8(); return 'transform?'
        if t == 0x2C: return str(s.u8())
        if t == 0x2D: return 'nointerface'
        if t == 0x2F:
            st = s.ptr(); s.i32(); a = []
            while s.b[s.o] != 0x30: a.append(s.expr())
            s.u8(); return f'{st}{{{", ".join(a)}}}'
        if t == 0x31:
            a = s.expr(); v = []
            while s.b[s.o] != 0x32: v.append(s.expr())
            s.u8(); return f'{a} = [{", ".join(v)}]'
        if t == 0x65:
            s.ptr(); s.i32(); v = []
            while s.b[s.o] != 0x66: v.append(s.expr())
            s.u8(); return f'[{", ".join(v)}]'
        if t == 0x35: s.u8(); return f'pcast({s.expr()})'
        if t == 0x38: s.u8(); return f'pcast({s.expr()})'
        if t == 0x36: s.o += 8; s.mem += 8; return 'u64'
        if t == 0x37: s.o += 8; s.mem += 8; return 'i64'
        if t == 0x42: p = s.ptr(); return f'({s.expr()}).{p}'
        if t == 0x4B: return 'delegate:' + s.name()
        if t == 0x4C: return f'push 0x{s.i32():x}'
        if t == 0x4D: return 'pop'
        if t == 0x4E: return 'computedjump ' + s.expr()
        if t == 0x4F: return f'pop if not ({s.expr()})'
        if t in (0x50, 0x5A, 0x5E, 0x6A): return 'trace'
        if t == 0x53: return 'end'
        if t == 0x5B: return f'skipoff 0x{s.i32():x}'
        if t == 0x61: n = s.name(); a = s.expr(); return f'bind {n} {a} {s.expr()}'
        if t in (0x5C, 0x62): a = s.expr(); return f'{a} += {s.expr()}'
        if t == 0x5D: return 'clear ' + s.expr()
        if t == 0x63: f = s.ptr(); return f'broadcast {f}({", ".join(s.args())})'
        if t == 0x69:
            n = s.u16(); s.i32(); idx = s.expr(); cs = []
            for _ in range(n):
                k = s.expr(); s.i32(); cs.append(f'{k}:{s.expr()}')
            return f'switch({idx}) {{{"; ".join(cs)}; default:{s.expr()}}}'
        if t == 0x6B: a = s.expr(); return f'{a}[{s.expr()}]'
        raise ValueError(f'unknown token 0x{t:02x} at file 0x{s.o-1:x}')
    def run(s):
        while s.o < s.end:
            m = s.mem
            try: e = s.expr()
            except Exception as x:
                s.lines.append(f'  !! {x}'); break
            s.lines.append(f'  {m:05x}: {e}')
        return s

def functions(path):
    b, d, ex = load(path)
    out = []
    for e in ex:
        if objname(d, ex, e['cls']) not in ('Function', 'DelegateFunction'): continue
        sc = find_script(b, e['off'], e['off'] + e['size'])
        if sc: out.append((e['name'], sc))
    return b, d, ex, out

def main():
    path, cmd = sys.argv[1], sys.argv[2]
    want = sys.argv[3] if len(sys.argv) > 3 else None
    b, d, ex, fs = functions(path)
    for nm, (A, B, o) in fs:
        if cmd == 'list': print(f'{nm}  mem={A} disk={B}'); continue
        if want and nm != want: continue
        ds = Dis(b, d, ex, o, B).run()
        if cmd == 'dis':
            print(f'== {nm}'); print('\n'.join(ds.lines))
        elif cmd == 'strings':
            print(f'== {nm}: {ds.strs}')

if __name__ == '__main__':
    main()
