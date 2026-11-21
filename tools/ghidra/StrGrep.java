// Substring search over UTF-16 and ASCII strings (case-insensitive by trying given case only).
// Args: <outFile> <substr1> ...   Prints full containing string, its address, and referencing functions.
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.mem.*;
import java.io.*;
import java.util.*;

public class StrGrep extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] a = getScriptArgs();
        PrintWriter out = new PrintWriter(new FileWriter(a[0]));
        Memory mem = currentProgram.getMemory();
        for (int i = 1; i < a.length; i++) {
            String s = a[i].replace("~q~", "'").replace("~p~", "%");
            for (int wide = 0; wide < 2; wide++) {
                byte[] pat = wide == 1 ? s.getBytes("UTF-16LE") : s.getBytes("US-ASCII");
                int step = wide == 1 ? 2 : 1;
                Address start = currentProgram.getMinAddress();
                Set<String> seen = new HashSet<>();
                int n = 0;
                while (n < 60) {
                    Address ad = mem.findBytes(start, pat, null, true, monitor);
                    if (ad == null) break;
                    start = ad.add(1);
                    // back up to string start
                    Address b = ad;
                    try {
                        for (int k = 0; k < 600; k++) {
                            Address p = b.subtract(step);
                            byte x = mem.getByte(p);
                            byte y = wide == 1 ? mem.getByte(p.add(1)) : 0;
                            if (x == 0 && y == 0) break;
                            b = p;
                        }
                        StringBuilder sb = new StringBuilder();
                        Address c = b;
                        for (int k = 0; k < 800; k++) {
                            int x = mem.getByte(c) & 0xff;
                            int y = wide == 1 ? (mem.getByte(c.add(1)) & 0xff) : 0;
                            if (x == 0 && y == 0) break;
                            sb.append((char) (x | (y << 8)));
                            c = c.add(step);
                        }
                        if (!seen.add(b.toString())) continue;
                        n++;
                        out.println("// [" + (wide==1?"W":"A") + "] " + b + " : " + sb.toString().replace("\n","\n"));
                        for (Reference r : getReferencesTo(b)) {
                            Function f = getFunctionContaining(r.getFromAddress());
                            out.println("//     ref " + r.getFromAddress() + " in " + (f == null ? "none" : f.getName() + "@" + f.getEntryPoint()));
                        }
                    } catch (Exception e) { }
                }
            }
        }
        out.close();
    }
}
