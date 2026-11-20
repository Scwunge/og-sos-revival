// Find FJsonSerializable vtables (start with 14018c410,14018c4d0,14018c2e0,14015d960,14015d810) in a range
// and decompile the slot-5 (Serialize) function of each. Args: <outFile> <startAddr> <endAddr>
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import java.io.*;
import java.util.*;

public class DecompVtables extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] a = getScriptArgs();
        PrintWriter out = new PrintWriter(new FileWriter(a[0]));
        DecompInterface di = new DecompInterface();
        di.openProgram(currentProgram);
        Address s = toAddr(a[1]), e = toAddr(a[2]);
        HashSet<Long> done = new HashSet<>();
        for (Address p = s; p.compareTo(e) < 0; p = p.add(8)) {
            long v = currentProgram.getMemory().getLong(p);
            if (v != 0x14018c410L) continue;
            if (currentProgram.getMemory().getLong(p.add(8)) != 0x14018c4d0L) continue;
            long fn = currentProgram.getMemory().getLong(p.add(0x28));
            out.println("\n//=== VTABLE " + p + " serialize=" + Long.toHexString(fn));
            if (!done.add(fn)) { out.println("// (already decompiled)"); continue; }
            Function f = getFunctionAt(toAddr(fn));
            if (f == null) { out.println("// no function"); continue; }
            DecompileResults r = di.decompileFunction(f, 120, monitor);
            out.println(r.decompileCompleted() ? r.getDecompiledFunction().getC() : "// fail");
        }
        out.close();
    }
}
