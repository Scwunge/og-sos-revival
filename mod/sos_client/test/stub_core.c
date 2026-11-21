/* Stand-in core for the update test: records that it was started. Build with -DSTUB_VER=<n>. */
#include <windows.h>
#include <stdio.h>
#include <wchar.h>
#ifndef STUB_VER
#define STUB_VER 1
#endif
__declspec(dllexport) const unsigned long sos_core_version = STUB_VER;
__declspec(dllexport) int sos_core_start(HMODULE self, void *xi)
{
    (void)xi;
    wchar_t p[MAX_PATH];
    GetModuleFileNameW(self, p, MAX_PATH);
    wchar_t *s = wcsrchr(p, L'\\');
    if (!s) return 0;
    wcscpy(s + 1, L"started.txt");
    FILE *f = _wfopen(p, L"a");
    if (f) { fprintf(f, "v%d\n", STUB_VER); fclose(f); }
    return 1;
}
BOOL WINAPI DllMain(HINSTANCE i, DWORD r, LPVOID x) { (void)i; (void)r; (void)x; return TRUE; }
