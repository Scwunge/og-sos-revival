/* Loads the built xinput1_3.dll from the current directory and calls it. */
#include <windows.h>
#include <stdio.h>
typedef DWORD (WINAPI *Fn)(DWORD, void *);
int main(void)
{
    HMODULE h = LoadLibraryA("build/xinput1_3.dll");
    if (!h) { printf("load failed %lu\n", GetLastError()); return 1; }
    Fn gs = (Fn)(void *)GetProcAddress(h, "XInputGetState");
    Fn ord2 = (Fn)(void *)GetProcAddress(h, MAKEINTRESOURCEA(2));
    Fn ord100 = (Fn)(void *)GetProcAddress(h, MAKEINTRESOURCEA(100));
    char st[64] = { 0 };
    printf("XInputGetState=%p ord2=%p ord100=%p\n", (void *)gs, (void *)ord2, (void *)ord100);
    if (!gs || !ord2 || !ord100) return 2;
    printf("GetState(0) -> %lu\n", gs(0, st));
    printf("ord2(1) -> %lu\n", ord2(1, st));
    printf("ord100(0) -> %lu\n", ord100(0, st));
    printf("GetCapabilities -> %lu\n", ((DWORD (WINAPI *)(DWORD, DWORD, void *))(void *)GetProcAddress(h, "XInputGetCapabilities"))(0, 0, st));
    return 0;
}
