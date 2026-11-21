// For every call to the given function(s), print the UTF-16 string loaded into RDX (2nd arg) shortly before the call.
// Args: <outFile> <funcAddr> ...   (e.g. FParse::Param 1404ab840, FParse::Value 1404c1780)
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.mem.*;
import java.io.*;
import java.util.*;

public class ParamList extends GhidraScript {
    String ustr(Address p) {
        try {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < 80; i++) {
                int c = (currentProgram.getMemory().getByte(p.add(i*2)) & 0xff) | ((currentProgram.getMemory().getByte(p.add(i*2+1)) & 0xff) << 8);
                if (c == 0) break;
                if (c < 32 || c > 126) return null;
                sb.append((char)c);
            }
            return sb.length() == 0 ? null : sb.toString();
        } catch (Exception e) { return null; }
    }
    @Override
    public void run() throws Exception {
        String[] a = getScriptArgs();
        PrintWriter out = new PrintWriter(new FileWriter(a[0]));
        for (int i = 1; i < a.length; i++) {
            Address fa = toAddr(a[i]);
            out.println("// CALLS TO " + fa);
            TreeMap<String,String> rows = new TreeMap<>();
            for (Reference r : getReferencesTo(fa)) {
                Address from = r.getFromAddress();
                Function f = getFunctionContaining(from);
                Instruction ins = getInstructionAt(from);
                String found = null;
                Instruction cur = ins;
                for (int k = 0; k < 14 && cur != null; k++) {
                    cur = cur.getPrevious();
                    if (cur == null) break;
                    String m = cur.getMnemonicString();
                    if (m.equals("LEA") || m.equals("MOV")) {
                        for (Reference rr : cur.getReferencesFrom()) {
                            String s = ustr(rr.getToAddress());
                            if (s != null) { found = s; break; }
                        }
                        if (found != null) break;
                    }
                }
                rows.put(from.toString(), (f == null ? "none" : f.getEntryPoint().toString()) + "  " + (found == null ? "?" : found));
            }
            for (Map.Entry<String,String> e : rows.entrySet()) out.println(e.getKey() + "  " + e.getValue());
        }
        out.close();
    }
}
