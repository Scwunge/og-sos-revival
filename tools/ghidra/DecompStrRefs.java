// Decompile every function that references any of the given UTF-16 (or ASCII) string literals.
// Args: <outFile> <str1> <str2> ...   (prefix a string with "a:" for ASCII search)
// Also prints the string address and referencing function names/addresses.
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import java.io.*;
import java.util.*;

public class DecompStrRefs extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] a = getScriptArgs();
        PrintWriter out = new PrintWriter(new FileWriter(a[0]));
        DecompInterface di = new DecompInterface();
        di.openProgram(currentProgram);
        LinkedHashMap<Function,List<String>> funcs = new LinkedHashMap<>();
        for (int i = 1; i < a.length; i++) {
            String s = a[i].replace("~q~", "'").replace("~p~", "%");
            byte[] pat; 
            if (a[i].startsWith("a:")) { s = s.substring(2); pat = (s + "\0").getBytes("US-ASCII"); }
            else { pat = (s + "\0").getBytes("UTF-16LE"); }
            // include leading zero for exact start
            byte[] full = new byte[pat.length + (s.length()>0 && a[i].startsWith("a:") ? 1 : 2)];
            System.arraycopy(pat,0,full,full.length-pat.length,pat.length);
            Address start = currentProgram.getMinAddress();
            int found = 0;
            while (true) {
                Address ad = currentProgram.getMemory().findBytes(start, full, null, true, monitor);
                if (ad == null) break;
                Address sa = ad.add(full.length - pat.length);
                found++;
                out.println("// STRING '" + s + "' at " + sa);
                for (Reference r : getReferencesTo(sa)) {
                    Function f = getFunctionContaining(r.getFromAddress());
                    out.println("//   ref from " + r.getFromAddress() + " in " + (f==null?"none":f.getName()+"@"+f.getEntryPoint()));
                    if (f != null) funcs.computeIfAbsent(f, k -> new ArrayList<>()).add(s);
                }
                start = ad.add(1);
            }
            if (found == 0) out.println("// STRING NOT FOUND '" + s + "'");
        }
        for (Map.Entry<Function,List<String>> e : funcs.entrySet()) {
            Function f = e.getKey();
            out.println("\n//=================================================");
            out.println("// FUNCTION " + f.getName() + " @ " + f.getEntryPoint() + " size=" + f.getBody().getNumAddresses() + " uses " + e.getValue());
            DecompileResults r = di.decompileFunction(f, 120, monitor);
            if (r.decompileCompleted()) out.println(r.getDecompiledFunction().getC());
            else out.println("// decompile failed");
        }
        out.close();
    }
}
