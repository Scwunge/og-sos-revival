/*
 * xinput1_3.dll, the stable half of the SOS: Classic client mod (see docs/CLIENT_MOD.md, "Self-update").
 *
 * It forwards every XInput export to the real DLL (the game imports xinput1_3 by ordinal), then loads the
 * replaceable core, sos_client_core.dll, which holds all the mod's features and can update itself.
 *
 * Update rules (the loader is the only part that decides what gets loaded):
 *   - a staged core (sos_client_core.new + .new.manifest + .new.sig) is applied only when the manifest's Ed25519
 *     signature verifies against the key compiled in (update_pubkey.h), the manifest's version is HIGHER than the
 *     installed core's, and the file's size and SHA-256 match the manifest. Anything else is deleted unused.
 *   - the previous core is kept as sos_client_core.prev (+ manifest/sig). A core that fails to load, or that did
 *     not survive its first two launches (the core removes sos_client_core.trial after 60 s), is rolled back.
 *   - without a core DLL next to this one the game simply runs with plain XInput.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdarg.h>
#include <wchar.h>
#include "update_common.h"

#define XI_NAMED(X) \
    X(XInputGetState) X(XInputSetState) X(XInputGetCapabilities) X(XInputEnable) \
    X(XInputGetDSoundAudioDeviceGuids) X(XInputGetBatteryInformation) X(XInputGetKeystroke)

#define DECLARE_FWD(n) void *p_##n = NULL;
XI_NAMED(DECLARE_FWD)
void *p_xi_100 = NULL, *p_xi_101 = NULL, *p_xi_102 = NULL, *p_xi_103 = NULL;
#define ASM_FWD(n) ".globl " #n "\n" #n ":\n jmp *p_" #n "(%rip)\n"
__asm__(".text\n" XI_NAMED(ASM_FWD)
        ".globl xi_100\nxi_100:\n jmp *p_xi_100(%rip)\n"
        ".globl xi_101\nxi_101:\n jmp *p_xi_101(%rip)\n"
        ".globl xi_102\nxi_102:\n jmp *p_xi_102(%rip)\n"
        ".globl xi_103\nxi_103:\n jmp *p_xi_103(%rip)\n");

static DWORD WINAPI xi_stub(void) { return 1167; }   /* ERROR_DEVICE_NOT_CONNECTED */

static HMODULE g_real_xinput;

