"""Dump UE4.12 cooked DataTable uasset (single-file) rows as JSON (names + tagged props). stdlib only.
Usage: python -I dt_dump.py <file.uasset> [out.json]"""
import sys, json, struct
sys.path.insert(0, __import__('os').path.dirname(__file__))
import uasset_dump as u

def fname(r, names):
    i = r.i32(); n = r.i32()
    s = names[i] if 0 <= i < len(names) else f'<bad{i}>'
    return s if n == 0 else f'{s}_{n-1}'

def read_props(r, names, end):
    props = {}
    while r.o < end:
        name = fname(r, names)
        if name == 'None': break
        typ = fname(r, names); size = r.i32(); idx = r.i32()
        extra = None
        if typ == 'StructProperty': extra = fname(r, names)
        elif typ == 'ByteProperty' or typ == 'EnumProperty': extra = fname(r, names)
        elif typ == 'ArrayProperty': extra = fname(r, names)
        elif typ == 'BoolProperty': extra = r.u8()
        hasguid = r.u8()
        if hasguid: r.o += 16
        start = r.o
        props[name] = read_val(r, names, typ, extra, size)
        r.o = start + size if typ != 'BoolProperty' else start
    return props

def read_val(r, names, typ, extra, size):
    if typ == 'IntProperty': return r.i32()
    if typ == 'FloatProperty': return r.f32()
    if typ == 'BoolProperty': return bool(extra)
    if typ == 'NameProperty': return fname(r, names)
    if typ in ('StrProperty',): return r.fstr()
    if typ == 'TextProperty':
        return {'text_raw': r.b[r.o:r.o+size].hex()[:0], 'strings': _strs(r.b[r.o:r.o+size])}
    if typ == 'ByteProperty':
        return fname(r, names) if size == 8 else r.u8()
    if typ == 'ObjectProperty': return r.i32()
    if typ in ('AssetObjectProperty', 'AssetClassProperty'): return r.fstr()
    if typ == 'StructProperty':
        return read_props(r, names, r.o + size)
    if typ == 'ArrayProperty':
        n = r.i32(); out = []
        # inner tags unknown here; handle simple inners via size heuristics
        rest = size - 4
        if extra in ('NameProperty',):
            return [fname(r, names) for _ in range(n)]
        if extra == 'IntProperty': return [r.i32() for _ in range(n)]
        if extra == 'StructProperty':
            # inner tag precedes: name,type,size,idx,structname,guid
            nm = fname(r, names); t = fname(r, names); sz = r.i32(); ix = r.i32(); sn = fname(r, names)
            r.o += 16 + 1
            return [read_props(r, names, r.o + 10**9) for _ in range(n)]
        return {'array_of': extra, 'n': n}
    return {'unhandled': typ, 'size': size}

def _strs(b):
    import re
    return [m.decode('latin1') for m in re.findall(rb'[\x20-\x7e]{2,}', b)]

def dump(path):
    b = open(path, 'rb').read(); d = u.parse(b); names = d['names']
    r = d['r']; r.o = d['eo']
    r.i32(); r.i32(); r.i32(); r.i32(); r.i32(); r.u32()
    size = r.i32(); off = r.i32()
    r.o = off
    top = read_props(r, names, off + size)
    r.i32()  # UObject bHasGuid
    n = r.i32(); rows = []
    for _ in range(n):
        rn = fname(r, names)
        p = read_props(r, names, off + size)
        rows.append((rn, p))
    return top, rows

if __name__ == '__main__':
    top, rows = dump(sys.argv[1])
    out = {'top': top, 'rows': [{'row': a, **{'props': p}} for a, p in rows]}
    s = json.dumps(out, indent=1, default=str)
    if len(sys.argv) > 2: open(sys.argv[2], 'w').write(s)
    print(len(rows), 'rows'); print(s[:3000])
