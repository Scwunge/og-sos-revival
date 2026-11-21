// List references (with type READ/WRITE/CALL) to each given address and function containing the ref.
// Args: <outFile> <addr> ...
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.io.*;

public class RefList extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] a = getScriptArgs();
        PrintWriter out = new PrintWriter(new FileWriter(a[0]));
        for (int i = 1; i < a.length; i++) {
            Address ad = toAddr(a[i]);
            out.println("// REFS TO " + ad);
            for (Reference r : getReferencesTo(ad)) {
                Function f = getFunctionContaining(r.getFromAddress());
                out.println("//   " + r.getReferenceType() + " " + r.getFromAddress() + " in " + (f == null ? "none" : f.getName() + "@" + f.getEntryPoint()));
            }
        }
        out.close();
    }
}
