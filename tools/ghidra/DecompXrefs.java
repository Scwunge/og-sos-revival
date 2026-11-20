// Decompile every function that references any given address (data or code).
// Args: <outFile> <addr> ...
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.io.*;
import java.util.*;

public class DecompXrefs extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] a = getScriptArgs();
        PrintWriter out = new PrintWriter(new FileWriter(a[0]));
        DecompInterface di = new DecompInterface();
        di.openProgram(currentProgram);
        LinkedHashMap<Function,List<String>> funcs = new LinkedHashMap<>();
        for (int i = 1; i < a.length; i++) {
            Address ad = toAddr(a[i]);
            for (Reference r : getReferencesTo(ad)) {
                Function f = getFunctionContaining(r.getFromAddress());
                out.println("// xref " + a[i] + " from " + r.getFromAddress() + " in " + (f==null?"none":f.getName()));
                if (f != null) funcs.computeIfAbsent(f, k -> new ArrayList<>()).add(a[i]);
            }
        }
        for (Map.Entry<Function,List<String>> e : funcs.entrySet()) {
            Function f = e.getKey();
            out.println("\n//=================================================");
            out.println("// FUNCTION " + f.getName() + " @ " + f.getEntryPoint() + " refs " + e.getValue());
            DecompileResults r = di.decompileFunction(f, 120, monitor);
            out.println(r.decompileCompleted() ? r.getDecompiledFunction().getC() : "// fail");
        }
        out.close();
    }
}
