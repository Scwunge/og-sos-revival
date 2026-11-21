// List callers (and decompile them) of external/imported symbols by name substring. Args: <outFile> <name1> ...
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.io.*;
import java.util.*;

public class ImportCallers extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] a = getScriptArgs();
        PrintWriter out = new PrintWriter(new FileWriter(a[0]));
        DecompInterface di = new DecompInterface();
        di.openProgram(currentProgram);
        Set<Function> fs = new LinkedHashSet<>();
        SymbolTable st = currentProgram.getSymbolTable();
        for (int i = 1; i < a.length; i++) {
            SymbolIterator it = st.getSymbolIterator("*" + a[i] + "*", true);
            while (it.hasNext()) {
                Symbol s = it.next();
                out.println("// SYM " + s.getName() + " @ " + s.getAddress() + " ext=" + s.isExternal());
                for (Reference r : getReferencesTo(s.getAddress())) {
                    Function f = getFunctionContaining(r.getFromAddress());
                    out.println("//   ref " + r.getReferenceType() + " " + r.getFromAddress() + " in " + (f == null ? "none" : f.getName() + "@" + f.getEntryPoint()));
                    if (f != null) fs.add(f);
                }
            }
        }
        for (Function f : fs) {
            out.println("\n//===== " + f.getName() + " @ " + f.getEntryPoint());
            DecompileResults r = di.decompileFunction(f, 120, monitor);
            out.println(r.decompileCompleted() ? r.getDecompiledFunction().getC() : "// decompile failed");
        }
        out.close();
    }
}
