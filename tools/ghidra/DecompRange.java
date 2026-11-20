// Decompile every function whose entry lies in [start,end). Args: <outFile> <start> <end>
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import java.io.*;

public class DecompRange extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] a = getScriptArgs();
        PrintWriter out = new PrintWriter(new FileWriter(a[0]));
        DecompInterface di = new DecompInterface();
        di.openProgram(currentProgram);
        AddressSet set = new AddressSet(toAddr(a[1]), toAddr(a[2]));
        for (Function f : currentProgram.getFunctionManager().getFunctions(set, true)) {
            out.println("\n//=================================================");
            out.println("// FUNCTION " + f.getName() + " @ " + f.getEntryPoint() + " size=" + f.getBody().getNumAddresses());
            DecompileResults r = di.decompileFunction(f, 60, monitor);
            out.println(r.decompileCompleted() ? r.getDecompiledFunction().getC() : "// fail");
        }
        out.close();
    }
}