static void load_real_xinput(HMODULE self)
{
    static const wchar_t *names[] = { L"\\xinput1_3.dll", L"\\xinput1_4.dll" };
    wchar_t path[MAX_PATH];
    UINT n = GetSystemDirectoryW(path, MAX_PATH);
    if (n != 0 && n < MAX_PATH - 20) {
        for (int i = 0; i < 2 && !g_real_xinput; i++) {
            wchar_t full[MAX_PATH];
            _snwprintf(full, MAX_PATH - 1, L"%ls%ls", path, names[i]);
            full[MAX_PATH - 1] = 0;
            HMODULE h = LoadLibraryW(full);
            if (h && h != self) g_real_xinput = h;
        }
    }
    void *stub = (void *)xi_stub;
#define RESOLVE_FWD(n) p_##n = g_real_xinput ? (void *)GetProcAddress(g_real_xinput, #n) : NULL; \
                       if (!p_##n) p_##n = stub;
    XI_NAMED(RESOLVE_FWD)
#define RESOLVE_ORD(var, ord) var = g_real_xinput ? (void *)GetProcAddress(g_real_xinput, MAKEINTRESOURCEA(ord)) : NULL; \
                              if (!var) var = stub;
    RESOLVE_ORD(p_xi_100, 100)
    RESOLVE_ORD(p_xi_101, 101)
    RESOLVE_ORD(p_xi_102, 102)
    RESOLVE_ORD(p_xi_103, 103)
}

/* ------------------------------------------------------------------------ */

static wchar_t g_dir[MAX_PATH];

static void lg(const char *fmt, ...)
{
    wchar_t p[MAX_PATH];
    _snwprintf(p, MAX_PATH - 1, L"%lssos_client_loader.log", g_dir);
    p[MAX_PATH - 1] = 0;
    HANDLE h = CreateFileW(p, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h == INVALID_HANDLE_VALUE) return;
    LARGE_INTEGER sz;
    if (GetFileSizeEx(h, &sz) && sz.QuadPart > 64 * 1024) { CloseHandle(h); DeleteFileW(p); return; }   /* stays small */
    char line[400];
    SYSTEMTIME st;
    GetLocalTime(&st);
    int n = snprintf(line, sizeof line, "%04d-%02d-%02d %02d:%02d:%02d ", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    va_list ap;
    va_start(ap, fmt);
    n += vsnprintf(line + n, sizeof line - 3 - n, fmt, ap);
    va_end(ap);
    line[n++] = '\r';
    line[n++] = '\n';
    DWORD w;
    WriteFile(h, line, (DWORD)n, &w, NULL);
    CloseHandle(h);
}

enum { F_CORE, F_MAN, F_SIG, F_NEW, F_NEWMAN, F_NEWSIG, F_PREV, F_PREVMAN, F_PREVSIG, F_TRIAL, F_N };
static const wchar_t *const SUFFIX[F_N] = {
    L"sos_client_core.dll", L"sos_client_core.manifest", L"sos_client_core.sig",
    L"sos_client_core.new", L"sos_client_core.new.manifest", L"sos_client_core.new.sig",
    L"sos_client_core.prev", L"sos_client_core.prev.manifest", L"sos_client_core.prev.sig",
    L"sos_client_core.trial",
};
static wchar_t g_f[F_N][MAX_PATH];

static int exists(int i) { return GetFileAttributesW(g_f[i]) != INVALID_FILE_ATTRIBUTES; }
static void del(int i) { DeleteFileW(g_f[i]); }
static int mv(int from, int to) { return MoveFileExW(g_f[from], g_f[to], MOVEFILE_REPLACE_EXISTING) != 0; }

/* Installed core's version from its signed manifest; 0 when there is none (a development build). */
static unsigned long installed_version(void)
{
    UpdManifest m;
    return upd_load_manifest(g_f[F_MAN], g_f[F_SIG], &m) ? m.version : 0;
}

static int apply_staged(void)
{
    if (!exists(F_NEW)) return 0;
    UpdManifest m;
    unsigned long cur = installed_version();
    const char *why = NULL;
    if (!upd_load_manifest(g_f[F_NEWMAN], g_f[F_NEWSIG], &m)) why = "bad or missing signature";
    else if (m.version <= cur) why = "version is not higher than the installed core";
    else if (!upd_check_file(g_f[F_NEW], &m)) why = "size or SHA-256 does not match the manifest";
    if (why) {
        lg("staged core v%lu rejected: %s", m.version, why);
        del(F_NEW); del(F_NEWMAN); del(F_NEWSIG);
        return 0;
    }
    del(F_PREV); del(F_PREVMAN); del(F_PREVSIG);
    int had = exists(F_CORE);
    if (had && !mv(F_CORE, F_PREV)) { lg("could not move the current core aside (%lu); update skipped", GetLastError()); return 0; }
    if (had && exists(F_MAN)) mv(F_MAN, F_PREVMAN);
    if (had && exists(F_SIG)) mv(F_SIG, F_PREVSIG);
    if (!mv(F_NEW, F_CORE) || !mv(F_NEWMAN, F_MAN) || !mv(F_NEWSIG, F_SIG)) {
        lg("could not install the staged core (%lu); rolling back", GetLastError());
        del(F_CORE); del(F_MAN); del(F_SIG);
        if (had) { mv(F_PREV, F_CORE); mv(F_PREVMAN, F_MAN); mv(F_PREVSIG, F_SIG); }
        return 0;
    }
    upd_write_file(g_f[F_TRIAL], "1", 1);
    lg("core updated from v%lu to v%lu", cur, m.version);
    return 1;
}

static void rollback(const char *why)
{
    if (!exists(F_PREV)) { lg("%s, but there is no previous core to go back to", why); del(F_TRIAL); return; }
    lg("%s: rolling back to the previous core", why);
    del(F_CORE); del(F_MAN); del(F_SIG);
    mv(F_PREV, F_CORE); mv(F_PREVMAN, F_MAN); mv(F_PREVSIG, F_SIG);
    del(F_TRIAL);
}

typedef int (*CoreStartFn)(HMODULE, void *);

static void loader_main(HMODULE self)
{
    GetModuleFileNameW(self, g_dir, MAX_PATH);
    wchar_t *slash = wcsrchr(g_dir, L'\\');
    if (slash) slash[1] = 0;
    for (int i = 0; i < F_N; i++) { _snwprintf(g_f[i], MAX_PATH - 1, L"%ls%ls", g_dir, SUFFIX[i]); g_f[i][MAX_PATH - 1] = 0; }

    int just_applied = apply_staged();

    if (!just_applied && exists(F_TRIAL)) {   /* the launch that applied an update is attempt 1 */
        size_t n = 0;
        uint8_t *b = upd_read_file(g_f[F_TRIAL], 16, &n);
        int tries = b ? atoi((const char *)b) : 9;
        free(b);
        if (tries >= 2) rollback("the new core did not stay up for 60 s in its first two launches");
        else { char c = (char)('0' + tries + 1); upd_write_file(g_f[F_TRIAL], &c, 1); }
    }

    for (int attempt = 0; attempt < 2; attempt++) {
        if (!exists(F_CORE)) { lg("no core DLL; running plain XInput"); return; }
        HMODULE core = LoadLibraryW(g_f[F_CORE]);
        CoreStartFn start = core ? (CoreStartFn)(void *)GetProcAddress(core, "sos_core_start") : NULL;
        if (!start) {
            lg("core failed to load (%lu)", GetLastError());
            if (core) FreeLibrary(core);
            if (attempt == 0 && exists(F_PREV)) { rollback("core unusable"); continue; }
            return;
        }
        const unsigned long *ver = (const unsigned long *)GetProcAddress(core, "sos_core_version");
        lg("core loaded (build %lu, manifest v%lu)", ver ? *ver : 0UL, installed_version());
        start(core, p_XInputGetState);
        return;
    }
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        load_real_xinput(inst);
        loader_main(inst);
    }
    return TRUE;
}
