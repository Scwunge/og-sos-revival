"""Find UTF-16 literals in the SOS exe and the code that LEA-references them (RIP-relative).
usage: python re_xrefs.py <exe> literal [literal ...]"""
import sys, re, struct, pefile
exe = sys.argv[1]; lits = sys.argv[2:]
pe = pefile.PE(exe, fast_load=True)
data = open(exe,'rb').read()
base = pe.OPTIONAL_HEADER.ImageBase
secs = [(s.Name.rstrip(b'\0').decode(), s.VirtualAddress, s.Misc_VirtualSize, s.PointerToRawData, s.SizeOfRawData, s.Characteristics) for s in pe.sections]
def off2rva(o):
    for n,va,vs,po,ps,_ in secs:
        if po<=o<po+ps: return va+o-po
def rva2off(r):
    for n,va,vs,po,ps,_ in secs:
        if va<=r<va+max(vs,ps): return po+r-va
text=[s for s in secs if s[5]&0x20000000]
def xrefs(target):
    out=[]
    for n,va,vs,po,ps,_ in text:
        buf=data[po:po+ps]
        # lea r64,[rip+disp32]: REX(48/4c) 8D modrm(mod00 rm101) disp32
        for m in re.finditer(rb'[\x48\x4c]\x8d[\x05\x0d\x15\x1d\x25\x2d\x35\x3d]', buf, re.S):
            i=m.start()
            if i+7>len(buf): continue
            d=struct.unpack_from('<i',buf,i+3)[0]
            r=va+i+7+d
            if r==target: out.append(va+i)
    return out
for l in lits:
    pat=l.encode('utf-16le')
    for m in re.finditer(re.escape(pat), data):
        o=m.start()
        # exact string: preceded by 0 char, followed by 0 char
        if data[o-2:o]!=b'\0\0' or data[o+len(pat):o+len(pat)+2]!=b'\0\0': continue
        r=off2rva(o)
        print(f'{l!r} rva=0x{r:x} xrefs=', [hex(x) for x in xrefs(r)])
