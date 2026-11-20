// Dump qword slots starting at an address: value, and either the UTF-16 string or function it points at.
// Args: <outFile> <addr:count> ...  or  s:<addr> to print a UTF-16 string
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.mem.*;
import java.io.*;

public class DumpPtrs extends GhidraScript {
    String ustr(Address p) {
        try {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 80; i++) {
                int c = currentProgram.getMemory().getShort(p.add(i * 2)) & 0xffff;
                if (c == 0) break;
                if (c < 32 || c > 126) return null;
                sb.append((char) c);
            }
            return sb.length() >= 1 ? sb.toString() : null;
        } catch (Exception e) { return null; }
    }
    @Override
    public void run() throws Exception {
        String[] a = getScriptArgs();
        PrintWriter out = new PrintWriter(new FileWriter(a[0]));
        for (int i = 1; i < a.length; i++) {
            if (a[i].startsWith("s:")) { Address sa = toAddr(a[i].substring(2)); out.println("STR " + sa + " = " + ustr(sa)); continue; }
            if (a[i].startsWith("b:")) { String[] q = a[i].split(":"); Address ba = toAddr(q[1]); int bn = Integer.parseInt(q[2]); StringBuilder sb = new StringBuilder(); for (int k = 0; k < bn; k++) sb.append(String.format("%02x ", currentProgram.getMemory().getByte(ba.add(k)) & 0xff)); out.println("BYTES " + ba + ": " + sb); continue; }
            String[] p = a[i].split(":");
            Address base = toAddr(p[0]);
            int n = Integer.parseInt(p[1]);
            out.println("// table " + base);
            for (int k = 0; k < n; k++) {
                Address slot = base.add(k * 8L);
                long v;
                try { v = currentProgram.getMemory().getLong(slot); } catch (Exception e) { break; }
                String d = "";
                try {
                    Address t = toAddr(v);
                    Function f = getFunctionAt(t);
                    if (f != null) d = "func " + f.getName();
                    else {
                        String s = ustr(t);
                        if (s != null) d = "\"" + s + "\"";
                        else {
                            // pointer-to-pointer-to-string
                            long v2 = currentProgram.getMemory().getLong(t);
                            String s2 = ustr(toAddr(v2));
                            if (s2 != null) d = "->\"" + s2 + "\"";
                        }
                    }
                } catch (Exception e) {}
                out.println(slot + " " + Long.toHexString(v) + " " + d);
            }
        }
        out.close();
    }
}
