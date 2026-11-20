"""Disassemble a range of the SOS exe, annotating RIP-relative UTF-16 literals and calls.
usage: python re_dis.py <exe> <start_rva_hex> <end_rva_hex>"""
import sys, struct, pefile, capstone
exe=sys.argv[1]; a=int(sys.argv[2],16); b=int(sys.argv[3],16)
pe=pefile.PE(exe,fast_load=True); data=open(exe,'rb').read()
def rva2off(r):
    for s in pe.sections:
        if s.VirtualAddress<=r<s.VirtualAddress+s.Misc_VirtualSize: return s.PointerToRawData+r-s.VirtualAddress
def u16(r):
    o=rva2off(r)
    if o is None: return None
    s=b''
    for i in range(0,200,2):
        c=data[o+i:o+i+2]
        if c==b'\0\0': break
        s+=c
    try:
        t=s.decode('utf-16le')
        return t if t and all(32<=ord(c)<127 for c in t) else None
    except: return None
md=capstone.Cs(capstone.CS_ARCH_X86,capstone.CS_MODE_64); md.detail=False
o=rva2off(a)
for i in md.disasm(data[o:o+(b-a)],a):
    note=''
    if 'rip' in i.op_str and i.mnemonic in('lea',):
        d=struct.unpack_from('<i',data,rva2off(i.address)+i.size-4)[0]
        t=i.address+i.size+d; s=u16(t)
        note=f'  ; 0x{t:x}'+(f' L"{s}"' if s else '')
    print(f'{i.address:x}: {i.mnemonic} {i.op_str}{note}')
