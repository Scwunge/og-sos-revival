// Decompile functions by address; optionally list callers/callees.
// Args: <outFile> <addr1> <addr2> ...   (hex, no 0x needed). Prefix "c:" to also list callers.
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.io.*;
import java.util.*;

public class DecompAddr extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] a = getScriptArgs();
        PrintWriter out = new PrintWriter(new FileWriter(a[0]));
        DecompInterface di = new DecompInterface();
        di.openProgram(currentProgram);
        for (int i = 1; i < a.length; i++) {
            String s = a[i];
            boolean callers = s.startsWith("c:");
            if (callers) s = s.substring(2);
            Address ad = toAddr(s);
            Function f = getFunctionContaining(ad);
            if (f == null) { out.println("// no function at " + s); continue; }
            out.println("\n//=================================================");
            out.println("// FUNCTION " + f.getName() + " @ " + f.getEntryPoint());
            if (callers) {
                for (Reference r : getReferencesTo(f.getEntryPoint())) {
                    Function c = getFunctionContaining(r.getFromAddress());
                    out.println("//   caller " + r.getFromAddress() + " in " + (c==null?"none":c.getName()+"@"+c.getEntryPoint()));
                }
            }
            DecompileResults r = di.decompileFunction(f, 120, monitor);
            out.println(r.decompileCompleted() ? r.getDecompiledFunction().getC() : "// decompile failed");
        }
        out.close();
    }
}
