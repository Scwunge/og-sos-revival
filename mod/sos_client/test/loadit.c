/* loadit <dir>: loads <dir>\xinput1_3.dll the way the game does, to exercise the loader. */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv)
{
    char p[MAX_PATH];
    if (argc < 2) return 2;
    snprintf(p, sizeof p, "%s\\xinput1_3.dll", argv[1]);
    HMODULE h = LoadLibraryA(p);
    printf("%s\n", h ? "loaded" : "FAILED");
    if (h && argc > 2) Sleep((DWORD)atoi(argv[2]) * 1000);   /* stay alive so the core's updater can run */
    return h ? 0 : 1;
}
