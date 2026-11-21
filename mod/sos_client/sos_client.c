/*
 * sos_client: xinput1_3.dll proxy for the SOS: Classic client (Steam app 802240).
 *
 * What it does, all inside the game process, no Engine.ini edits:
 *   1. Points the game's Outpost* endpoints at a community backend by answering
 *      FConfigCacheIni::GetString for those sections (GetInt/GetBool call
 *      GetString internally, so one hook covers ports and SSL flags too).
 *   2. Captures the "Authorization: Token <jwt>" header the game sends through
 *      WinInet (IAT hook on HttpSendRequestW).
 *   3. Tracks the current map from the engine's "LoadMap: <url>" log line.
 *   4. Draws a SERVERS button on the main menu and a server-list panel with a
 *      D3D11 overlay (hook on the inner IDXGISwapChain::Present wrapper), and
 *      subclasses the game window for mouse input.
 *   5. A worker thread talks to the backend with WinHTTP: GET /servers,
 *      POST /api/servers/<id>/join-hint, POST /api/session/<id>/vote-start.
 *
 * The game imports XINPUT1_3.dll by ordinal (2 = XInputGetState, 3 =
 * XInputSetState), so the ordinals below match the real DLL. Every export
 * forwards to the real xinput1_3.dll / xinput1_4.dll in System32. If the exe is
 * not the known Classic build, nothing is patched.
 *
 * See docs/CLIENT_MOD.md.
 */
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <winhttp.h>
#include <d3d11.h>
#include <dxgi.h>
#include <d3dcompiler.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <stdarg.h>
#include <wchar.h>
#include <wctype.h>
#include <string.h>
#include <ctype.h>

/* ------------------------------------------------------------------------ */
/* xinput1_3.dll forwarding                                                  */
/* ------------------------------------------------------------------------ */

#ifndef SOS_CORE
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

/* Used when no real XInput DLL can be loaded: ERROR_DEVICE_NOT_CONNECTED. */
static DWORD WINAPI xi_stub(void) { return 1167; }

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
            if (h && h != self) g_real_xinput = h;   /* never ourselves */
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

#else
/* Core build (sos_client_core.dll): the stable loader (xinput1_3.dll) owns the XInput forwarding and hands over
   the real XInputGetState pointer in sos_core_start(). */
static void *p_XInputGetState;
static HMODULE g_real_xinput;
#endif

/* ------------------------------------------------------------------------ */
/* Config and logging                                                        */
/* ------------------------------------------------------------------------ */

static struct {
    int override_endpoints;      /* 1: answer the Outpost* config reads */
    int show_everywhere;         /* 1: SERVERS button on every map (testing) */
    int game_log;                /* 1: mirror UE_LOG lines to sos_client_game_<pid>.log */
    int overlay;                 /* 1: draw the server browser overlay */
    int auto_play;               /* 1: queue for a match right after a server is selected */
    int hide_shutdown;           /* 1: dismiss the boot "servers shut down" overlay through its own OK handler */
    int borderless;              /* 1: windowed game becomes a borderless window covering its monitor */
    int unlock_dlc;              /* 1: report every Steam DLC / entitlement check as owned (cosmetics only) */
    int unlock_unreleased;       /* 1: let the unreleased Ronin parts and one Cynic beard pass the availability filter */
} cfg = { 1, 0, 0, 1, 1, 0, 0, 1, 1 };

static struct { wchar_t name[64], val[48]; } g_cv[32];   /* [Cvars] section of the ini */
static int g_ncv;
#ifdef SOS_CORE
static int g_auto_update = 1;      /* AutoUpdate in the ini (core build) */
#endif
static float g_vfov, g_vzfov;        /* VerticalFOV / VerticalZoomFOV from the ini, 0 = leave */
static volatile LONG g_map_gen;      /* bumped on every LoadMap */
static wchar_t g_notice_title[160], g_notice_body[640];   /* NoticeTitle / NoticeBody (boot notice replacement text) */
static float g_notice_tc[3], g_notice_bc[3];                /* linear RGB of NoticeTitleColor / NoticeBodyColor */
#define NOTICE_ON (!cfg.hide_shutdown && (g_notice_title[0] || g_notice_body[0]))
static wchar_t g_dump_pat[64];       /* DumpObjects=: log objects whose name contains this, once (development aid) */
static wchar_t g_build_label[96];   /* replacement for the BuildVersionText label; empty = leave it */

static wchar_t g_dir[MAX_PATH];
static wchar_t g_ini[MAX_PATH];
static wchar_t g_log_path[MAX_PATH];
static CRITICAL_SECTION g_log_lock;

/* Backend, "host:port" parsed. */
static wchar_t g_backend_w[256];     /* host:port */
static wchar_t g_host_w[200];
static char g_host_a[200];
static int g_port = 7781;

static void slog(const char *fmt, ...)
{
    char buf[1024];
    SYSTEMTIME t;
    GetLocalTime(&t);
    int n = snprintf(buf, sizeof buf, "[%02d:%02d:%02d.%03d][%lu] ",
                     t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, GetCurrentProcessId());
    va_list ap;
    va_start(ap, fmt);
    int m = vsnprintf(buf + n, sizeof buf - n - 2, fmt, ap);
    va_end(ap);
    if (m < 0) m = 0;
    n += m;
    if (n > (int)sizeof buf - 3) n = sizeof buf - 3;
    buf[n++] = '\r';
    buf[n++] = '\n';
    OutputDebugStringA(buf);
    if (!g_log_path[0]) return;
    EnterCriticalSection(&g_log_lock);
    HANDLE f = CreateFileW(g_log_path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f != INVALID_HANDLE_VALUE) {
        DWORD w;
        WriteFile(f, buf, (DWORD)n, &w, NULL);
        CloseHandle(f);
    }
    LeaveCriticalSection(&g_log_lock);
}

static void parse_backend(const wchar_t *in)
{
    wchar_t tmp[256];
    wcsncpy(tmp, in, 255);
    tmp[255] = 0;
    wchar_t *p = tmp;
    while (*p == L' ' || *p == L'"') p++;
    if (!_wcsnicmp(p, L"http://", 7)) p += 7;
    else if (!_wcsnicmp(p, L"https://", 8)) p += 8;
    size_t l = wcslen(p);
    while (l && (p[l - 1] == L'/' || p[l - 1] == L' ' || p[l - 1] == L'"')) p[--l] = 0;
    wchar_t *slash = wcschr(p, L'/');
    if (slash) *slash = 0;
    wchar_t *colon = wcsrchr(p, L':');
    int port = 7781;
    if (colon) {
        *colon = 0;
        int v = _wtoi(colon + 1);
        if (v > 0 && v < 65536) port = v;
    }
    if (!p[0]) return;
    wcsncpy(g_host_w, p, 199);
    g_host_w[199] = 0;
    g_port = port;
    WideCharToMultiByte(CP_UTF8, 0, g_host_w, -1, g_host_a, sizeof g_host_a, NULL, NULL);
    _snwprintf(g_backend_w, 255, L"%ls:%d", g_host_w, g_port);
    g_backend_w[255] = 0;
}

/* "RRGGBB" or "#RRGGBB" (sRGB) -> linear floats for FLinearColor. */
static void hex_to_linear(const wchar_t *s, float out[3])
{
    if (*s == L'#') s++;
    unsigned long v = wcstoul(s, NULL, 16);
    float c[3] = { (float)((v >> 16) & 255) / 255.0f, (float)((v >> 8) & 255) / 255.0f, (float)(v & 255) / 255.0f };
    for (int i = 0; i < 3; i++) out[i] = c[i] <= 0.04045f ? c[i] / 12.92f : (float)pow((c[i] + 0.055f) / 1.055f, 2.4);
}

static void load_config(HMODULE self)
{
    GetModuleFileNameW(self, g_dir, MAX_PATH);
    wchar_t *slash = wcsrchr(g_dir, L'\\');
    if (slash) slash[1] = 0;
    _snwprintf(g_ini, MAX_PATH, L"%lssos_client.ini", g_dir);
    g_ini[MAX_PATH - 1] = 0;

    cfg.override_endpoints = GetPrivateProfileIntW(L"Client", L"OverrideEndpoints", 1, g_ini);
    cfg.show_everywhere    = GetPrivateProfileIntW(L"Client", L"ShowButtonEverywhere", 0, g_ini);
    cfg.game_log           = GetPrivateProfileIntW(L"Client", L"GameLog", 0, g_ini);
    cfg.overlay            = GetPrivateProfileIntW(L"Client", L"Overlay", 1, g_ini);
    cfg.auto_play          = GetPrivateProfileIntW(L"Client", L"AutoPlay", 1, g_ini);
    cfg.hide_shutdown      = GetPrivateProfileIntW(L"Client", L"HideShutdownNotice", 0, g_ini);
#ifdef SOS_CORE
    g_auto_update          = GetPrivateProfileIntW(L"Client", L"AutoUpdate", 1, g_ini);
#endif
    GetPrivateProfileStringW(L"Client", L"BuildLabel", L"OG SOS Revival", g_build_label, 96, g_ini);
    {
        static wchar_t sec[4096];
        DWORD n = GetPrivateProfileSectionW(L"Cvars", sec, 4096, g_ini);
        for (wchar_t *s = sec; n && *s && g_ncv < 32; s += wcslen(s) + 1) {
            wchar_t *eq = wcschr(s, L'=');
            if (!eq || eq == s || s[0] == L';') continue;
            size_t nl = (size_t)(eq - s);
            if (nl >= 64 || wcslen(eq + 1) >= 48 || !eq[1]) continue;
            wcsncpy(g_cv[g_ncv].name, s, nl);
            g_cv[g_ncv].name[nl] = 0;
            wcscpy(g_cv[g_ncv].val, eq + 1);
            g_ncv++;
        }
        wchar_t fv[32];
        GetPrivateProfileStringW(L"Client", L"VerticalFOV", L"0", fv, 32, g_ini);
        g_vfov = (float)wcstod(fv, NULL);
        GetPrivateProfileStringW(L"Client", L"VerticalZoomFOV", L"0", fv, 32, g_ini);
        g_vzfov = (float)wcstod(fv, NULL);
    }
    {
        static const wchar_t dt[] = L"SOS IS BACK!";
        static const wchar_t db[] = L"The SOS servers are back online. Welcome to the community relaunch of SOS: Classic.\n\nGrab your friends, get out alive.\n\n- Scwunge";
        wchar_t col[32];
        GetPrivateProfileStringW(L"Client", L"NoticeTitle", dt, g_notice_title, 160, g_ini);
        GetPrivateProfileStringW(L"Client", L"NoticeBody", db, g_notice_body, 640, g_ini);
        for (wchar_t *s = g_notice_body, *d = g_notice_body;; s++) {      /* backslash + n in the ini = line break */
            if (s[0] == L'\\' && s[1] == L'n') { *d++ = L'\n'; s++; } else *d++ = *s;
            if (!*s) break;
        }
        GetPrivateProfileStringW(L"Client", L"NoticeTitleColor", L"FFB000", col, 32, g_ini);
        hex_to_linear(col, g_notice_tc);
        GetPrivateProfileStringW(L"Client", L"NoticeBodyColor", L"FFFFFF", col, 32, g_ini);
        hex_to_linear(col, g_notice_bc);
    }
    GetPrivateProfileStringW(L"Client", L"DumpObjects", L"", g_dump_pat, 64, g_ini);
    cfg.borderless         = GetPrivateProfileIntW(L"Client", L"Borderless", 0, g_ini);
    cfg.unlock_dlc         = GetPrivateProfileIntW(L"Client", L"UnlockDlcCosmetics", 1, g_ini);
    cfg.unlock_unreleased  = GetPrivateProfileIntW(L"Client", L"UnlockUnreleasedCosmetics", 1, g_ini);

    wchar_t be[256];
    GetPrivateProfileStringW(L"Client", L"Backend", L"sos.joltora.com:7781", be, 256, g_ini);
    parse_backend(be);
    if (!g_host_w[0]) parse_backend(L"sos.joltora.com:7781");

    wchar_t log_name[MAX_PATH];
    GetPrivateProfileStringW(L"Client", L"LogFile", L"sos_client.log", log_name, MAX_PATH, g_ini);
    if (log_name[0] && wcscmp(log_name, L"-") != 0) {
        if (wcschr(log_name, L':') || log_name[0] == L'\\')
            wcsncpy(g_log_path, log_name, MAX_PATH - 1);
        else
            _snwprintf(g_log_path, MAX_PATH - 1, L"%ls%ls", g_dir, log_name);
    }
}

/* ------------------------------------------------------------------------ */
/* Build identification and patch helpers                                    */
/* ------------------------------------------------------------------------ */

#define CLASSIC_SIZE_OF_IMAGE 48156672u
#define CLASSIC_TIMESTAMP     0x5b971052u

#define RVA_GETSTRING   0x0407720u   /* FConfigCacheIni::GetString */
#define RVA_PRESENT     0x073B930u   /* inner FD3D11Viewport present */
#define RVA_LOG_FN      0x044A500u   /* FMsg::Logf_Internal */
#define RVA_FNAME_TOSTR 0x047E090u   /* FName::ToString */
#define RVA_MEM_FREE    0x03ACC40u   /* FMemory::Free */
#define RVA_MEM_MALLOC  0x03B65D0u   /* FMemory::Malloc(size, align) */

typedef struct { wchar_t *data; int32_t num; int32_t max; } FString;
typedef struct { uint64_t v; } FName;

static uint8_t *g_base;

#define AT(rva) ((void *)(g_base + (rva)))

static int bytes_equal(const uint8_t *a, const uint8_t *b, size_t n) { return memcmp(a, b, n) == 0; }

static int write_code(void *dst, const void *src, size_t n)
{
    DWORD old;
    if (!VirtualProtect(dst, n, PAGE_EXECUTE_READWRITE, &old)) return 0;
    memcpy(dst, src, n);
    VirtualProtect(dst, n, old, &old);
    FlushInstructionCache(GetCurrentProcess(), dst, n);
    return 1;
}

/* Executable page within +-2 GB of the exe for the hook thunks. */
static uint8_t *alloc_near(uint8_t *target, size_t size)
{
    SYSTEM_INFO si;
    GetSystemInfo(&si);
    uintptr_t gran = si.dwAllocationGranularity;
    uintptr_t lo = (uintptr_t)target > 0x7FF00000 ? (uintptr_t)target - 0x7FF00000 : gran;
    for (uintptr_t a = ((uintptr_t)target - gran) & ~(gran - 1); a > lo; a -= gran) {
        void *p = VirtualAlloc((void *)a, size, MEM_RESERVE | MEM_COMMIT, PAGE_EXECUTE_READWRITE);
        if (p) return p;
    }
    uintptr_t hi = (uintptr_t)target + 0x7FF00000;
    for (uintptr_t a = ((uintptr_t)target + 0x10000000) & ~(gran - 1); a < hi; a += gran) {
        void *p = VirtualAlloc((void *)a, size, MEM_RESERVE | MEM_COMMIT, PAGE_EXECUTE_READWRITE);
        if (p) return p;
    }
    return NULL;
}

/* Entry hook: the first n bytes of the function (whole instructions, nothing
   rip-relative) move to a trampoline that jumps back to fn+n; the function
   entry becomes jmp rel32 to a thunk that jumps to `hook`. The hook receives
   the original arguments and calls the returned trampoline to run the
   original. rax is clobbered at entry (it is not an argument register).
   Uses 48 bytes at *cursor. */
static void *hook_entry(uint8_t **cursor, uint32_t rva, const uint8_t *expect, size_t n,
                        void *hook, const char *what)
{
    uint8_t *fn = g_base + rva;
    if (!*cursor) return NULL;
    if (n < 5 || n > 18 || !bytes_equal(fn, expect, n)) {
        slog("%s: prologue mismatch at +%07x; not hooked", what, rva);
        return NULL;
    }
    uint8_t *tramp = *cursor, *entry = *cursor + 32;
    uint64_t back = (uint64_t)(uintptr_t)(fn + n), to = (uint64_t)(uintptr_t)hook;
    memcpy(tramp, fn, n);
    tramp[n] = 0xFF; tramp[n + 1] = 0x25; memset(tramp + n + 2, 0, 4);   /* jmp [rip+0] */
    memcpy(tramp + n + 6, &back, 8);
    entry[0] = 0x48; entry[1] = 0xB8; memcpy(entry + 2, &to, 8); entry[10] = 0xFF; entry[11] = 0xE0;
    FlushInstructionCache(GetCurrentProcess(), tramp, 48);

    uint8_t jmp[18];
    memset(jmp, 0x90, sizeof jmp);
    jmp[0] = 0xE9;
    int64_t rel = (int64_t)(entry - (fn + 5));
    int32_t rel32 = (int32_t)rel;
    memcpy(jmp + 1, &rel32, 4);
    if (rel != rel32 || !write_code(fn, jmp, n)) {
        slog("%s: patch failed", what);
        return NULL;
    }
    *cursor += 48;
    slog("%s hooked at +%07x", what, rva);
    return tramp;
}

static int identify(void)
{
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)g_base;
    if (!g_base || dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
    IMAGE_NT_HEADERS64 *nt = (IMAGE_NT_HEADERS64 *)(g_base + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return 0;
    if (nt->OptionalHeader.SizeOfImage == CLASSIC_SIZE_OF_IMAGE &&
        nt->FileHeader.TimeDateStamp == CLASSIC_TIMESTAMP)
        return 1;
    slog("Unknown exe (SizeOfImage %lu, timestamp %08lx): not patching",
         (unsigned long)nt->OptionalHeader.SizeOfImage, (unsigned long)nt->FileHeader.TimeDateStamp);
    return 0;
}

/* Replace the IAT slot of dll!func in the main exe. Returns the old pointer. */
static void *iat_hook(const char *dll, const char *func, void *newfn, void ***slot_out)
{
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)g_base;
    IMAGE_NT_HEADERS64 *nt = (IMAGE_NT_HEADERS64 *)(g_base + dos->e_lfanew);
    IMAGE_DATA_DIRECTORY *dd = &nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!dd->VirtualAddress) return NULL;
    IMAGE_IMPORT_DESCRIPTOR *d = (IMAGE_IMPORT_DESCRIPTOR *)(g_base + dd->VirtualAddress);
    for (; d->Name; d++) {
        if (_stricmp((const char *)(g_base + d->Name), dll) != 0) continue;
        if (!d->OriginalFirstThunk || !d->FirstThunk) continue;
        IMAGE_THUNK_DATA64 *on = (IMAGE_THUNK_DATA64 *)(g_base + d->OriginalFirstThunk);
        IMAGE_THUNK_DATA64 *iat = (IMAGE_THUNK_DATA64 *)(g_base + d->FirstThunk);
        for (; on->u1.AddressOfData; on++, iat++) {
            if (IMAGE_SNAP_BY_ORDINAL64(on->u1.Ordinal)) continue;
            IMAGE_IMPORT_BY_NAME *ibn = (IMAGE_IMPORT_BY_NAME *)(g_base + on->u1.AddressOfData);
            if (strcmp((const char *)ibn->Name, func) != 0) continue;
            void *old = (void *)(uintptr_t)iat->u1.Function;
            if (slot_out) *slot_out = (void **)&iat->u1.Function;
            DWORD prot;
            if (!VirtualProtect(&iat->u1.Function, sizeof(void *), PAGE_READWRITE, &prot)) return NULL;
            if (newfn) iat->u1.Function = (ULONGLONG)(uintptr_t)newfn;
            VirtualProtect(&iat->u1.Function, sizeof(void *), prot, &prot);
            return old;
        }
    }
    return NULL;
}

/* ------------------------------------------------------------------------ */
/* Game allocator                                                            */
/* ------------------------------------------------------------------------ */

typedef void *(*MallocFn)(size_t size, uint32_t align);
typedef void (*FreeFn)(void *);

/* ------------------------------------------------------------------------ */
/* Config override: FConfigCacheIni::GetString                               */
/* ------------------------------------------------------------------------ */

typedef uint8_t (*GetStringFn)(void *cfgc, const wchar_t *section, const wchar_t *key,
                               FString *out, const FString *filename);
static GetStringFn o_getstring;

typedef struct {
    const wchar_t *section, *key;
    const wchar_t *value;
    int logged;
} Override;

static wchar_t v_base[300], v_kv[310], v_api[310], v_host[220], v_port[16];
static Override g_over[24];
static int g_nover;

static void add_over(const wchar_t *sec, const wchar_t *key, const wchar_t *val)
{
    if (g_nover >= 24) return;
    g_over[g_nover].section = sec;
    g_over[g_nover].key = key;
    g_over[g_nover].value = val;
    g_nover++;
}

static void build_overrides(void)
{
    _snwprintf(v_base, 299, L"http://%ls:%d", g_host_w, g_port);
    _snwprintf(v_kv, 309, L"%ls/kv/", v_base);
    _snwprintf(v_api, 309, L"%ls/api", v_base);
    wcsncpy(v_host, g_host_w, 219);
    _snwprintf(v_port, 15, L"%d", g_port);
    add_over(L"OutpostKeyValueStore", L"EndpointClient", v_kv);
    add_over(L"OutpostKeyValueStore", L"EndpointClientFallback", v_kv);
    add_over(L"OutpostKeyValueStore", L"EndpointServer", v_kv);
    add_over(L"OutpostIdentity", L"Endpoint", v_base);
    add_over(L"OutpostAppPersistence", L"Endpoint", v_base);
    add_over(L"OutpostIAP", L"Endpoint", v_base);
    add_over(L"OutpostStorefront", L"Endpoint", v_base);
    add_over(L"OutpostLeaderboards", L"Endpoint", v_base);
    add_over(L"OutpostLogReceiver", L"Endpoint", v_base);
    add_over(L"OutpostStreams", L"EmbedEndpoint", v_base);
    add_over(L"OutpostStreamClient", L"StreamEndpoint", v_host);
    add_over(L"OutpostStreamClient", L"StreamPort", v_port);
    add_over(L"OutpostStreamClient", L"StreamSSL", L"False");
    add_over(L"OutpostStreamClient", L"StreamPath", L"/ws/stream");
    add_over(L"OutpostMatchmakingClient", L"MatchmakingSSL", L"False");
    add_over(L"OutpostMatchmakingClient", L"MatchmakingPort", v_port);
    add_over(L"OutpostMatchmakingClient", L"MatchmakingEndpoint", v_host);
    add_over(L"OutpostMatchmakingClient", L"MatchmakingApi", v_api);
}

static int set_fstring(FString *out, const wchar_t *val)
{
    size_t len = wcslen(val);
    wchar_t *p = ((MallocFn)AT(RVA_MEM_MALLOC))((len + 1) * sizeof(wchar_t), 0);
    if (!p) return 0;
    memcpy(p, val, (len + 1) * sizeof(wchar_t));
    if (out->data) ((FreeFn)AT(RVA_MEM_FREE))(out->data);
    out->data = p;
    out->num = (int32_t)len + 1;
    out->max = (int32_t)len + 1;
    return 1;
}

static uint8_t h_getstring(void *cfgc, const wchar_t *section, const wchar_t *key,
                           FString *out, const FString *filename)
{
    if (section && key && out && section[0] == L'O' && section[1] == L'u') {
        for (int i = 0; i < g_nover; i++) {
            if (_wcsicmp(section, g_over[i].section) != 0 || _wcsicmp(key, g_over[i].key) != 0) continue;
            if (set_fstring(out, g_over[i].value)) {
                if (!g_over[i].logged) {
                    g_over[i].logged = 1;
                    slog("config override [%ls] %ls = %ls", section, key, g_over[i].value);
                }
                return 1;
            }
            break;
        }
    }
    return o_getstring(cfgc, section, key, out, filename);
}

/* ------------------------------------------------------------------------ */
/* Shared UI state                                                           */
/* ------------------------------------------------------------------------ */

#define MAX_SERVERS 32

typedef struct {
    char id[80];
    wchar_t name[72];
    wchar_t region[24];
    char state[24];
    char address[80];
    char backend[80];
    int online, players, min_players, max_players, votes, late_join;
    double countdown_ms;         /* epoch ms, 0 = none */
} Server;

#define MAX_ACCTS 200
typedef struct {
    char id[68];
    wchar_t name[64];
} RepAcct;

enum { HIT_NONE = 0, HIT_BTN, HIT_REFRESH, HIT_VOTE, HIT_CLOSE, HIT_PANEL,
       HIT_REPORT, HIT_REASON, HIT_PASTE, HIT_SEND, HIT_ROW = 100 };

static const char *const k_rep_reason[4] = { "cheating", "harassment", "griefing", "other" };
static const wchar_t *const k_rep_reason_w[4] = { L"cheating", L"harassment", L"griefing", L"other" };

static CRITICAL_SECTION g_ui_lock;
static struct {
    int open, in_menu, dirty;
    int hover;
    int scroll;
    int count;
    Server srv[MAX_SERVERS];
    char sel_id[80];
    wchar_t status[200];
    int mx, my;                  /* mouse in backbuffer pixels */
    int bbw, bbh;
    int job_refresh, job_join, job_vote;
    Server join_srv;
    int loaded;
    int hwnd_ok;
    /* report view */
    int report;                  /* 1 = the panel body shows the report view */
    int rscroll, rcount, rreason;
    RepAcct racc[MAX_ACCTS];
    char rsel[80];               /* selected account id */
    char rlink[1700];            /* clip link, UTF-8, "" = none */
    wchar_t rlink_w[512];
    int job_accounts, job_paste, job_send;
} U;

static CRITICAL_SECTION g_tok_lock;
static char g_token[2100];

static void ui_set_status(const wchar_t *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    EnterCriticalSection(&g_ui_lock);
    _vsnwprintf(U.status, 199, fmt, ap);
    U.status[199] = 0;
    U.dirty = 1;
    LeaveCriticalSection(&g_ui_lock);
    va_end(ap);
}

/* ------------------------------------------------------------------------ */
/* Auth token capture (WinInet IAT hooks)                                    */
/* ------------------------------------------------------------------------ */

typedef BOOL (WINAPI *HttpSendRequestWFn)(HINTERNET, LPCWSTR, DWORD, LPVOID, DWORD);
typedef BOOL (WINAPI *HttpAddRequestHeadersWFn)(HINTERNET, LPCWSTR, DWORD, DWORD);
typedef HINTERNET (WINAPI *HttpOpenRequestWFn)(HINTERNET, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR *, DWORD, DWORD_PTR);
typedef BOOL (WINAPI *InternetReadFileFn)(HINTERNET, LPVOID, DWORD, LPDWORD);
static HttpSendRequestWFn o_send;
static HttpAddRequestHeadersWFn o_addhdr;
static HttpOpenRequestWFn o_openreq;
static InternetReadFileFn o_readfile;

static void set_token(const char *tok, size_t t, const char *how)
{
    EnterCriticalSection(&g_tok_lock);
    int changed = strcmp(g_token, tok) != 0;
    int first = g_token[0] == 0;
    if (changed) memcpy(g_token, tok, t + 1);
    LeaveCriticalSection(&g_tok_lock);
    if (changed) {
        slog("auth token %s from %s (length %u)", first ? "captured" : "refreshed", how, (unsigned)t);
        EnterCriticalSection(&g_ui_lock);
        U.dirty = 1;
        LeaveCriticalSection(&g_ui_lock);
    }
}

/* Matchmaking WebSocket connect wrapper (0x140E17F90): bool (ws, host, port, path, extra, ssl).
   The game passes its access token in `extra` (the WS handshake carries "Authorization: Token <jwt>"),
   so the JWT is taken from there. The game's REST calls go through libcurl, not WinInet. */
#define RVA_WS_CONNECT 0x0E17F90
typedef uint8_t (*WsConnectFn)(void *ws, const char *host, uint16_t port, const char *path, const char *extra, int ssl);
static WsConnectFn o_ws_connect;
static uint8_t h_ws_connect(void *ws, const char *host, uint16_t port, const char *path, const char *extra, int ssl)
{
    static int logged;
    if (extra && (uintptr_t)extra > 0x10000) {
        size_t n = strnlen(extra, 4096);
        const char *j = strstr(extra, "eyJ");
        if (logged < 3) {
            logged++;
            slog("ws connect %s:%u%s extra length %u, %s", host ? host : "?", (unsigned)port, path ? path : "",
                 (unsigned)n, j ? "has a JWT" : "no JWT");
        }
        if (j) {
            size_t t = 0;
            while (t < 2099 && (isalnum((unsigned char)j[t]) || j[t] == '-' || j[t] == '_' || j[t] == '.')) t++;
            if (t > 20) {
                char tok[2100];
                memcpy(tok, j, t);
                tok[t] = 0;
                set_token(tok, t, "matchmaking connect");
            }
        }
    }
    return o_ws_connect(ws, host, port, path, extra, ssl);
}

/* One-time diagnostics: header names only, never values. */
static void log_header_names(const wchar_t *h, size_t n, DWORD hlen)
{
    char out[400];
    size_t o = 0;
    int names = 0;
    size_t i = 0;
    while (i < n && names < 16 && o < sizeof out - 48) {
        size_t j = i;
        while (j < n && h[j] != L':' && h[j] != L'\r' && h[j] != L'\n' && j - i < 40) j++;
        if (j < n && h[j] == L':') {
            if (o) out[o++] = ',';
            for (size_t k = i; k < j && o < sizeof out - 4; k++) out[o++] = h[k] < 128 ? (char)h[k] : '?';
            names++;
        }
        while (j < n && h[j] != L'\n') j++;
        i = j + 1;
    }
    out[o] = 0;
    slog("send #dbg: hlen=%lu headers=[%s]", (unsigned long)hlen, out);
}

static void scan_headers(const wchar_t *h, DWORD len)
{
    if (!h) return;
    size_t n;
    if (len == (DWORD)-1) {
        n = 0;
        while (n < 16384 && h[n]) n++;
    } else {
        n = len > 16384 ? 16384 : len;
    }
    static volatile LONG dbg;
    if (InterlockedIncrement(&dbg) <= 3) log_header_names(h, n, len);
    static const wchar_t key[] = L"authorization:";
    const size_t kl = 14;
    for (size_t i = 0; i + kl < n; i++) {
        if (i && h[i - 1] != L'\n' && h[i - 1] != L'\r') continue;
        size_t k = 0;
        while (k < kl && towlower(h[i + k]) == key[k]) k++;
        if (k != kl) continue;
        size_t p = i + kl;
        while (p < n && (h[p] == L' ' || h[p] == L'\t')) p++;
        size_t sl;
        if (p + 6 <= n && !_wcsnicmp(h + p, L"Token ", 6)) sl = 6;
        else if (p + 7 <= n && !_wcsnicmp(h + p, L"Bearer ", 7)) sl = 7;
        else return;
        p += sl;
        char tok[2100];
        size_t t = 0;
        while (p < n && h[p] && h[p] != L'\r' && h[p] != L'\n' && t < sizeof tok - 1) {
            if (h[p] > 126 || h[p] < 33) { t = 0; break; }
            tok[t++] = (char)h[p++];
        }
        tok[t] = 0;
        if (t < 8) return;
        set_token(tok, t, "request header");
        return;
    }
}

static BOOL WINAPI h_send(HINTERNET h, LPCWSTR hdr, DWORD hlen, LPVOID opt, DWORD olen)
{
    static volatile LONG calls;
    if (InterlockedIncrement(&calls) == 1) slog("h_send reached (first HttpSendRequestW call)");
    if (hdr && hlen) scan_headers(hdr, hlen);
    return o_send(h, hdr, hlen, opt, olen);
}

static BOOL WINAPI h_addhdr(HINTERNET h, LPCWSTR hdr, DWORD hlen, DWORD mod)
{
    if (hdr && hlen) scan_headers(hdr, hlen);
    return o_addhdr(h, hdr, hlen, mod);
}

/* Fallback: the login response body carries "access-token":"<jwt>". The request
   is recognised by its object name in HttpOpenRequestW. */
#define TRK_N 4
#define TRK_CAP 8192
static struct { HINTERNET h; size_t n; char buf[TRK_CAP]; } g_trk[TRK_N];
static int g_trk_next;
static CRITICAL_SECTION g_trk_lock;

static HINTERNET WINAPI h_openreq(HINTERNET con, LPCWSTR verb, LPCWSTR obj, LPCWSTR ver, LPCWSTR ref,
                                  LPCWSTR *acc, DWORD flags, DWORD_PTR ctx)
{
    HINTERNET r = o_openreq(con, verb, obj, ver, ref, acc, flags, ctx);
    if (r && obj && wcsstr(obj, L"access-token")) {
        EnterCriticalSection(&g_trk_lock);
        int i = g_trk_next++ % TRK_N;
        g_trk[i].h = r;
        g_trk[i].n = 0;
        LeaveCriticalSection(&g_trk_lock);
        static volatile LONG once;
        if (InterlockedIncrement(&once) <= 2) slog("tracking login request handle (response body fallback)");
    }
    return r;
}

static void trk_parse(const char *b, size_t n)
{
    static const char pat[] = "\"access-token\"";
    for (size_t i = 0; i + sizeof pat < n; i++) {
        if (memcmp(b + i, pat, sizeof pat - 1) != 0) continue;
        size_t p = i + sizeof pat - 1;
        while (p < n && (b[p] == ' ' || b[p] == '\t' || b[p] == '\r' || b[p] == '\n')) p++;
        if (p >= n || b[p] != ':') return;
        p++;
        while (p < n && (b[p] == ' ' || b[p] == '\t' || b[p] == '\r' || b[p] == '\n')) p++;
        if (p >= n || b[p] != '"') return;
        p++;
        char tok[2100];
        size_t t = 0;
        while (p < n && b[p] != '"' && t < sizeof tok - 1) tok[t++] = b[p++];
        if (p >= n || t < 8) return;           /* token not complete yet */
        tok[t] = 0;
        set_token(tok, t, "login response");
        return;
    }
}

static BOOL WINAPI h_readfile(HINTERNET h, LPVOID buf, DWORD want, LPDWORD got)
{
    BOOL ok = o_readfile(h, buf, want, got);
    if (ok && got && *got && buf) {
        EnterCriticalSection(&g_trk_lock);
        for (int i = 0; i < TRK_N; i++) {
            if (g_trk[i].h != h) continue;
            size_t add = *got;
            if (g_trk[i].n + add > TRK_CAP) add = TRK_CAP - g_trk[i].n;
            memcpy(g_trk[i].buf + g_trk[i].n, buf, add);
            g_trk[i].n += add;
            trk_parse(g_trk[i].buf, g_trk[i].n);
            break;
        }
        LeaveCriticalSection(&g_trk_lock);
    }
    (void)want;
    return ok;
}

/* ------------------------------------------------------------------------ */
/* UE_LOG hook: current map                                                  */
/* ------------------------------------------------------------------------ */

void *g_log_tramp;                     /* referenced from log_hook */
static HANDLE g_game_log = INVALID_HANDLE_VALUE;
static CRITICAL_SECTION g_game_lock;
typedef FString *(*FNameToStringFn)(const FName *, FString *);

static void map_loaded(const wchar_t *url)
{
    wchar_t m[260];
    size_t i = 0;
    if (!url || (uintptr_t)url < 0x10000) return;
    while (i < 255 && url[i]) { m[i] = url[i]; i++; }
    m[i] = 0;
    int menu = wcsstr(m, L"MainMenu") != NULL;
    EnterCriticalSection(&g_ui_lock);
    int was = U.in_menu;
    U.in_menu = menu;
    if (!menu && !cfg.show_everywhere) U.open = 0;
    U.dirty = 1;
    LeaveCriticalSection(&g_ui_lock);
    InterlockedIncrement(&g_map_gen);
    slog("LoadMap: %ls (main menu: %d%s)", m, menu, was != menu ? ", changed" : "");
}

void log_capture(uint64_t *frame)
{
    /* frame[0] = return address, frame[1..4] = homed rcx rdx r8 r9,
       frame[5] = format, frame[6..] = variadic arguments.
       Logf_Internal(File, Line, Category, Verbosity, Fmt, ...) */
    const wchar_t *fmt = (const wchar_t *)frame[5];
    if (!fmt) return;
    DWORD saved_error = GetLastError();
    if (fmt[0] == L'L' && wcscmp(fmt, L"LoadMap: %s") == 0)
        map_loaded((const wchar_t *)frame[6]);

    if (g_game_log != INVALID_HANDLE_VALUE) {
        static const char *const verb_names[] = {
            "", "Fatal", "Error", "Warning", "Display", "Log", "Verbose", "VeryVerbose" };
        const FName *category = (const FName *)frame[3];
        unsigned verbosity = (unsigned)frame[4] & 0xF;
        wchar_t msg[2048];
        int n = _vsnwprintf(msg, 2047, fmt, (va_list)(frame + 6));
        if (n < 0) n = 2047;
        msg[n] = 0;
        wchar_t cat[64] = L"?";
        if (category) {
            FString fs = { 0 };
            ((FNameToStringFn)AT(RVA_FNAME_TOSTR))(category, &fs);
            if (fs.data) {
                wcsncpy(cat, fs.data, 63);
                cat[63] = 0;
                ((FreeFn)AT(RVA_MEM_FREE))(fs.data);
            }
        }
        SYSTEMTIME t;
        GetLocalTime(&t);
        char line[4096];
        const char *verb = (verbosity < 8 && verbosity != 5) ? verb_names[verbosity] : "";
        int len = snprintf(line, sizeof line - 2, "[%02d:%02d:%02d.%03d] %ls: %s%s%ls",
                           t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, cat,
                           verb, verb[0] ? ": " : "", msg);
        if (len < 0 || len > (int)sizeof line - 2) len = sizeof line - 2;
        line[len++] = 13;
        line[len++] = 10;
        EnterCriticalSection(&g_game_lock);
        DWORD w;
        WriteFile(g_game_log, line, (DWORD)len, &w, NULL);
        LeaveCriticalSection(&g_game_lock);
    }
    SetLastError(saved_error);
}

void log_hook(void);
__asm__(
    ".text\n"
    ".globl log_hook\n"
    "log_hook:\n"
    "  movq %rcx, 8(%rsp)\n"
    "  movq %rdx, 16(%rsp)\n"
    "  movq %r8, 24(%rsp)\n"
    "  movq %r9, 32(%rsp)\n"
    "  subq $40, %rsp\n"
    "  leaq 40(%rsp), %rcx\n"
    "  call log_capture\n"
    "  addq $40, %rsp\n"
    "  movq 8(%rsp), %rcx\n"
    "  movq 16(%rsp), %rdx\n"
    "  movq 24(%rsp), %r8\n"
    "  movq 32(%rsp), %r9\n"
    "  jmp *g_log_tramp(%rip)\n");

/* ------------------------------------------------------------------------ */
/* Tolerant JSON parser                                                      */
/* ------------------------------------------------------------------------ */

typedef struct JV {
    char t;                      /* 'o' 'a' 's' 'n' 'b' 'z'(null) */
    char *s;                     /* string value */
    char *key;                   /* member name */
    double n;                    /* number, or 0/1 for bool */
    struct JV *kid, *next;
} JV;

static void jfree(JV *v)
{
    while (v) {
        JV *nx = v->next;
        jfree(v->kid);
        free(v->s);
        free(v->key);
        free(v);
        v = nx;
    }
}

static void jws(const char **p, const char *e)
{
    while (*p < e && (**p == ' ' || **p == '\t' || **p == '\r' || **p == '\n')) (*p)++;
}

static int put_utf8(char *o, unsigned cp)
{
    if (cp < 0x80) { o[0] = (char)cp; return 1; }
    if (cp < 0x800) { o[0] = (char)(0xC0 | (cp >> 6)); o[1] = (char)(0x80 | (cp & 63)); return 2; }
    if (cp < 0x10000) {
        o[0] = (char)(0xE0 | (cp >> 12)); o[1] = (char)(0x80 | ((cp >> 6) & 63));
        o[2] = (char)(0x80 | (cp & 63)); return 3;
    }
    o[0] = (char)(0xF0 | (cp >> 18)); o[1] = (char)(0x80 | ((cp >> 12) & 63));
    o[2] = (char)(0x80 | ((cp >> 6) & 63)); o[3] = (char)(0x80 | (cp & 63)); return 4;
}

static int hex4(const char *p, const char *e, unsigned *out)
{
    if (e - p < 4) return 0;
    unsigned v = 0;
    for (int i = 0; i < 4; i++) {
        char c = p[i];
        v <<= 4;
        if (c >= '0' && c <= '9') v |= c - '0';
        else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
        else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
        else return 0;
    }
    *out = v;
    return 1;
}

static char *jstring(const char **pp, const char *e)
{
    const char *p = *pp + 1;                 /* past the opening quote */
    char *o = malloc((size_t)(e - p) + 8);
    if (!o) return NULL;
    size_t n = 0;
    while (p < e && *p != '"') {
        if (*p != '\\') { o[n++] = *p++; continue; }
        p++;
        if (p >= e) break;
        char c = *p++;
        switch (c) {
        case 'n': o[n++] = '\n'; break;
        case 't': o[n++] = '\t'; break;
        case 'r': o[n++] = '\r'; break;
        case 'b': o[n++] = '\b'; break;
        case 'f': o[n++] = '\f'; break;
        case 'u': {
            unsigned cp;
            if (!hex4(p, e, &cp)) { free(o); return NULL; }
            p += 4;
            if (cp >= 0xD800 && cp < 0xDC00 && e - p >= 6 && p[0] == '\\' && p[1] == 'u') {
                unsigned lo;
                if (hex4(p + 2, e, &lo) && lo >= 0xDC00 && lo < 0xE000) {
                    cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    p += 6;
                }
            }
            n += (size_t)put_utf8(o + n, cp);
            break;
        }
        default: o[n++] = c; break;          /* \" \\ \/ and anything else */
        }
    }
    if (p >= e) { free(o); return NULL; }
    o[n] = 0;
    *pp = p + 1;
    return o;
}

static JV *jvalue(const char **p, const char *e, int depth)
{
    if (depth > 16) return NULL;
    jws(p, e);
    if (*p >= e) return NULL;
    JV *v = calloc(1, sizeof *v);
    if (!v) return NULL;
    char c = **p;
    if (c == '{' || c == '[') {
        char close = c == '{' ? '}' : ']';
        v->t = c == '{' ? 'o' : 'a';
        (*p)++;
        JV **tail = &v->kid;
        jws(p, e);
        if (*p < e && **p == close) { (*p)++; return v; }
        for (;;) {
            jws(p, e);
            char *key = NULL;
            if (v->t == 'o') {
                if (*p >= e || **p != '"') goto fail;
                key = jstring(p, e);
                if (!key) goto fail;
                jws(p, e);
                if (*p >= e || **p != ':') { free(key); goto fail; }
                (*p)++;
            }
            JV *k = jvalue(p, e, depth + 1);
            if (!k) { free(key); goto fail; }
            k->key = key;
            *tail = k;
            tail = &k->next;
            jws(p, e);
            if (*p < e && **p == ',') { (*p)++; continue; }
            if (*p < e && **p == close) { (*p)++; return v; }
            goto fail;
        }
    }
    if (c == '"') {
        v->t = 's';
        v->s = jstring(p, e);
        if (!v->s) goto fail;
        return v;
    }
    if (e - *p >= 4 && !strncmp(*p, "true", 4)) { v->t = 'b'; v->n = 1; *p += 4; return v; }
    if (e - *p >= 5 && !strncmp(*p, "false", 5)) { v->t = 'b'; v->n = 0; *p += 5; return v; }
    if (e - *p >= 4 && !strncmp(*p, "null", 4)) { v->t = 'z'; *p += 4; return v; }
    if (c == '-' || (c >= '0' && c <= '9')) {
        char buf[48];
        size_t n = 0;
        while (*p < e && n < sizeof buf - 1 &&
               (strchr("+-.eE", **p) || (**p >= '0' && **p <= '9')))
            buf[n++] = *(*p)++;
        buf[n] = 0;
        v->t = 'n';
        v->n = atof(buf);
        return v;
    }
fail:
    jfree(v);
    return NULL;
}

static JV *jparse(const char *s, size_t n)
{
    const char *p = s;
    return jvalue(&p, s + n, 0);
}

static JV *jget(const JV *o, const char *key)
{
    if (!o || o->t != 'o') return NULL;
    for (JV *k = o->kid; k; k = k->next)
        if (k->key && strcmp(k->key, key) == 0) return k;
    return NULL;
}

static const char *jstr(const JV *o, const char *key, const char *def)
{
    JV *k = jget(o, key);
    return (k && k->t == 's' && k->s) ? k->s : def;
}

static double jnum(const JV *o, const char *key, double def)
{
    JV *k = jget(o, key);
    return (k && (k->t == 'n' || k->t == 'b')) ? k->n : def;
}

/* ------------------------------------------------------------------------ */
/* WinHTTP worker                                                            */
/* ------------------------------------------------------------------------ */

static HINTERNET g_wh_session;
static HANDLE g_worker_ev;
static volatile LONG g_worker_started;
static char g_self_ips[16][48];            /* "a.b.c.d:port" for our backend host */
static int g_self_ip_n;
static int g_self_resolved;

static void resolve_self(void)
{
    if (g_self_resolved) return;
    g_self_resolved = 1;
    WSADATA wd;
    if (WSAStartup(MAKEWORD(2, 2), &wd) != 0) return;
    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(g_host_a, NULL, &hints, &res) == 0) {
        for (struct addrinfo *a = res; a && g_self_ip_n < 16; a = a->ai_next) {
            struct sockaddr_in *sin = (struct sockaddr_in *)a->ai_addr;
            unsigned char *b = (unsigned char *)&sin->sin_addr;
            snprintf(g_self_ips[g_self_ip_n++], 48, "%u.%u.%u.%u:%d", b[0], b[1], b[2], b[3], g_port);
        }
        freeaddrinfo(res);
    }
    slog("backend %ls resolves to %d IPv4 address(es)", g_backend_w, g_self_ip_n);
    WSACleanup();
}

static int same_backend(const char *b)
{
    if (!b || !b[0] || !_stricmp(b, "null")) return 1;
    char t[96];
    const char *p = b;
    if (!_strnicmp(p, "http://", 7)) p += 7;
    snprintf(t, sizeof t, "%s", p);
    size_t l = strlen(t);
    while (l && t[l - 1] == '/') t[--l] = 0;
    char self[240];
    snprintf(self, sizeof self, "%s:%d", g_host_a, g_port);
    if (!_stricmp(t, self)) return 1;
    resolve_self();
    for (int i = 0; i < g_self_ip_n; i++)
        if (!_stricmp(t, g_self_ips[i])) return 1;
    return 0;
}

/* Returns the HTTP status, or -1 on a transport failure. *resp is malloc'd
   (NUL-terminated, may be NULL when -1). */
static int http_do(const wchar_t *method, const wchar_t *path, const wchar_t *extra_headers,
                   const char *body, char **resp, size_t *resp_len)
{
    int status = -1;
    HINTERNET con = NULL, req = NULL;
    *resp = NULL;
    *resp_len = 0;
    if (!g_wh_session) return -1;
    con = WinHttpConnect(g_wh_session, g_host_w, (INTERNET_PORT)g_port, 0);
    if (!con) goto done;
    req = WinHttpOpenRequest(con, method, path, NULL, WINHTTP_NO_REFERER,
                             WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    if (!req) goto done;
    DWORD blen = body ? (DWORD)strlen(body) : 0;
    if (!WinHttpSendRequest(req, extra_headers ? extra_headers : WINHTTP_NO_ADDITIONAL_HEADERS,
                            extra_headers ? (DWORD)-1 : 0, (LPVOID)body, blen, blen, 0)) goto done;
    if (!WinHttpReceiveResponse(req, NULL)) goto done;
    DWORD code = 0, sz = sizeof code;
    if (!WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, &code, &sz, WINHTTP_NO_HEADER_INDEX)) goto done;
    status = (int)code;
    size_t cap = 8192, len = 0;
    char *buf = malloc(cap);
    if (!buf) goto done;
    for (;;) {
        DWORD avail = 0, got = 0;
        if (!WinHttpQueryDataAvailable(req, &avail) || avail == 0) break;
        if (len + avail + 1 > cap) {
            if (cap >= (2u << 20)) break;
            while (len + avail + 1 > cap) cap *= 2;
            char *nb = realloc(buf, cap);
            if (!nb) break;
            buf = nb;
        }
        if (!WinHttpReadData(req, buf + len, avail, &got) || got == 0) break;
        len += got;
    }
    buf[len] = 0;
    *resp = buf;
    *resp_len = len;
done:
    if (req) WinHttpCloseHandle(req);
    if (con) WinHttpCloseHandle(con);
    return status;
}

static double now_epoch_ms(void)
{
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    uint64_t t = ((uint64_t)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    return (double)(t - 116444736000000000ULL) / 10000.0;
}

static void u8w(const char *s, wchar_t *out, int cap)
{
    if (MultiByteToWideChar(CP_UTF8, 0, s, -1, out, cap) == 0) {
        out[0] = 0;
        MultiByteToWideChar(CP_ACP, 0, s, -1, out, cap);
    }
    out[cap - 1] = 0;
}

static void do_poll(void)
{
    char *resp;
    size_t len;
    int st = http_do(L"GET", L"/servers", NULL, NULL, &resp, &len);
    if (st != 200 || !resp) {
        free(resp);
        EnterCriticalSection(&g_ui_lock);
        U.loaded = 0;
        if (!U.status[0] || !wcscmp(U.status, L"Loading...") || !wcsncmp(U.status, L"Backend", 7) ||
            !wcsncmp(U.status, L"Pick", 4) || !wcsncmp(U.status, L"No servers", 10))
            _snwprintf(U.status, 199, st < 0 ? L"Backend unreachable" : L"Backend error (HTTP %d)", st);
        U.dirty = 1;
        LeaveCriticalSection(&g_ui_lock);
        return;
    }
    JV *root = jparse(resp, len);
    free(resp);
    JV *arr = jget(root, "servers");
    if (!arr || arr->t != 'a') {
        jfree(root);
        ui_set_status(L"Backend sent an unexpected reply");
        return;
    }
    static Server tmp[MAX_SERVERS];
    int n = 0;
    for (JV *s = arr->kid; s && n < MAX_SERVERS; s = s->next) {
        if (s->t != 'o') continue;
        if (strcmp(jstr(s, "game", "classic"), "classic") != 0) continue;
        Server *o = &tmp[n];
        memset(o, 0, sizeof *o);
        snprintf(o->id, sizeof o->id, "%s", jstr(s, "id", ""));
        if (!o->id[0]) continue;
        u8w(jstr(s, "name", "?"), o->name, 72);
        u8w(jstr(s, "region", ""), o->region, 24);
        snprintf(o->state, sizeof o->state, "%s", jstr(s, "state", "waiting"));
        snprintf(o->address, sizeof o->address, "%s", jstr(s, "address", ""));
        snprintf(o->backend, sizeof o->backend, "%s", jstr(s, "backend", ""));
        o->online = (int)jnum(s, "online", 0);
        o->players = (int)jnum(s, "players", 0);
        o->min_players = (int)jnum(s, "minPlayers", 0);
        o->max_players = (int)jnum(s, "maxPlayers", 0);
        o->votes = (int)jnum(s, "votes", 0);
        o->late_join = (int)jnum(s, "lateJoinOpen", 1);
        o->countdown_ms = jnum(s, "countdownEndsAt", 0);
        n++;
    }
    jfree(root);
    EnterCriticalSection(&g_ui_lock);
    memcpy(U.srv, tmp, sizeof(Server) * (size_t)n);
    U.count = n;
    U.loaded = 1;
    if (U.scroll > n) U.scroll = n > 0 ? n - 1 : 0;
    if (!U.status[0] || !wcscmp(U.status, L"Loading...") || !wcsncmp(U.status, L"Backend", 7) ||
        !wcsncmp(U.status, L"No servers", 10))
        wcscpy(U.status, n ? L"Pick a server to join." : L"No servers found.");
    U.dirty = 1;
    LeaveCriticalSection(&g_ui_lock);
}

static void trigger_play(void);

static void do_join(const Server *s)
{
    if (!same_backend(s->backend)) {
        wchar_t wb[96];
        u8w(s->backend, wb, 96);
        if (WritePrivateProfileStringW(L"Client", L"Backend", wb, g_ini)) {
            slog("saved backend %ls to the ini (entry %s)", wb, s->id);
            ui_set_status(L"Saved %ls as your server. Restart the game to switch.", wb);
        } else {
            ui_set_status(L"Could not write sos_client.ini");
        }
        return;
    }
    char tok[2100];
    EnterCriticalSection(&g_tok_lock);
    memcpy(tok, g_token, sizeof tok);
    LeaveCriticalSection(&g_tok_lock);

    int select = 1;
    if (!tok[0]) {
        ui_set_status(L"Selected %ls. Press PLAY (the server picks the lobby).", s->name);
    } else {
        wchar_t path[200], hdr[2300];
        wchar_t idw[100];
        u8w(s->id, idw, 100);
        _snwprintf(path, 199, L"/api/servers/%ls/join-hint", idw);
        path[199] = 0;
        wchar_t tokw[2100];
        u8w(tok, tokw, 2100);
        _snwprintf(hdr, 2299, L"Content-Type: application/json\r\nAuthorization: Token %ls\r\n", tokw);
        hdr[2299] = 0;
        char *resp;
        size_t rl;
        int st = http_do(L"POST", path, hdr, "{}", &resp, &rl);
        SecureZeroMemory(hdr, sizeof hdr);
        SecureZeroMemory(tokw, sizeof tokw);
        slog("join-hint %s -> HTTP %d", s->id, st);
        if (st == 200) {
            ui_set_status(L"Selected %ls. Press PLAY to join.", s->name);
        } else if (st == 409) {
            JV *j = resp ? jparse(resp, rl) : NULL;
            const char *e = jstr(j, "error", "");
            if (!strcmp(e, "offline")) ui_set_status(L"%ls is offline.", s->name);
            else ui_set_status(L"%ls is closed to new players.", s->name);
            jfree(j);
            select = 0;
        } else if (st < 0) {
            ui_set_status(L"Backend unreachable");
            select = 0;
        } else {
            ui_set_status(L"Selected %ls. Press PLAY (the server picks the lobby).", s->name);
        }
        free(resp);
    }
    if (select) {
        EnterCriticalSection(&g_ui_lock);
        snprintf(U.sel_id, sizeof U.sel_id, "%s", s->id);
        U.dirty = 1;
        LeaveCriticalSection(&g_ui_lock);
        trigger_play();
    }
}

static void do_vote(void)
{
    char id[80], tok[2100];
    EnterCriticalSection(&g_ui_lock);
    snprintf(id, sizeof id, "%s", U.sel_id);
    LeaveCriticalSection(&g_ui_lock);
    EnterCriticalSection(&g_tok_lock);
    memcpy(tok, g_token, sizeof tok);
    LeaveCriticalSection(&g_tok_lock);
    if (!id[0] || !tok[0]) { ui_set_status(L"Vote needs a selected server and a signed-in game"); return; }
    wchar_t path[200], hdr[2300], idw[100], tokw[2100];
    u8w(id, idw, 100);
    u8w(tok, tokw, 2100);
    _snwprintf(path, 199, L"/api/session/%ls/vote-start", idw);
    path[199] = 0;
    _snwprintf(hdr, 2299, L"Content-Type: application/json\r\nAuthorization: Token %ls\r\n", tokw);
    hdr[2299] = 0;
    char *resp;
    size_t rl;
    int st = http_do(L"POST", path, hdr, "{}", &resp, &rl);
    SecureZeroMemory(hdr, sizeof hdr);
    SecureZeroMemory(tokw, sizeof tokw);
    slog("vote-start %s -> HTTP %d", id, st);
    if (st == 200) {
        JV *j = resp ? jparse(resp, rl) : NULL;
        int votes = (int)jnum(j, "votes", -1);
        jfree(j);
        if (votes >= 0) ui_set_status(L"Vote counted (votes %d)", votes);
        else ui_set_status(L"Vote counted");
    } else if (st == 403) ui_set_status(L"Not in this lobby yet");
    else if (st == 409) ui_set_status(L"Voting is not possible right now");
    else if (st == 401) ui_set_status(L"Not signed in yet");
    else if (st < 0) ui_set_status(L"Backend unreachable");
    else ui_set_status(L"Vote failed (HTTP %d)", st);
    free(resp);
    EnterCriticalSection(&g_ui_lock);
    U.job_refresh = 1;
    LeaveCriticalSection(&g_ui_lock);
}

/* ---- report a player ---- */

static int valid_acct_id(const char *s)
{
    size_t n = strlen(s);
    if (n < 1 || n > 64) return 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_' || c == '.' || c == '-'))
            return 0;
    }
    return 1;
}

typedef struct { RepAcct a; char seen[40]; } AcctTmp;

static int acct_cmp(const void *pa, const void *pb)
{
    const AcctTmp *a = pa, *b = pb;
    int c = strcmp(b->seen, a->seen);          /* most recently seen first */
    return c ? c : _wcsicmp(a->a.name, b->a.name);
}

static void do_accounts(void)
{
    char *resp;
    size_t len;
    int st = http_do(L"GET", L"/api/search/account", NULL, NULL, &resp, &len);
    slog("search/account -> HTTP %d", st);
    if (st != 200 || !resp) {
        free(resp);
        ui_set_status(st < 0 ? L"Backend unreachable" : L"Could not load players (HTTP %d)", st);
        return;
    }
    JV *root = jparse(resp, len);
    free(resp);
    JV *arr = jget(root, "data");
    if (!arr || arr->t != 'a') {
        jfree(root);
        ui_set_status(L"Backend sent an unexpected reply");
        return;
    }
    size_t cap = 64, n = 0;
    AcctTmp *tmp = malloc(cap * sizeof *tmp);
    for (JV *o = arr->kid; o && tmp; o = o->next) {
        if (o->t != 'o') continue;
        const char *id = jstr(o, "account-id", "");
        if (!id[0]) id = jstr(o, "id", "");
        if (!valid_acct_id(id)) continue;
        if (n >= 4000) break;
        if (n == cap) {
            AcctTmp *nt = realloc(tmp, cap * 2 * sizeof *tmp);
            if (!nt) break;
            tmp = nt;
            cap *= 2;
        }
        AcctTmp *t = &tmp[n++];
        memset(t, 0, sizeof *t);
        snprintf(t->a.id, sizeof t->a.id, "%s", id);
        const char *nm = jstr(o, "display-name", "");
        if (!nm[0]) nm = jstr(o, "alias", "");
        if (!nm[0]) nm = id;
        u8w(nm, t->a.name, 64);
        const char *seen = jstr(o, "last-access", "");
        if (!seen[0]) seen = jstr(o, "created", "");
        snprintf(t->seen, sizeof t->seen, "%s", seen);
    }
    jfree(root);
    if (!tmp) { ui_set_status(L"Out of memory"); return; }
    qsort(tmp, n, sizeof *tmp, acct_cmp);
    if (n > MAX_ACCTS) n = MAX_ACCTS;
    EnterCriticalSection(&g_ui_lock);
    for (size_t i = 0; i < n; i++) U.racc[i] = tmp[i].a;
    U.rcount = (int)n;
    if (U.rscroll > U.rcount) U.rscroll = U.rcount > 0 ? U.rcount - 1 : 0;
    if (!U.status[0] || !wcsncmp(U.status, L"Loading players", 15) || !wcsncmp(U.status, L"Pick", 4))
        wcscpy(U.status, n ? L"Pick a player to report." : L"No players found.");
    U.dirty = 1;
    LeaveCriticalSection(&g_ui_lock);
    free(tmp);
}

/* UTF-16 clipboard text -> clip link. Accepts http:// or https:// text without any whitespace, at most 500
   characters. Returns 1 and fills out8 (UTF-8) and outw (display copy). */
static int clip_to_link(const wchar_t *in, char *out8, int cap8, wchar_t *outw, int capw)
{
    wchar_t tmp[2048];
    while (*in && *in <= 0x20) in++;
    size_t n = wcslen(in);
    if (n >= sizeof tmp / sizeof tmp[0]) return 0;
    memcpy(tmp, in, (n + 1) * sizeof(wchar_t));
    while (n && (tmp[n - 1] <= 0x20 || tmp[n - 1] == 0xFEFF)) tmp[--n] = 0;
    if (n < 9 || n > 500 || n >= (size_t)capw) return 0;
    size_t pl = !_wcsnicmp(tmp, L"https://", 8) ? 8 : !_wcsnicmp(tmp, L"http://", 7) ? 7 : 0;
    if (!pl || n <= pl) return 0;
    for (size_t i = 0; i < n; i++) {
        wchar_t c = tmp[i];
        if (c <= 0x20 || c == 0x7F || c == 0x85 || c == 0xA0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200B) ||
            c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF)
            return 0;
    }
    if (WideCharToMultiByte(CP_UTF8, 0, tmp, -1, out8, cap8, NULL, NULL) <= 0) return 0;
    memcpy(outw, tmp, (n + 1) * sizeof(wchar_t));
    return 1;
}

static int read_clipboard_w(wchar_t *out, int cap)
{
    int ok = 0;
    out[0] = 0;
    for (int i = 0; i < 5 && !ok; i++) {
        if (!OpenClipboard(NULL)) { Sleep(15); continue; }
        if (IsClipboardFormatAvailable(CF_UNICODETEXT)) {
            HANDLE h = GetClipboardData(CF_UNICODETEXT);
            if (h) {
                const wchar_t *p = GlobalLock(h);
                if (p) {
                    size_t room = (size_t)GlobalSize(h) / sizeof(wchar_t);
                    size_t k = 0;
                    while (k + 1 < (size_t)cap && k < room && p[k]) { out[k] = p[k]; k++; }
                    out[k] = 0;
                    GlobalUnlock(h);
                    ok = 1;
                }
            }
        }
        CloseClipboard();
        break;
    }
    return ok;
}

static void do_paste(void)
{
    static wchar_t w[2048];
    char u8[1700];
    wchar_t disp[512];
    if (!read_clipboard_w(w, 2048) || !clip_to_link(w, u8, sizeof u8, disp, 512)) {
        SecureZeroMemory(w, sizeof w);
        ui_set_status(L"Clipboard has no link");
        return;
    }
    SecureZeroMemory(w, sizeof w);
    EnterCriticalSection(&g_ui_lock);
    memcpy(U.rlink, u8, sizeof U.rlink < sizeof u8 ? sizeof U.rlink : sizeof u8);
    wcscpy(U.rlink_w, disp);
    wcscpy(U.status, L"Clip link pasted.");
    U.dirty = 1;
    LeaveCriticalSection(&g_ui_lock);
}

/* JSON string escape; returns the length written or -1 when it does not fit. */
static int json_esc(const char *in, char *out, int cap)
{
    int n = 0;
    for (; *in; in++) {
        unsigned char c = (unsigned char)*in;
        char tmp[8];
        int l;
        if (c == '"' || c == '\\') { tmp[0] = '\\'; tmp[1] = (char)c; l = 2; }
        else if (c < 0x20) l = snprintf(tmp, sizeof tmp, "\\u%04x", c);
        else { tmp[0] = (char)c; l = 1; }
        if (n + l + 1 > cap) return -1;
        memcpy(out + n, tmp, (size_t)l);
        n += l;
    }
    out[n] = 0;
    return n;
}

/* POST /api/reports. Sets the status line; returns the HTTP status (-1 transport failure, 0 not sent). */
static int send_report(const char *target, const char *reason, const char *link)
{
    char tok[2100];
    EnterCriticalSection(&g_tok_lock);
    memcpy(tok, g_token, sizeof tok);
    LeaveCriticalSection(&g_tok_lock);
    if (!tok[0]) { ui_set_status(L"Not signed in yet"); return 0; }
    char et[160], er[160], el[3400], body[3800];
    if (json_esc(target, et, sizeof et) < 0 || json_esc(reason, er, sizeof er) < 0 ||
        json_esc(link ? link : "", el, sizeof el) < 0) {
        SecureZeroMemory(tok, sizeof tok);
        ui_set_status(L"Report failed (bad input)");
        return 0;
    }
    if (link && link[0])
        snprintf(body, sizeof body, "{\"target\":\"%s\",\"reason\":\"%s\",\"text\":\"mod report\",\"evidenceUrl\":\"%s\"}", et, er, el);
    else
        snprintf(body, sizeof body, "{\"target\":\"%s\",\"reason\":\"%s\",\"text\":\"mod report\"}", et, er);
    wchar_t hdr[2300], tokw[2100];
    u8w(tok, tokw, 2100);
    SecureZeroMemory(tok, sizeof tok);
    _snwprintf(hdr, 2299, L"Content-Type: application/json\r\nAuthorization: Token %ls\r\n", tokw);
    hdr[2299] = 0;
    char *resp;
    size_t rl;
    int st = http_do(L"POST", L"/api/reports", hdr, body, &resp, &rl);
    SecureZeroMemory(hdr, sizeof hdr);
    SecureZeroMemory(tokw, sizeof tokw);
    slog("report %s (%s%s) -> HTTP %d", target, reason, link && link[0] ? ", with clip link" : "", st);
    JV *j = resp ? jparse(resp, rl) : NULL;
    if (st == 200) {
        const char *id = jstr(jget(j, "data"), "id", "");
        if (!id[0]) id = jstr(j, "id", "");
        if (id[0]) {
            wchar_t idw[48];
            u8w(id, idw, 48);
            ui_set_status(L"Report %ls sent", idw);
        } else {
            ui_set_status(L"Report sent");
        }
        EnterCriticalSection(&g_ui_lock);
        U.rlink[0] = 0;
        U.rlink_w[0] = 0;
        U.rsel[0] = 0;
        U.dirty = 1;
        LeaveCriticalSection(&g_ui_lock);
    } else if (st == 400 && !strcmp(jstr(j, "error", ""), "self-report")) ui_set_status(L"You cannot report yourself");
    else if (st == 400 && !strcmp(jstr(j, "error", ""), "bad-target")) ui_set_status(L"Unknown player");
    else if (st == 429) ui_set_status(L"Slow down: you reported this player recently");
    else if (st == 401) ui_set_status(L"Not signed in yet");
    else if (st < 0) ui_set_status(L"Backend unreachable");
    else ui_set_status(L"Report failed (HTTP %d)", st);
    jfree(j);
    free(resp);
    return st;
}

static void do_send(void)
{
    char target[80], link[1700];
    int ri;
    EnterCriticalSection(&g_ui_lock);
    snprintf(target, sizeof target, "%s", U.rsel);
    snprintf(link, sizeof link, "%s", U.rlink);
    ri = U.rreason;
    LeaveCriticalSection(&g_ui_lock);
    if (ri < 0 || ri > 3) ri = 0;
    if (!target[0]) { ui_set_status(L"Pick a player to report first"); return; }
    send_report(target, k_rep_reason[ri], link);
}

static DWORD WINAPI worker_main(LPVOID unused)
{
    (void)unused;
    g_wh_session = WinHttpOpen(L"sos_client/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                               WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (g_wh_session) WinHttpSetTimeouts(g_wh_session, 3000, 3000, 5000, 5000);
    else slog("WinHttpOpen failed (%lu)", GetLastError());
    ULONGLONG last_poll = 0;
    for (;;) {
        WaitForSingleObject(g_worker_ev, 300);
        int open, refresh, join, vote, accts, paste, send;
        Server js;
        EnterCriticalSection(&g_ui_lock);
        open = U.open;
        refresh = U.job_refresh;
        join = U.job_join;
        vote = U.job_vote;
        accts = U.job_accounts;
        paste = U.job_paste;
        send = U.job_send;
        js = U.join_srv;
        U.job_refresh = U.job_join = U.job_vote = 0;
        U.job_accounts = U.job_paste = U.job_send = 0;
        LeaveCriticalSection(&g_ui_lock);
        if (join) do_join(&js);
        if (vote) do_vote();
        if (accts) do_accounts();
        if (paste) do_paste();
        if (send) do_send();
        ULONGLONG now = GetTickCount64();
        if (open && (refresh || now - last_poll >= 3000)) {
            do_poll();
            last_poll = GetTickCount64();
        }
    }
    return 0;
}

static void ensure_worker(void)
{
    if (InterlockedCompareExchange(&g_worker_started, 1, 0) != 0) return;
    g_worker_ev = CreateEventW(NULL, FALSE, FALSE, NULL);
    HANDLE t = g_worker_ev ? CreateThread(NULL, 0, worker_main, NULL, 0, NULL) : NULL;
    if (t) CloseHandle(t);
    else slog("could not start the worker thread");
}

#ifdef SOS_CORE
#include "core_update.inc"
#endif

/* ------------------------------------------------------------------------ */
/* UI layout and hit testing                                                 */
/* ------------------------------------------------------------------------ */

typedef struct {
    float s;
    RECT btn, panel, header, rows, refresh, vote, close, status;
    RECT report, send, reason, paste, linkbox, rrows;
    int row_h, vis_rows, rvis_rows;
} Layout;

static RECT rc(int l, int t, int r, int b) { RECT x = { l, t, r, b }; return x; }

static void layout(int W, int H, Layout *L)
{
    float s = (float)H / 1080.0f;
    if (s < 0.5f) s = 0.5f;
    L->s = s;
#define S(v) ((int)((v) * s + 0.5f))
    int bw = S(150), bh = S(40), m = S(24);
    /* top centre: the main menu uses the top-left (build string) and top-right (OPTIONS / QUIT GAME) */
    L->btn = rc((W - bw) / 2, m, (W + bw) / 2, m + bh);
    int pw = S(900), ph = S(640);
    if (pw > W - 20) pw = W - 20;
    if (ph > H - 20) ph = H - 20;
    int px = (W - pw) / 2, py = (H - ph) / 2;
    L->panel = rc(px, py, px + pw, py + ph);
    L->header = rc(px + S(16), py + S(84), px + pw - S(16), py + S(84) + S(30));
    L->row_h = S(36);
    int rtop = L->header.bottom + 2;
    int rbot = py + ph - S(118);
    L->rows = rc(px + S(16), rtop, px + pw - S(16), rbot);
    L->vis_rows = (rbot - rtop) / L->row_h;
    if (L->vis_rows < 1) L->vis_rows = 1;
    int by = py + ph - S(62), bhh = S(42);
    L->refresh = rc(px + S(24), by, px + S(24) + S(130), by + bhh);
    L->vote = rc(L->refresh.right + S(16), by, L->refresh.right + S(16) + S(190), by + bhh);
    L->close = rc(px + pw - S(24) - S(130), by, px + pw - S(24), by + bhh);
    L->status = rc(px + S(24), py + ph - S(108), px + pw - S(24), py + ph - S(72));
    /* report view: a shorter list plus a row of controls under it */
    L->report = rc(L->vote.right + S(16), by, L->vote.right + S(16) + S(130), by + bhh);
    L->send = L->vote;
    int rrbot = rbot - S(48);
    L->rrows = rc(px + S(16), rtop, px + pw - S(16), rrbot);
    L->rvis_rows = (rrbot - rtop) / L->row_h;
    if (L->rvis_rows < 1) L->rvis_rows = 1;
    int cy = rrbot + S(4), ch = S(40);
    L->reason = rc(px + S(16), cy, px + S(16) + S(230), cy + ch);
    L->paste = rc(L->reason.right + S(12), cy, L->reason.right + S(12) + S(200), cy + ch);
    L->linkbox = rc(L->paste.right + S(12), cy, px + pw - S(16), cy + ch);
}

static int pt_in(const RECT *r, int x, int y) { return x >= r->left && x < r->right && y >= r->top && y < r->bottom; }

/* Caller holds g_ui_lock. */
static int hit_test(const Layout *L, int x, int y)
{
    if (U.open) {
        if (!pt_in(&L->panel, x, y)) return HIT_NONE;
        if (pt_in(&L->close, x, y)) return HIT_CLOSE;
        if (pt_in(&L->refresh, x, y)) return HIT_REFRESH;
        if (pt_in(&L->report, x, y)) return HIT_REPORT;
        if (U.report) {
            if (pt_in(&L->send, x, y)) return HIT_SEND;
            if (pt_in(&L->reason, x, y)) return HIT_REASON;
            if (pt_in(&L->paste, x, y)) return HIT_PASTE;
            if (pt_in(&L->rrows, x, y)) {
                int i = (y - L->rrows.top) / L->row_h;
                if (i < L->rvis_rows && U.rscroll + i < U.rcount) return HIT_ROW + i;
            }
            return HIT_PANEL;
        }
        if (pt_in(&L->vote, x, y)) return HIT_VOTE;
        if (pt_in(&L->rows, x, y)) {
            int i = (y - L->rows.top) / L->row_h;
            if (i < L->vis_rows && U.scroll + i < U.count) return HIT_ROW + i;
        }
        return HIT_PANEL;
    }
    if ((U.in_menu || cfg.show_everywhere) && pt_in(&L->btn, x, y)) return HIT_BTN;
    return HIT_NONE;
}

/* Caller holds g_ui_lock. */
static int server_usable(const Server *s)
{
    if (!s->online) return 0;
    if (!strcmp(s->state, "started") && !s->late_join) return 0;
    return 1;
}

/* Caller holds g_ui_lock and g_tok_lock. */
static int send_enabled(void)
{
    return g_token[0] && U.rsel[0];
}

static int vote_enabled(void)
{
    if (!g_token[0] || !U.sel_id[0]) return 0;
    for (int i = 0; i < U.count; i++)
        if (!strcmp(U.srv[i].id, U.sel_id))
            return U.srv[i].online && (!strcmp(U.srv[i].state, "waiting") || !strcmp(U.srv[i].state, "countdown"));
    return 0;
}

/* ------------------------------------------------------------------------ */
/* GDI rendering of the UI into a premultiplied BGRA bitmap                  */
/* ------------------------------------------------------------------------ */

#define UI_ALPHA 250

static HDC g_dc;
static HBITMAP g_dib, g_dib_old;
static uint32_t *g_bits;
static int g_dib_w, g_dib_h;
static HFONT g_f_title, g_f_text, g_f_small, g_f_bold;
static int g_font_h;
static RECT g_last_rc;                  /* where UI pixels were last drawn */

static int gdi_resize(int w, int h)
{
    if (!g_dc) {
        g_dc = CreateCompatibleDC(NULL);
        if (!g_dc) return 0;
        SetBkMode(g_dc, TRANSPARENT);
    }
    if (g_dib && g_dib_w == w && g_dib_h == h) return 1;
    if (g_dib) {
        SelectObject(g_dc, g_dib_old);
        DeleteObject(g_dib);
        g_dib = NULL;
        g_bits = NULL;
    }
    BITMAPINFO bi;
    memset(&bi, 0, sizeof bi);
    bi.bmiHeader.biSize = sizeof bi.bmiHeader;
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h;
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    void *bits = NULL;
    g_dib = CreateDIBSection(g_dc, &bi, DIB_RGB_COLORS, &bits, NULL, 0);
    if (!g_dib || !bits) { g_dib = NULL; return 0; }
    g_bits = bits;
    g_dib_old = SelectObject(g_dc, g_dib);
    g_dib_w = w;
    g_dib_h = h;
    SetRect(&g_last_rc, 0, 0, 0, 0);
    return 1;
}

static HFONT mkfont(int px, int weight)
{
    HFONT f = CreateFontW(-px, 0, 0, 0, weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                          OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY,
                          DEFAULT_PITCH | FF_DONTCARE, L"Segoe UI");
    if (!f)
        f = CreateFontW(-px, 0, 0, 0, weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
                        OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, ANTIALIASED_QUALITY,
                        DEFAULT_PITCH | FF_DONTCARE, L"Tahoma");
    return f;
}

static void fonts_for(float s)
{
    int h = (int)(s * 1000);
    if (g_font_h == h && g_f_text) return;
    if (g_f_title) DeleteObject(g_f_title);
    if (g_f_text) DeleteObject(g_f_text);
    if (g_f_small) DeleteObject(g_f_small);
    if (g_f_bold) DeleteObject(g_f_bold);
    g_f_title = mkfont((int)(28 * s + 0.5f), FW_SEMIBOLD);
    g_f_text = mkfont((int)(18 * s + 0.5f), FW_NORMAL);
    g_f_small = mkfont((int)(14 * s + 0.5f), FW_NORMAL);
    g_f_bold = mkfont((int)(17 * s + 0.5f), FW_SEMIBOLD);
    g_font_h = h;
}

static void gfill(const RECT *r, COLORREF c)
{
    SetBkColor(g_dc, c);
    ExtTextOutW(g_dc, 0, 0, ETO_OPAQUE, r, NULL, 0, NULL);
}

static void gframe(const RECT *r, COLORREF c)
{
    RECT a = rc(r->left, r->top, r->right, r->top + 1);
    RECT b = rc(r->left, r->bottom - 1, r->right, r->bottom);
    RECT l = rc(r->left, r->top, r->left + 1, r->bottom);
    RECT rr = rc(r->right - 1, r->top, r->right, r->bottom);
    gfill(&a, c); gfill(&b, c); gfill(&l, c); gfill(&rr, c);
}

static void gtext(const wchar_t *t, RECT r, UINT flags, HFONT f, COLORREF c)
{
    SelectObject(g_dc, f);
    SetTextColor(g_dc, c);
    DrawTextW(g_dc, t, -1, &r, flags | DT_NOPREFIX | DT_SINGLELINE | DT_VCENTER | DT_END_ELLIPSIS);
}

#define C_BG      RGB(22, 26, 36)
#define C_BORDER  RGB(74, 86, 112)
#define C_HEAD    RGB(34, 40, 54)
#define C_ROWA    RGB(26, 31, 43)
#define C_ROWB    RGB(30, 36, 49)
#define C_HOVER   RGB(48, 62, 92)
#define C_SEL     RGB(40, 92, 148)
#define C_TEXT    RGB(232, 236, 242)
#define C_DIM     RGB(112, 120, 134)
#define C_ACCENT  RGB(214, 92, 40)
#define C_ACCENT_H RGB(240, 120, 62)
#define C_BTN     RGB(52, 62, 84)
#define C_BTN_H   RGB(72, 86, 118)
#define C_GOOD    RGB(120, 206, 130)
#define C_WARN    RGB(236, 190, 90)

static void draw_button(const RECT *r, const wchar_t *label, int hover, int enabled, COLORREF base, COLORREF hov)
{
    gfill(r, enabled ? (hover ? hov : base) : C_HEAD);
    gframe(r, C_BORDER);
    gtext(label, *r, DT_CENTER, g_f_bold, enabled ? C_TEXT : C_DIM);
}

typedef struct {
    int on, count, scroll, reason, send_ok;
    const RepAcct *acct;
    const char *sel;
    const wchar_t *link;
} RepView;

/* Draw the whole UI from a snapshot; returns the rect that holds UI pixels. */
static RECT render_ui(int W, int H, const Layout *L, int btn_visible, int open, int hover,
                      const Server *srv, int count, int scroll, const char *sel_id, const wchar_t *status,
                      int vote_ok, const RepView *rv)
{
    RECT used = { 0, 0, 0, 0 };
    fonts_for(L->s);
    float s = L->s;
    if (!open && btn_visible) {
        draw_button(&L->btn, L"SERVERS", hover == HIT_BTN, 1, C_ACCENT, C_ACCENT_H);
        used = L->btn;
    } else if (open) {
        const RECT *p = &L->panel;
        gfill(p, C_BORDER);
        RECT in = rc(p->left + 1, p->top + 1, p->right - 1, p->bottom - 1);
        gfill(&in, C_BG);
        RECT tr = rc(p->left + S(24), p->top + S(14), p->right - S(24), p->top + S(54));
        gtext(L"Community servers", tr, DT_LEFT, g_f_title, C_TEXT);
        wchar_t sub[300];
        _snwprintf(sub, 299, L"Backend: %ls", g_backend_w);
        sub[299] = 0;
        RECT sr = rc(p->left + S(24), p->top + S(54), p->right - S(24), p->top + S(78));
        gtext(sub, sr, DT_LEFT, g_f_small, C_DIM);

        const RECT *h = &L->header;
        gfill(h, C_HEAD);
        int x0 = h->left + S(12);
        int cx[5] = { x0, x0 + S(330), x0 + S(450), x0 + S(580), h->right };
        const wchar_t *hn[4] = { L"Name", L"Region", L"Players", L"State" };
        const wchar_t *hr_[4] = { L"Player to report", L"Account id", L"", L"" };
        for (int i = 0; i < 4; i++) {
            RECT c = rc(cx[i], h->top, cx[i + 1] - S(8), h->bottom);
            gtext(rv->on ? hr_[i] : hn[i], c, DT_LEFT, g_f_bold, C_DIM);
        }
        double now = now_epoch_ms();
        if (rv->on) {
            for (int i = 0; i < L->rvis_rows && rv->scroll + i < rv->count; i++) {
                const RepAcct *ra = &rv->acct[rv->scroll + i];
                RECT r = rc(L->rrows.left, L->rrows.top + i * L->row_h, L->rrows.right,
                            L->rrows.top + (i + 1) * L->row_h);
                int selected = rv->sel[0] && !strcmp(rv->sel, ra->id);
                COLORREF bg = (i & 1) ? C_ROWB : C_ROWA;
                if (selected) bg = C_SEL;
                else if (hover == HIT_ROW + i) bg = C_HOVER;
                gfill(&r, bg);
                wchar_t idw[72];
                u8w(ra->id, idw, 72);
                RECT c0 = rc(cx[0], r.top, cx[1] - S(8), r.bottom);
                RECT c1 = rc(cx[1], r.top, cx[4] - S(8), r.bottom);
                gtext(ra->name, c0, DT_LEFT, g_f_text, C_TEXT);
                gtext(idw, c1, DT_LEFT, g_f_small, C_DIM);
            }
            if (rv->count > L->rvis_rows) {
                int th = L->rrows.bottom - L->rrows.top;
                int thumb_h = th * L->rvis_rows / rv->count;
                if (thumb_h < S(20)) thumb_h = S(20);
                int maxs = rv->count - L->rvis_rows;
                int ty = L->rrows.top + (maxs > 0 ? (th - thumb_h) * rv->scroll / maxs : 0);
                RECT tb = rc(L->rrows.right - S(5), ty, L->rrows.right - S(1), ty + thumb_h);
                gfill(&tb, C_BORDER);
            }
            if (rv->count == 0) {
                RECT er = rc(L->rrows.left, L->rrows.top + S(8), L->rrows.right, L->rrows.top + S(44));
                gtext(L"No players listed", er, DT_CENTER, g_f_text, C_DIM);
            }
            wchar_t rl[64];
            _snwprintf(rl, 63, L"Reason: %ls", k_rep_reason_w[rv->reason & 3]);
            rl[63] = 0;
            draw_button(&L->reason, rl, hover == HIT_REASON, 1, C_BTN, C_BTN_H);
            draw_button(&L->paste, L"Paste clip link", hover == HIT_PASTE, 1, C_BTN, C_BTN_H);
            gfill(&L->linkbox, C_HEAD);
            gframe(&L->linkbox, C_BORDER);
            RECT lt = rc(L->linkbox.left + S(10), L->linkbox.top, L->linkbox.right - S(10), L->linkbox.bottom);
            if (rv->link[0]) gtext(rv->link, lt, DT_LEFT, g_f_small, C_TEXT);
            else gtext(L"No clip link (optional)", lt, DT_LEFT, g_f_small, C_DIM);
        } else
        for (int i = 0; i < L->vis_rows && scroll + i < count; i++) {
            const Server *sv = &srv[scroll + i];
            RECT r = rc(L->rows.left, L->rows.top + i * L->row_h, L->rows.right,
                        L->rows.top + (i + 1) * L->row_h);
            int usable = server_usable(sv);
            int selected = sel_id[0] && !strcmp(sel_id, sv->id);
            COLORREF bg = (i & 1) ? C_ROWB : C_ROWA;
            if (selected) bg = C_SEL;
            else if (hover == HIT_ROW + i && usable) bg = C_HOVER;
            gfill(&r, bg);
            COLORREF fg = usable ? C_TEXT : C_DIM;
            wchar_t pl[32], stt[64];
            _snwprintf(pl, 31, L"%d/%d", sv->players, sv->max_players);
            pl[31] = 0;
            COLORREF sc = fg;
            if (!sv->online) wcscpy(stt, L"offline");
            else if (!strcmp(sv->state, "countdown")) {
                int secs = sv->countdown_ms > 0 ? (int)((sv->countdown_ms - now) / 1000.0 + 0.999) : 0;
                if (secs < 0) secs = 0;
                _snwprintf(stt, 63, L"countdown %ds", secs);
                stt[63] = 0;
                if (usable) sc = C_WARN;
            } else if (!strcmp(sv->state, "started")) {
                wcscpy(stt, sv->late_join ? L"in progress (late join)" : L"in progress");
            } else {
                wcscpy(stt, L"waiting");
                if (usable) sc = C_GOOD;
            }
            RECT c0 = rc(cx[0], r.top, cx[1] - S(8), r.bottom);
            RECT c1 = rc(cx[1], r.top, cx[2] - S(8), r.bottom);
            RECT c2 = rc(cx[2], r.top, cx[3] - S(8), r.bottom);
            RECT c3 = rc(cx[3], r.top, cx[4] - S(8), r.bottom);
            gtext(sv->name, c0, DT_LEFT, g_f_text, fg);
            gtext(sv->region, c1, DT_LEFT, g_f_text, fg);
            gtext(pl, c2, DT_LEFT, g_f_text, fg);
            gtext(stt, c3, DT_LEFT, g_f_text, sc);
        }
        if (!rv->on && count > L->vis_rows) {      /* scrollbar */
            int th = L->rows.bottom - L->rows.top;
            int thumb_h = th * L->vis_rows / count;
            if (thumb_h < S(20)) thumb_h = S(20);
            int maxs = count - L->vis_rows;
            int ty = L->rows.top + (maxs > 0 ? (th - thumb_h) * scroll / maxs : 0);
            RECT tb = rc(L->rows.right - S(5), ty, L->rows.right - S(1), ty + thumb_h);
            gfill(&tb, C_BORDER);
        }
        if (!rv->on && count == 0) {
            RECT er = rc(L->rows.left, L->rows.top + S(8), L->rows.right, L->rows.top + S(44));
            gtext(L"No community servers listed", er, DT_CENTER, g_f_text, C_DIM);
        }
        gtext(status, L->status, DT_LEFT, g_f_text, C_TEXT);
        draw_button(&L->refresh, L"Refresh", hover == HIT_REFRESH, 1, C_BTN, C_BTN_H);
        if (rv->on)
            draw_button(&L->send, L"Send report", hover == HIT_SEND && rv->send_ok, rv->send_ok, C_ACCENT, C_ACCENT_H);
        else
            draw_button(&L->vote, L"Vote to start", hover == HIT_VOTE && vote_ok, vote_ok, C_ACCENT, C_ACCENT_H);
        draw_button(&L->report, L"Report", hover == HIT_REPORT, 1, rv->on ? C_SEL : C_BTN, rv->on ? C_HOVER : C_BTN_H);
        draw_button(&L->close, rv->on ? L"Back" : L"Close", hover == HIT_CLOSE, 1, C_BTN, C_BTN_H);
        used = *p;
    }
    (void)W; (void)H;
    return used;
}
#undef S

/* Make GDI's alpha-less output into premultiplied BGRA inside r. */
static void finish_alpha(const RECT *r, const RECT *opaque)
{
    int l = r->left < 0 ? 0 : r->left, t = r->top < 0 ? 0 : r->top;
    int rr = r->right > g_dib_w ? g_dib_w : r->right, bb = r->bottom > g_dib_h ? g_dib_h : r->bottom;
    for (int y = t; y < bb; y++) {
        uint32_t *row = g_bits + (size_t)y * g_dib_w;
        for (int x = l; x < rr; x++) {
            uint32_t p = row[x];
            if (!(p & 0x00FFFFFF)) { row[x] = 0; continue; }
            uint32_t a = (opaque && x >= opaque->left && x < opaque->right && y >= opaque->top && y < opaque->bottom) ? 255 : UI_ALPHA;
            uint32_t b = (p & 0xFF) * a / 255, g = ((p >> 8) & 0xFF) * a / 255,
                     rd = ((p >> 16) & 0xFF) * a / 255;
            row[x] = (a << 24) | (rd << 16) | (g << 8) | b;
        }
    }
}

static void clear_rect(const RECT *r)
{
    int l = r->left < 0 ? 0 : r->left, t = r->top < 0 ? 0 : r->top;
    int rr = r->right > g_dib_w ? g_dib_w : r->right, bb = r->bottom > g_dib_h ? g_dib_h : r->bottom;
    if (rr <= l) return;
    for (int y = t; y < bb; y++) memset(g_bits + (size_t)y * g_dib_w + l, 0, (size_t)(rr - l) * 4);
}

/* ------------------------------------------------------------------------ */
/* D3D11 overlay                                                             */
/* ------------------------------------------------------------------------ */

typedef HRESULT (WINAPI *D3DCompileFn)(LPCVOID, SIZE_T, LPCSTR, const D3D_SHADER_MACRO *, ID3DInclude *,
                                       LPCSTR, LPCSTR, UINT, UINT, ID3DBlob **, ID3DBlob **);

static struct {
    IDXGISwapChain *sc;
    ID3D11Device *dev;
    ID3D11DeviceContext *ctx;
    ID3D11VertexShader *vs;
    ID3D11PixelShader *ps;
    ID3D11BlendState *bs;
    ID3D11RasterizerState *rs;
    ID3D11DepthStencilState *dss;
    ID3D11SamplerState *smp;
    ID3D11Texture2D *tex;
    ID3D11ShaderResourceView *srv;
    UINT tw, th;
    int ready;           /* pipeline objects created */
    int has_content;     /* texture holds visible UI */
    int force_render;
} ov;

static int g_ov_disabled;
static int g_subclassed;
static HWND g_hwnd;
static WNDPROC g_orig_wndproc;

#define REL(p) do { if (p) { IUnknown_Release((IUnknown *)(p)); (p) = NULL; } } while (0)

static void ov_release_device_objects(void)
{
    REL(ov.srv); REL(ov.tex); REL(ov.smp); REL(ov.dss); REL(ov.rs); REL(ov.bs);
    REL(ov.ps); REL(ov.vs); REL(ov.ctx); REL(ov.dev);
    ov.tw = ov.th = 0;
    ov.ready = 0;
    ov.has_content = 0;
    ov.force_render = 1;
}

static void ov_fail(const char *what, HRESULT hr)
{
    slog("overlay disabled: %s (hr=0x%08lx)", what, (unsigned long)hr);
    g_ov_disabled = 1;
    ov_release_device_objects();
}

static const char k_shader[] =
    "struct VSO { float4 p : SV_Position; float2 uv : TEXCOORD0; };\n"
    "VSO vs_main(uint id : SV_VertexID) {\n"
    "  VSO o; float2 uv = float2((id << 1) & 2, id & 2);\n"
    "  o.uv = uv; o.p = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1); return o; }\n"
    "Texture2D t0 : register(t0); SamplerState s0 : register(s0);\n"
    "float4 ps_main(VSO i) : SV_Target { return t0.Sample(s0, i.uv); }\n";

static int ov_init_pipeline(void)
{
    HMODULE comp = LoadLibraryW(L"d3dcompiler_47.dll");
    if (!comp) { ov_fail("d3dcompiler_47.dll not found", 0); return 0; }
    D3DCompileFn compile = (D3DCompileFn)(void *)GetProcAddress(comp, "D3DCompile");
    if (!compile) { ov_fail("D3DCompile missing", 0); return 0; }
    ID3DBlob *vsb = NULL, *psb = NULL, *err = NULL;
    HRESULT hr = compile(k_shader, sizeof k_shader - 1, "sos_client", NULL, NULL, "vs_main", "vs_4_0",
                         1 << 15, 0, &vsb, &err);
    if (FAILED(hr)) { REL(err); ov_fail("vertex shader compile", hr); return 0; }
    REL(err);
    hr = compile(k_shader, sizeof k_shader - 1, "sos_client", NULL, NULL, "ps_main", "ps_4_0",
                 1 << 15, 0, &psb, &err);
    if (FAILED(hr)) { REL(err); REL(vsb); ov_fail("pixel shader compile", hr); return 0; }
    REL(err);
    hr = ID3D11Device_CreateVertexShader(ov.dev, ID3D10Blob_GetBufferPointer(vsb),
                                         ID3D10Blob_GetBufferSize(vsb), NULL, &ov.vs);
    if (SUCCEEDED(hr))
        hr = ID3D11Device_CreatePixelShader(ov.dev, ID3D10Blob_GetBufferPointer(psb),
                                            ID3D10Blob_GetBufferSize(psb), NULL, &ov.ps);
    REL(vsb);
    REL(psb);
    if (FAILED(hr)) { ov_fail("create shaders", hr); return 0; }

    D3D11_BLEND_DESC bd;
    memset(&bd, 0, sizeof bd);
    bd.RenderTarget[0].BlendEnable = TRUE;
    bd.RenderTarget[0].SrcBlend = D3D11_BLEND_ONE;
    bd.RenderTarget[0].DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
    bd.RenderTarget[0].BlendOp = D3D11_BLEND_OP_ADD;
    bd.RenderTarget[0].SrcBlendAlpha = D3D11_BLEND_ONE;
    bd.RenderTarget[0].DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
    bd.RenderTarget[0].BlendOpAlpha = D3D11_BLEND_OP_ADD;
    bd.RenderTarget[0].RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
    hr = ID3D11Device_CreateBlendState(ov.dev, &bd, &ov.bs);
    if (FAILED(hr)) { ov_fail("blend state", hr); return 0; }

    D3D11_RASTERIZER_DESC rd;
    memset(&rd, 0, sizeof rd);
    rd.FillMode = D3D11_FILL_SOLID;
    rd.CullMode = D3D11_CULL_NONE;
    rd.DepthClipEnable = TRUE;
    hr = ID3D11Device_CreateRasterizerState(ov.dev, &rd, &ov.rs);
    if (FAILED(hr)) { ov_fail("rasterizer state", hr); return 0; }

    D3D11_DEPTH_STENCIL_DESC dd;
    memset(&dd, 0, sizeof dd);
    dd.DepthEnable = FALSE;
    dd.StencilEnable = FALSE;
    hr = ID3D11Device_CreateDepthStencilState(ov.dev, &dd, &ov.dss);
    if (FAILED(hr)) { ov_fail("depth state", hr); return 0; }

    D3D11_SAMPLER_DESC sd;
    memset(&sd, 0, sizeof sd);
    sd.Filter = D3D11_FILTER_MIN_MAG_MIP_POINT;
    sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    sd.ComparisonFunc = D3D11_COMPARISON_NEVER;
    sd.MaxLOD = D3D11_FLOAT32_MAX;
    hr = ID3D11Device_CreateSamplerState(ov.dev, &sd, &ov.smp);
    if (FAILED(hr)) { ov_fail("sampler state", hr); return 0; }
    ov.ready = 1;
    slog("overlay: D3D11 pipeline ready");
    return 1;
}

static int ov_make_texture(UINT w, UINT h)
{
    REL(ov.srv);
    REL(ov.tex);
    D3D11_TEXTURE2D_DESC td;
    memset(&td, 0, sizeof td);
    td.Width = w;
    td.Height = h;
    td.MipLevels = 1;
    td.ArraySize = 1;
    td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DYNAMIC;
    td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    td.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    HRESULT hr = ID3D11Device_CreateTexture2D(ov.dev, &td, NULL, &ov.tex);
    if (FAILED(hr)) { ov_fail("create texture", hr); return 0; }
    hr = ID3D11Device_CreateShaderResourceView(ov.dev, (ID3D11Resource *)ov.tex, NULL, &ov.srv);
    if (FAILED(hr)) { ov_fail("create SRV", hr); return 0; }
    ov.tw = w;
    ov.th = h;
    ov.force_render = 1;
    ov.has_content = 0;
    return 1;
}

typedef struct {
    ID3D11RenderTargetView *rtv[8];
    ID3D11DepthStencilView *dsv;
    ID3D11BlendState *bs; FLOAT bf[4]; UINT bmask;
    ID3D11DepthStencilState *dss; UINT sref;
    UINT nvp; D3D11_VIEWPORT vp[16];
    ID3D11RasterizerState *rs;
    UINT nsc; D3D11_RECT sc[16];
    ID3D11InputLayout *il; D3D11_PRIMITIVE_TOPOLOGY topo;
    ID3D11VertexShader *vs; ID3D11PixelShader *ps;
    ID3D11GeometryShader *gs; ID3D11HullShader *hs; ID3D11DomainShader *ds;
    ID3D11ShaderResourceView *psrv; ID3D11SamplerState *psmp;
} Saved;

static void state_save(ID3D11DeviceContext *c, Saved *s)
{
    memset(s, 0, sizeof *s);
    ID3D11DeviceContext_OMGetRenderTargets(c, 8, s->rtv, &s->dsv);
    ID3D11DeviceContext_OMGetBlendState(c, &s->bs, s->bf, &s->bmask);
    ID3D11DeviceContext_OMGetDepthStencilState(c, &s->dss, &s->sref);
    s->nvp = 16;
    ID3D11DeviceContext_RSGetViewports(c, &s->nvp, s->vp);
    ID3D11DeviceContext_RSGetState(c, &s->rs);
    s->nsc = 16;
    ID3D11DeviceContext_RSGetScissorRects(c, &s->nsc, s->sc);
    ID3D11DeviceContext_IAGetInputLayout(c, &s->il);
    ID3D11DeviceContext_IAGetPrimitiveTopology(c, &s->topo);
    ID3D11DeviceContext_VSGetShader(c, &s->vs, NULL, NULL);
    ID3D11DeviceContext_PSGetShader(c, &s->ps, NULL, NULL);
    ID3D11DeviceContext_GSGetShader(c, &s->gs, NULL, NULL);
    ID3D11DeviceContext_HSGetShader(c, &s->hs, NULL, NULL);
    ID3D11DeviceContext_DSGetShader(c, &s->ds, NULL, NULL);
    ID3D11DeviceContext_PSGetShaderResources(c, 0, 1, &s->psrv);
    ID3D11DeviceContext_PSGetSamplers(c, 0, 1, &s->psmp);
}

static void state_restore(ID3D11DeviceContext *c, Saved *s)
{
    ID3D11DeviceContext_OMSetRenderTargets(c, 8, s->rtv, s->dsv);
    ID3D11DeviceContext_OMSetBlendState(c, s->bs, s->bf, s->bmask);
    ID3D11DeviceContext_OMSetDepthStencilState(c, s->dss, s->sref);
    ID3D11DeviceContext_RSSetViewports(c, s->nvp, s->nvp ? s->vp : NULL);
    ID3D11DeviceContext_RSSetState(c, s->rs);
    ID3D11DeviceContext_RSSetScissorRects(c, s->nsc, s->nsc ? s->sc : NULL);
    ID3D11DeviceContext_IASetInputLayout(c, s->il);
    ID3D11DeviceContext_IASetPrimitiveTopology(c, s->topo);
    ID3D11DeviceContext_VSSetShader(c, s->vs, NULL, 0);
    ID3D11DeviceContext_PSSetShader(c, s->ps, NULL, 0);
    ID3D11DeviceContext_GSSetShader(c, s->gs, NULL, 0);
    ID3D11DeviceContext_HSSetShader(c, s->hs, NULL, 0);
    ID3D11DeviceContext_DSSetShader(c, s->ds, NULL, 0);
    ID3D11DeviceContext_PSSetShaderResources(c, 0, 1, &s->psrv);
    ID3D11DeviceContext_PSSetSamplers(c, 0, 1, &s->psmp);
    for (int i = 0; i < 8; i++) REL(s->rtv[i]);
    REL(s->dsv); REL(s->bs); REL(s->dss); REL(s->rs); REL(s->il);
    REL(s->vs); REL(s->ps); REL(s->gs); REL(s->hs); REL(s->ds); REL(s->psrv); REL(s->psmp);
}

static LRESULT CALLBACK sub_proc(HWND, UINT, WPARAM, LPARAM);

static void ov_subclass(IDXGISwapChain *sc, uint8_t *vp)
{
    if (g_subclassed) return;
    g_subclassed = 1;
    HWND hw = NULL;
    DXGI_SWAP_CHAIN_DESC d;
    if (SUCCEEDED(IDXGISwapChain_GetDesc(sc, &d))) hw = d.OutputWindow;
    if (!hw) hw = *(HWND *)(vp + 0x40);
    if (!hw || !IsWindow(hw)) { slog("subclass: no window"); return; }
    g_hwnd = hw;
    g_orig_wndproc = (WNDPROC)SetWindowLongPtrW(hw, GWLP_WNDPROC, (LONG_PTR)sub_proc);
    if (!g_orig_wndproc) { slog("subclass failed (%lu)", GetLastError()); return; }
    slog("window subclassed (hwnd %p)", (void *)hw);
    if (cfg.borderless) {
        /* Only for a normal framed window: exclusive fullscreen has no caption to remove. The style change
           is safe from this thread; the move is posted asynchronously so the game thread is never waited on. */
        LONG_PTR st = GetWindowLongPtrW(hw, GWL_STYLE);
        if (st & WS_CAPTION) {
            MONITORINFO mi;
            mi.cbSize = sizeof mi;
            HMONITOR mon = MonitorFromWindow(hw, MONITOR_DEFAULTTONEAREST);
            if (mon && GetMonitorInfoW(mon, &mi)) {
                SetWindowLongPtrW(hw, GWL_STYLE, (st & ~(LONG_PTR)(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU)) | WS_POPUP);
                SetWindowPos(hw, HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top,
                             mi.rcMonitor.right - mi.rcMonitor.left, mi.rcMonitor.bottom - mi.rcMonitor.top,
                             SWP_FRAMECHANGED | SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE);
                slog("borderless: window covers the monitor (%ldx%ld)", (long)(mi.rcMonitor.right - mi.rcMonitor.left),
                     (long)(mi.rcMonitor.bottom - mi.rcMonitor.top));
            }
        } else {
            slog("borderless: window has no caption (already fullscreen/borderless), nothing to do");
        }
    }
}

static void ov_frame(uint8_t *vp)
{
    IDXGISwapChain *sc = *(IDXGISwapChain **)(vp + 0x60);
    if (!sc || (uintptr_t)sc < 0x10000) return;
    if (!g_subclassed) ov_subclass(sc, vp);

    Layout L;
    int vis_btn, open;
    EnterCriticalSection(&g_ui_lock);
    open = U.open;
    vis_btn = !open && (U.in_menu || cfg.show_everywhere);
    int need = open || vis_btn || ov.has_content;
    /* The countdown text changes each second. */
    static int last_cd_sig;
    if (open) {
        int sig = 0;
        double now = now_epoch_ms();
        for (int i = 0; i < U.count; i++)
            if (!strcmp(U.srv[i].state, "countdown") && U.srv[i].countdown_ms > 0)
                sig += (int)((U.srv[i].countdown_ms - now) / 1000.0) + 1000;
        if (sig != last_cd_sig) { last_cd_sig = sig; U.dirty = 1; }
    }
    LeaveCriticalSection(&g_ui_lock);
    if (!need) return;

    if (sc != ov.sc) {
        ov_release_device_objects();
        ov.sc = sc;
    }
    if (!ov.dev) {
        HRESULT hr = IDXGISwapChain_GetDevice(sc, &IID_ID3D11Device, (void **)&ov.dev);
        if (FAILED(hr) || !ov.dev) { ov.dev = NULL; ov_fail("swap chain has no D3D11 device", hr); return; }
        ID3D11Device_GetImmediateContext(ov.dev, &ov.ctx);
        if (!ov.ctx) { ov_fail("no immediate context", 0); return; }
    }
    if (!ov.ready && !ov_init_pipeline()) return;

    ID3D11Texture2D *bb = NULL;
    HRESULT hr = IDXGISwapChain_GetBuffer(sc, 0, &IID_ID3D11Texture2D, (void **)&bb);
    if (FAILED(hr) || !bb) { ov_fail("GetBuffer", hr); return; }
    D3D11_TEXTURE2D_DESC bd;
    ID3D11Texture2D_GetDesc(bb, &bd);
    if (bd.Width < 64 || bd.Height < 64 || bd.Width > 16384 || bd.Height > 16384 || bd.SampleDesc.Count != 1) {
        REL(bb);
        return;
    }
    if (bd.Width != ov.tw || bd.Height != ov.th) {
        if (!ov_make_texture(bd.Width, bd.Height)) { REL(bb); return; }
    }
    if (!gdi_resize((int)bd.Width, (int)bd.Height)) { REL(bb); ov_fail("DIB section", 0); return; }
    layout((int)bd.Width, (int)bd.Height, &L);

    /* Re-render only when the UI changed. */
    int dirty;
    EnterCriticalSection(&g_ui_lock);
    U.bbw = (int)bd.Width;
    U.bbh = (int)bd.Height;
    dirty = U.dirty || ov.force_render;
    static Server snap[MAX_SERVERS];
    static wchar_t status[200];
    char sel[80];
    int count, scroll, hover, vote_ok;
    static RepAcct racc_snap[MAX_ACCTS];
    static wchar_t rlink_snap[512];
    char rsel_snap[80];
    RepView rv;
    memset(&rv, 0, sizeof rv);
    rv.acct = racc_snap;
    rv.sel = rsel_snap;
    rv.link = rlink_snap;
    rsel_snap[0] = 0;
    rlink_snap[0] = 0;
    if (dirty) {
        U.dirty = 0;
        ov.force_render = 0;
        count = U.count;
        memcpy(snap, U.srv, sizeof(Server) * (size_t)count);
        wcscpy(status, U.status);
        memcpy(sel, U.sel_id, sizeof sel);
        scroll = U.scroll;
        hover = U.hover;
        EnterCriticalSection(&g_tok_lock);
        vote_ok = vote_enabled();
        LeaveCriticalSection(&g_tok_lock);
        open = U.open;
        vis_btn = !open && (U.in_menu || cfg.show_everywhere);
        if (U.scroll > 0 && U.scroll > count - L.vis_rows) scroll = U.scroll = count > L.vis_rows ? count - L.vis_rows : 0;
        if (U.rscroll > 0 && U.rscroll > U.rcount - L.rvis_rows) U.rscroll = U.rcount > L.rvis_rows ? U.rcount - L.rvis_rows : 0;
        rv.on = U.report;
        if (rv.on) {
            rv.count = U.rcount;
            rv.scroll = U.rscroll;
            rv.reason = U.rreason;
            memcpy(racc_snap, U.racc, sizeof(RepAcct) * (size_t)U.rcount);
            memcpy(rsel_snap, U.rsel, sizeof rsel_snap);
            wcscpy(rlink_snap, U.rlink_w);
            EnterCriticalSection(&g_tok_lock);
            rv.send_ok = send_enabled();
            LeaveCriticalSection(&g_tok_lock);
        }
    }
    LeaveCriticalSection(&g_ui_lock);

    if (dirty) {
        RECT cur_used = open ? L.panel : (vis_btn ? L.btn : rc(0, 0, 0, 0));
        RECT region;
        UnionRect(&region, &g_last_rc, &cur_used);
        clear_rect(&region);
        GdiFlush();
        RECT used = render_ui((int)bd.Width, (int)bd.Height, &L, vis_btn, open, hover, snap, count, scroll,
                              sel, status, vote_ok, &rv);
        GdiFlush();
        finish_alpha(&region, open ? &L.rows : (vis_btn ? &L.btn : NULL));
        g_last_rc = used;
        ov.has_content = open || vis_btn;

        D3D11_MAPPED_SUBRESOURCE m;
        hr = ID3D11DeviceContext_Map(ov.ctx, (ID3D11Resource *)ov.tex, 0, D3D11_MAP_WRITE_DISCARD, 0, &m);
        if (FAILED(hr)) { REL(bb); ov_fail("Map", hr); return; }
        for (UINT y = 0; y < ov.th; y++)
            memcpy((uint8_t *)m.pData + (size_t)y * m.RowPitch, g_bits + (size_t)y * g_dib_w, (size_t)ov.tw * 4);
        ID3D11DeviceContext_Unmap(ov.ctx, (ID3D11Resource *)ov.tex, 0);
    }
    if (!ov.has_content) { REL(bb); return; }

    ID3D11RenderTargetView *rtv = NULL;
    hr = ID3D11Device_CreateRenderTargetView(ov.dev, (ID3D11Resource *)bb, NULL, &rtv);
    if (FAILED(hr) || !rtv) {
        D3D11_RENDER_TARGET_VIEW_DESC rd;
        memset(&rd, 0, sizeof rd);
        rd.Format = bd.Format == DXGI_FORMAT_B8G8R8A8_TYPELESS ? DXGI_FORMAT_B8G8R8A8_UNORM :
                    bd.Format == DXGI_FORMAT_R8G8B8A8_TYPELESS ? DXGI_FORMAT_R8G8B8A8_UNORM : bd.Format;
        rd.ViewDimension = D3D11_RTV_DIMENSION_TEXTURE2D;
        hr = ID3D11Device_CreateRenderTargetView(ov.dev, (ID3D11Resource *)bb, &rd, &rtv);
    }
    REL(bb);
    if (FAILED(hr) || !rtv) { ov_fail("CreateRenderTargetView", hr); return; }

    ID3D11DeviceContext *c = ov.ctx;
    Saved sv;
    state_save(c, &sv);
    D3D11_VIEWPORT v = { 0.0f, 0.0f, (FLOAT)ov.tw, (FLOAT)ov.th, 0.0f, 1.0f };
    FLOAT bf[4] = { 0, 0, 0, 0 };
    ID3D11DeviceContext_OMSetRenderTargets(c, 1, &rtv, NULL);
    ID3D11DeviceContext_OMSetBlendState(c, ov.bs, bf, 0xFFFFFFFF);
    ID3D11DeviceContext_OMSetDepthStencilState(c, ov.dss, 0);
    ID3D11DeviceContext_RSSetViewports(c, 1, &v);
    ID3D11DeviceContext_RSSetState(c, ov.rs);
    ID3D11DeviceContext_IASetInputLayout(c, NULL);
    ID3D11DeviceContext_IASetPrimitiveTopology(c, D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    ID3D11DeviceContext_VSSetShader(c, ov.vs, NULL, 0);
    ID3D11DeviceContext_GSSetShader(c, NULL, NULL, 0);
    ID3D11DeviceContext_HSSetShader(c, NULL, NULL, 0);
    ID3D11DeviceContext_DSSetShader(c, NULL, NULL, 0);
    ID3D11DeviceContext_PSSetShader(c, ov.ps, NULL, 0);
    ID3D11DeviceContext_PSSetShaderResources(c, 0, 1, &ov.srv);
    ID3D11DeviceContext_PSSetSamplers(c, 0, 1, &ov.smp);
    ID3D11DeviceContext_Draw(c, 3, 0);
    state_restore(c, &sv);
    REL(rtv);
}

typedef char (*PresentFn)(uint8_t *vp, uint32_t sync);
static PresentFn o_present;

static char h_present(uint8_t *vp, uint32_t sync)
{
    static int busy;
    if (vp && !g_ov_disabled && !busy) {
        busy = 1;
        ov_frame(vp);
        busy = 0;
    }
    return o_present(vp, sync);
}

/* ------------------------------------------------------------------------ */
/* Window subclass: mouse and Escape                                         */
/* ------------------------------------------------------------------------ */

/* Client pixels -> backbuffer pixels. */
static void to_bb(HWND hw, LPARAM lp, int *x, int *y)
{
    int cx = (short)LOWORD(lp), cy = (short)HIWORD(lp);
    RECT cr;
    if (GetClientRect(hw, &cr) && cr.right > 0 && cr.bottom > 0 && U.bbw > 0 && U.bbh > 0) {
        cx = (int)((long long)cx * U.bbw / cr.right);
        cy = (int)((long long)cy * U.bbh / cr.bottom);
    }
    *x = cx;
    *y = cy;
}

static void click_action(int hit)
{
    /* g_ui_lock held by the caller. Returns after setting job flags. */
    if (hit == HIT_BTN) {
        U.open = 1;
        U.report = 0;
        U.scroll = 0;
        wcscpy(U.status, L"Loading...");
        U.job_refresh = 1;
    } else if (hit == HIT_CLOSE) {
        if (U.report) {
            U.report = 0;
            wcscpy(U.status, U.count ? L"Pick a server to join." : L"No servers found.");
        } else {
            U.open = 0;
        }
    } else if (hit == HIT_REPORT) {
        U.report = !U.report;
        if (U.report) {
            U.rscroll = 0;
            wcscpy(U.status, L"Loading players...");
            U.job_accounts = 1;
        } else {
            wcscpy(U.status, U.count ? L"Pick a server to join." : L"No servers found.");
        }
    } else if (hit == HIT_REASON) {
        U.rreason = (U.rreason + 1) & 3;
    } else if (hit == HIT_PASTE) {
        U.job_paste = 1;
        wcscpy(U.status, L"Reading clipboard...");
    } else if (hit == HIT_SEND) {
        EnterCriticalSection(&g_tok_lock);
        int has_tok = g_token[0] != 0;
        LeaveCriticalSection(&g_tok_lock);
        if (!U.rsel[0]) wcscpy(U.status, L"Pick a player to report first");
        else if (!has_tok) wcscpy(U.status, L"Not signed in yet");
        else {
            U.job_send = 1;
            wcscpy(U.status, L"Sending report...");
        }
    } else if (hit == HIT_REFRESH) {
        wcscpy(U.status, U.report ? L"Loading players..." : L"Loading...");
        if (U.report) U.job_accounts = 1;
        else U.job_refresh = 1;
    } else if (hit == HIT_VOTE) {
        EnterCriticalSection(&g_tok_lock);
        int ok = vote_enabled();
        LeaveCriticalSection(&g_tok_lock);
        if (ok) {
            U.job_vote = 1;
            wcscpy(U.status, L"Sending vote...");
        }
    } else if (hit >= HIT_ROW && U.report) {
        int idx = U.rscroll + (hit - HIT_ROW);
        if (idx >= 0 && idx < U.rcount) {
            snprintf(U.rsel, sizeof U.rsel, "%s", U.racc[idx].id);
            _snwprintf(U.status, 199, L"Reporting %ls. Pick a reason, then Send.", U.racc[idx].name);
        }
    } else if (hit >= HIT_ROW) {
        int idx = U.scroll + (hit - HIT_ROW);
        if (idx >= 0 && idx < U.count) {
            const Server *sv = &U.srv[idx];
            if (!server_usable(sv)) {
                _snwprintf(U.status, 199, !sv->online ? L"%ls is offline." : L"%ls is closed to new players.",
                           sv->name);
            } else {
                U.join_srv = *sv;
                U.job_join = 1;
                _snwprintf(U.status, 199, L"Selecting %ls...", sv->name);
            }
        }
    }
    U.status[199] = 0;
    U.dirty = 1;
}

static LRESULT CALLBACK sub_proc(HWND hw, UINT msg, WPARAM wp, LPARAM lp)
{
    int consume = 0, wake = 0;
    switch (msg) {
    case WM_MOUSEMOVE: {
        int x, y;
        EnterCriticalSection(&g_ui_lock);
        to_bb(hw, lp, &x, &y);
        U.mx = x;
        U.my = y;
        if (U.bbw > 0 && (U.open || U.in_menu || cfg.show_everywhere)) {
            Layout L;
            layout(U.bbw, U.bbh, &L);
            int h = hit_test(&L, x, y);
            if (h != U.hover) { U.hover = h; U.dirty = 1; }
        }
        LeaveCriticalSection(&g_ui_lock);
        break;
    }
    case WM_LBUTTONDOWN: case WM_LBUTTONDBLCLK: case WM_LBUTTONUP:
    case WM_RBUTTONDOWN: case WM_RBUTTONDBLCLK: case WM_RBUTTONUP: {
        int x, y;
        EnterCriticalSection(&g_ui_lock);
        to_bb(hw, lp, &x, &y);
        if (U.open) {
            consume = 1;
            if (msg == WM_LBUTTONUP && U.bbw > 0) {
                Layout L;
                layout(U.bbw, U.bbh, &L);
                int h = hit_test(&L, x, y);
                if (h != HIT_NONE && h != HIT_PANEL) { click_action(h); wake = 1; }
            }
        } else if ((U.in_menu || cfg.show_everywhere) && U.bbw > 0) {
            Layout L;
            layout(U.bbw, U.bbh, &L);
            if (hit_test(&L, x, y) == HIT_BTN) {
                consume = 1;
                if (msg == WM_LBUTTONUP) { click_action(HIT_BTN); wake = 1; }
            }
        }
        {
            /* Diagnostics for "clicks do nothing in a match": the first few left clicks outside the menu. */
            static volatile LONG diag_n;
            if (msg == WM_LBUTTONDOWN && !U.in_menu && diag_n < 12) {
                CURSORINFO ci; ci.cbSize = sizeof ci;
                int shown = GetCursorInfo(&ci) ? (ci.flags & CURSOR_SHOWING) != 0 : -1;
                slog("input: in-match left click, %s by the mod (panel open=%d), system cursor visible=%d, foreground=%d",
                     consume ? "CONSUMED" : "passed to the game", U.open, shown, GetForegroundWindow() == hw);
                InterlockedIncrement(&diag_n);
            }
        }
        LeaveCriticalSection(&g_ui_lock);
        if (wake) { ensure_worker(); if (g_worker_ev) SetEvent(g_worker_ev); }
        if (consume) return 0;
        break;
    }
    case WM_MOUSEWHEEL: {
        EnterCriticalSection(&g_ui_lock);
        if (U.open && U.bbw > 0) {
            Layout L;
            layout(U.bbw, U.bbh, &L);
            POINT pt = { (short)LOWORD(lp), (short)HIWORD(lp) };
            ScreenToClient(hw, &pt);
            int x, y;
            to_bb(hw, MAKELPARAM(pt.x, pt.y), &x, &y);
            if (pt_in(&L.panel, x, y)) {
                int d = (short)HIWORD(wp) > 0 ? -1 : 1;
                int *scp = U.report ? &U.rscroll : &U.scroll;
                int cnt = U.report ? U.rcount : U.count, vis = U.report ? L.rvis_rows : L.vis_rows;
                int maxs = cnt > vis ? cnt - vis : 0;
                int ns = *scp + d;
                if (ns < 0) ns = 0;
                if (ns > maxs) ns = maxs;
                if (ns != *scp) { *scp = ns; U.dirty = 1; }
                consume = 1;
            }
        }
        LeaveCriticalSection(&g_ui_lock);
        if (consume) return 0;
        break;
    }
    case WM_KEYDOWN: case WM_KEYUP:
        if (wp == VK_ESCAPE) {
            EnterCriticalSection(&g_ui_lock);
            if (U.open) {
                consume = 1;
                if (msg == WM_KEYDOWN) { U.open = 0; U.report = 0; U.dirty = 1; }
            }
            LeaveCriticalSection(&g_ui_lock);
            if (consume) return 0;
        }
        break;
    default:
        break;
    }
    return CallWindowProcW(g_orig_wndproc, hw, msg, wp, lp);
}

/* ------------------------------------------------------------------------ */
/* Play trigger: UObject::ProcessEvent detour -> FrontendActionBar "Queue for Match" */
/* ------------------------------------------------------------------------ */
/* trigger_play() only sets a flag; the real work runs on the game thread inside
   the ProcessEvent detour, as the same Blueprint event the PLAY button fires.
   See docs/client-mod-play-trigger.md. */

#define RVA_PROCESS_EVENT   0x05364C0u
#define RVA_FIND_FUNCTION   0x04E97D0u   /* UClass::FindFunctionByName(cls, FName, bIncludeSuper) */
#define RVA_FNAME_CTOR      0x0472C50u   /* FName(FName*, const TCHAR*, EFindName) */
#define RVA_GUOBJ_OBJECTS   0x2A93900u   /* FUObjectItem* */
#define RVA_GUOBJ_NUM       0x2A9390Cu   /* int32 */
#define RVA_GAME_THREAD_ID  0x2A035FCu   /* DWORD */

typedef struct { int32_t idx, num; } FNameI;
typedef void (*ProcessEventFn)(void *self, void *fn, void *parms);
typedef void *(*FindFunctionFn)(void *cls, FNameI name, uint8_t include_super);
typedef FNameI *(*FNameCtorFn)(FNameI *out, const wchar_t *s, int find);

static ProcessEventFn o_pe;
static volatile LONG g_play_flag;         /* 0 idle, 1 requested, 2 pending (waiting for the bar) */
static ULONGLONG g_play_deadline, g_play_last_try;
static wchar_t g_play_name[72];
static FNameI g_bar_name;
static int g_bar_name_ok;

static void trigger_play(void)
{
    if (!cfg.auto_play || !o_pe) {
        slog("trigger_play: %s", cfg.auto_play ? "ProcessEvent hook unavailable" : "AutoPlay=0");
        return;
    }
    EnterCriticalSection(&g_ui_lock);
    wcsncpy(g_play_name, U.join_srv.name, 71);
    g_play_name[71] = 0;
    LeaveCriticalSection(&g_ui_lock);
    slog("trigger_play: requested for \"%ls\"", g_play_name);
    InterlockedExchange(&g_play_flag, 1);
}

static int fname_eq(const FNameI *a, const FNameI *b) { return a->idx == b->idx && a->num == b->num; }

static int plausible_ptr(const void *p) { return p && (uintptr_t)p > 0x10000 && ((uintptr_t)p & 7) == 0; }

static void fname_str(const void *fname, wchar_t *out, int cap)
{
    FString fs = { 0 };
    out[0] = 0;
    ((FNameToStringFn)AT(RVA_FNAME_TOSTR))((const FName *)fname, &fs);
    if (fs.data) {
        wcsncpy(out, fs.data, (size_t)cap - 1);
        out[cap - 1] = 0;
        ((FreeFn)AT(RVA_MEM_FREE))(fs.data);
    }
}

static int is_bar_instance(const uint8_t *obj)
{
    if (!plausible_ptr(obj)) return 0;
    const uint8_t *cls = *(const uint8_t *const *)(obj + 0x10);
    if (!plausible_ptr(cls)) return 0;
    if (!fname_eq((const FNameI *)(cls + 0x18), &g_bar_name)) return 0;
    if (*(const uint32_t *)(obj + 8) & 0x10) return 0;             /* RF_ClassDefaultObject */
    return 1;
}

static void *scan_for_bar(void)
{
    uint8_t *objs = *(uint8_t **)AT(RVA_GUOBJ_OBJECTS);
    int32_t num = *(int32_t *)AT(RVA_GUOBJ_NUM);
    if (!plausible_ptr(objs) || num <= 0 || num > 8 * 1024 * 1024) {
        slog("play: GUObjectArray unreadable (objects=%p num=%d)", (void *)objs, num);
        return NULL;
    }
    void *last = NULL;
    int found = 0;
    for (int32_t i = 0; i < num; i++) {
        uint8_t *item = objs + (size_t)i * 16;
        uint8_t *obj = *(uint8_t **)item;
        if (!obj) continue;
        if (*(int32_t *)(item + 8) & 0x20000000) continue;          /* PendingKill */
        if (is_bar_instance(obj)) {
            wchar_t nm[96], on[96];
            fname_str(obj + 0x18, nm, 96);
            on[0] = 0;
            const uint8_t *outer = *(const uint8_t *const *)(obj + 0x20);
            if (plausible_ptr(outer)) fname_str(outer + 0x18, on, 96);
            slog("play: bar candidate %p index %d object \"%ls\" outer \"%ls\" flags %08x", (void *)obj, i, nm, on,
                 *(const uint32_t *)(obj + 8));
            last = obj;
            found++;
        }
    }
    if (!found) slog("play: no live FrontendActionBar_C among %d objects", num);
    else slog("play: %d bar instance(s); using the newest %p", found, last);
    return last;
}

static void *find_prop(const uint8_t *cls, const wchar_t *name)
{
    FNameI n;
    ((FNameCtorFn)AT(RVA_FNAME_CTOR))(&n, name, 0);
    if (n.idx == 0) return NULL;
    const uint8_t *p = *(const uint8_t *const *)(cls + 0x68);
    for (int i = 0; i < 4096 && plausible_ptr(p); i++) {
        if (fname_eq((const FNameI *)(p + 0x18), &n)) return (void *)p;
        p = *(const uint8_t *const *)(p + 0x68);
    }
    return NULL;
}

/* Returns 0/1, or -1 when the property is missing or does not look like a bool. */
static int read_bool_prop(const uint8_t *obj, const wchar_t *name)
{
    const uint8_t *cls = *(const uint8_t *const *)(obj + 0x10);
    const uint8_t *p = find_prop(cls, name);
    if (!p) return -1;
    uint8_t fsize = p[0x78], boff = p[0x79], bmask = p[0x7A], fmask = p[0x7B];
    int32_t off = *(const int32_t *)(p + 0x50);
    if (*(const int32_t *)(p + 0x34) != 1 || fsize != 1 || !bmask || (bmask & (bmask - 1)) || bmask != fmask ||
        off < 0 || off > 0x100000)
        return -1;
    return (obj[off + boff] & bmask) != 0;
}

static int read_int_prop(const uint8_t *obj, const wchar_t *name, int *out)
{
    const uint8_t *cls = *(const uint8_t *const *)(obj + 0x10);
    const uint8_t *p = find_prop(cls, name);
    if (!p) return 0;
    int32_t off = *(const int32_t *)(p + 0x50);
    if (*(const int32_t *)(p + 0x34) != 4 || off < 0 || off > 0x100000) return 0;
    *out = *(const int32_t *)(obj + off);
    return 1;
}

/* 1 = queued (done), 0 = not ready yet (stay pending), -1 = give up. */
static int play_attempt(void *bar)
{
    uint8_t *b = bar;
    void *cls = *(void **)(b + 0x10);
    FNameI qn;
    /* The literal PLAY click handler (what the UButton OnClicked delegate runs). Calling the inner
       "Queue for Match" event directly crashed the game (null object in the Blueprint VM). */
    ((FNameCtorFn)AT(RVA_FNAME_CTOR))(&qn, L"BndEvt__Play Button_K2Node_ComponentBoundEvent_1007_OnClicked__DelegateSignature", 1);
    void *fn = ((FindFunctionFn)AT(RVA_FIND_FUNCTION))(cls, qn, 1);
    if (!fn) {
        slog("play: PLAY click handler UFunction not found on the bar's class");
        ui_set_status(L"Press START, then PLAY");
        return -1;
    }
    int inq = read_bool_prop(b, L"In Queue");
    int wait = 0;
    int have_wait = read_int_prop(b, L"Please Wait State RefCount", &wait);
    slog("play: bar %p fn %p In Queue=%d PleaseWaitRefCount=%d", bar, fn, inq, have_wait ? wait : -1);
    if (inq == 1) {
        slog("play: already in queue; nothing to do");
        ui_set_status(L"Already searching for a match");
        return -1;
    }
    if (have_wait && wait > 0) {
        ui_set_status(L"Waiting for the menu to be ready...");
        return 0;
    }
    uint16_t psize = *(uint16_t *)((uint8_t *)fn + 0x90);
    uint8_t parms[256];
    memset(parms, 0, sizeof parms);
    if (psize > sizeof parms) { slog("play: ParmsSize %u too large; aborting", psize); return -1; }
    InterlockedExchange(&g_play_flag, 0);            /* before the call: nested events see the fast path */
    slog("play: calling original ProcessEvent(bar, PLAY click handler)");
    o_pe(bar, fn, parms);
    slog("play: PLAY click handler returned");
    ui_set_status(L"Joining %ls...", g_play_name);
    return 1;
}

static void play_tick(void *self)
{
    DWORD gt = *(DWORD *)AT(RVA_GAME_THREAD_ID);
    if (GetCurrentThreadId() != gt) {
        static volatile LONG once;
        if (InterlockedIncrement(&once) == 1)
            slog("play: ProcessEvent seen off the game thread (tid %lu, GGameThreadId %lu); waiting",
                 GetCurrentThreadId(), (unsigned long)gt);
        return;
    }
    ULONGLONG now = GetTickCount64();
    if (g_play_flag == 1) {
        g_play_deadline = now + 60000;
        g_play_last_try = now;
        if (!g_bar_name_ok) {
            ((FNameCtorFn)AT(RVA_FNAME_CTOR))(&g_bar_name, L"FrontendActionBar_C", 1);
            g_bar_name_ok = g_bar_name.idx != 0;
            slog("play: class FName FrontendActionBar_C = (%d,%d)", g_bar_name.idx, g_bar_name.num);
        }
        InterlockedExchange(&g_play_flag, 2);        /* requested -> pending */
        void *bar = g_bar_name_ok ? scan_for_bar() : NULL;
        if (!bar) {
            ui_set_status(L"Press START, then PLAY");
            return;
        }
        int r = play_attempt(bar);
        if (r != 0) InterlockedExchange(&g_play_flag, 0);
        return;
    }
    /* pending: wait for the bar to show up as the target of a ProcessEvent call */
    if (now > g_play_deadline) {
        slog("play: gave up waiting for the action bar (60 s)");
        InterlockedExchange(&g_play_flag, 0);
        return;
    }
    if (now - g_play_last_try < 500 || !is_bar_instance(self)) return;
    g_play_last_try = now;
    slog("play: action bar appeared (%p); retrying", self);
    int r = play_attempt(self);
    if (r != 0) InterlockedExchange(&g_play_flag, 0);
}


/* ------------------------------------------------------------------------ */
/* Text pass: build label and boot notice                                    */
/* ------------------------------------------------------------------------ */
/* The "SOSTEST v.x" label is the UTextBlock "BuildVersionText" (main menu HUD and in-game HUD), set
   by the Blueprint event UpdateBuildInfoText from the app id (which must stay: it gates login). We
   leave the app id alone and call the widget's own SetText with our label, again after every
   UpdateBuildInfoText. The "servers shut down" overlay is closed by running its OK button handler.
   Everything runs on the game thread inside the ProcessEvent detour. */

static struct {
    int init;
    FNameI overlay_cls, build_text, update_build, textblock, ktl_cdo_name, conv_name, settext_name, overlay_name, ok_name, header_name, message_name;
    void *ktl_cdo;
    void *notice_done[8]; int nnotice;        /* notice text blocks already restyled */
    void *applied[16]; int napplied;          /* text blocks already set */
    void *dismissed[8]; int ndismissed;       /* HUD widgets whose notice was closed */
    ULONGLONG next_scan;
    int logged_missing_ft;
} T;

static int in_list(void **l, int n, void *p) { for (int i = 0; i < n; i++) if (l[i] == p) return 1; return 0; }

static int make_ftext(const wchar_t *s, uint8_t out[0x18])
{
    if (!T.ktl_cdo || !plausible_ptr(T.ktl_cdo)) return 0;
    void *cls = *(void **)((uint8_t *)T.ktl_cdo + 0x10);
    void *fn = ((FindFunctionFn)AT(RVA_FIND_FUNCTION))(cls, T.conv_name, 1);
    if (!fn) return 0;
    uint8_t parms[0x60];
    memset(parms, 0, sizeof parms);
    static wchar_t buf[704];
    wcsncpy(buf, s, 703);
    buf[703] = 0;
    FString *fs = (FString *)parms;
    fs->data = buf;
    fs->num = fs->max = (int32_t)wcslen(buf) + 1;
    o_pe(T.ktl_cdo, fn, parms);
    if (!plausible_ptr(*(void **)(parms + 0x10))) return 0;     /* ReturnValue: FText at +0x10 */
    memcpy(out, parms + 0x10, 0x18);
    return 1;
}

static int set_textblock(void *tb, const wchar_t *s)
{
    uint8_t ft[0x18];
    if (!make_ftext(s, ft)) return 0;
    void *cls = *(void **)((uint8_t *)tb + 0x10);
    void *fn = ((FindFunctionFn)AT(RVA_FIND_FUNCTION))(cls, T.settext_name, 1);
    if (!fn) return 0;
    uint8_t parms[0x40];
    memset(parms, 0, sizeof parms);
    memcpy(parms, ft, 0x18);
    o_pe(tb, fn, parms);
    return 1;
}

/* TextBlock::SetColorAndOpacity(FSlateColor): specified colour, alpha 1. */
static void set_tb_color(void *tb, const float rgb[3])
{
    static FNameI n_col;
    if (!n_col.idx) ((FNameCtorFn)AT(RVA_FNAME_CTOR))(&n_col, L"SetColorAndOpacity", 0);
    if (!n_col.idx) return;
    void *fn = ((FindFunctionFn)AT(RVA_FIND_FUNCTION))(*(void **)((uint8_t *)tb + 0x10), n_col, 1);
    if (!fn) { slog("text: SetColorAndOpacity not found"); return; }
    float parms[16];
    memset(parms, 0, sizeof parms);
    parms[0] = rgb[0]; parms[1] = rgb[1]; parms[2] = rgb[2]; parms[3] = 1.0f;   /* SpecifiedColor; ColorUseRule 0 = specified */
    o_pe(tb, fn, parms);
}

/* Current text of a TextBlock (GetText, then Conv_TextToString). 1 on success. */
static int get_textblock(void *tb, wchar_t *out, int cap)
{
    static FNameI n_get, n_conv;
    FNameCtorFn mk = (FNameCtorFn)AT(RVA_FNAME_CTOR);
    if (!n_get.idx) mk(&n_get, L"GetText", 0);
    if (!n_conv.idx) mk(&n_conv, L"Conv_TextToString", 0);
    out[0] = 0;
    if (!n_get.idx || !n_conv.idx || !T.ktl_cdo) return 0;
    void *fg = ((FindFunctionFn)AT(RVA_FIND_FUNCTION))(*(void **)((uint8_t *)tb + 0x10), n_get, 1);
    void *fc = ((FindFunctionFn)AT(RVA_FIND_FUNCTION))(*(void **)((uint8_t *)T.ktl_cdo + 0x10), n_conv, 1);
    if (!fg || !fc) return 0;
    uint8_t p1[0x40];
    memset(p1, 0, sizeof p1);
    o_pe(tb, fg, p1);
    uint8_t p2[0x60];
    memset(p2, 0, sizeof p2);
    memcpy(p2, p1, 0x18);                      /* InText */
    o_pe(T.ktl_cdo, fc, p2);
    FString *r = (FString *)(p2 + 0x18);       /* ReturnValue */
    if (!plausible_ptr(r->data) || r->num <= 0 || r->num > 4096) return 0;
    wcsncpy(out, r->data, (size_t)cap - 1);
    out[cap - 1] = 0;
    return 1;
}

static void text_scan(int force)
{
    uint8_t *objs = *(uint8_t **)AT(RVA_GUOBJ_OBJECTS);
    int32_t num = *(int32_t *)AT(RVA_GUOBJ_NUM);
    if (!plausible_ptr(objs) || num <= 0 || num > 8 * 1024 * 1024) return;
    if (force) T.napplied = 0;
    for (int32_t i = 0; i < num; i++) {
        uint8_t *item = objs + (size_t)i * 16;
        uint8_t *obj = *(uint8_t **)item;
        if (!obj || (*(int32_t *)(item + 8) & 0x20000000)) continue;
        const FNameI *nm = (const FNameI *)(obj + 0x18);
        if (nm->idx != T.build_text.idx && nm->idx != T.ktl_cdo_name.idx && nm->idx != T.overlay_name.idx &&
            !(NOTICE_ON && (nm->idx == T.header_name.idx || nm->idx == T.message_name.idx))) continue;
        const uint8_t *cls = *(const uint8_t *const *)(obj + 0x10);
        if (!plausible_ptr(cls)) continue;
        if (nm->idx == T.ktl_cdo_name.idx) {
            if (!T.ktl_cdo) { T.ktl_cdo = obj; slog("text: Default__KismetTextLibrary at %p", (void *)obj); }
            continue;
        }
        if (NOTICE_ON && T.ktl_cdo && (nm->idx == T.header_name.idx || nm->idx == T.message_name.idx)) {
            if (((const FNameI *)(cls + 0x18))->idx != T.textblock.idx) continue;
            if (*(const uint32_t *)(obj + 8) & 0x10) continue;
            if (in_list(T.notice_done, T.nnotice, obj)) continue;
            int is_hdr = nm->idx == T.header_name.idx;
            wchar_t cur[600];
            if (!get_textblock(obj, cur, 600)) continue;
            /* only the boot notice: its original wording */
            if (wcsncmp(cur, is_hdr ? L"Thank you for playing SOS" : L"SOS servers will permanently", is_hdr ? 25 : 28) != 0) continue;
            const wchar_t *txt = is_hdr ? g_notice_title : g_notice_body;
            if (!txt[0]) continue;
            set_textblock(obj, txt);
            set_tb_color(obj, is_hdr ? g_notice_tc : g_notice_bc);
            if (T.nnotice < 8) T.notice_done[T.nnotice++] = obj;
            slog("text: boot notice %s replaced (%p)", is_hdr ? "title" : "body", (void *)obj);
            continue;
        }
        if (nm->idx == T.build_text.idx && g_build_label[0]) {
            if (((const FNameI *)(cls + 0x18))->idx != T.textblock.idx) continue;
            if (*(const uint32_t *)(obj + 8) & 0x10) continue;                  /* class default object */
            if (in_list(T.applied, T.napplied, obj)) continue;
            if (set_textblock(obj, g_build_label)) {
                if (T.napplied < 16) T.applied[T.napplied++] = obj;
                slog("text: BuildVersionText %p set to \"%ls\"", (void *)obj, g_build_label);
            } else if (!T.logged_missing_ft) {
                T.logged_missing_ft = 1;
                slog("text: could not build an FText or find SetText (library %p)", T.ktl_cdo);
            }
        } else if (nm->idx == T.overlay_name.idx && cfg.hide_shutdown) {
            if (((const FNameI *)(cls + 0x18))->idx != T.overlay_cls.idx) continue;   /* the widget, not its package/class */
            if (*(const uint32_t *)(obj + 8) & 0x10) continue;
            /* widget -> WidgetTree -> owning UserWidget (the HUD) */
            uint8_t *tree = *(uint8_t **)(obj + 0x20);
            uint8_t *hud = plausible_ptr(tree) ? *(uint8_t **)(tree + 0x20) : NULL;
            if (!plausible_ptr(hud) || in_list(T.dismissed, T.ndismissed, hud)) continue;
            void *hcls = *(void **)(hud + 0x10);
            void *fn = ((FindFunctionFn)AT(RVA_FIND_FUNCTION))(hcls, T.ok_name, 1);
            if (!fn) {
                wchar_t cn[96];
                fname_str((uint8_t *)hcls + 0x18, cn, 96);
                slog("text: ShutdownOverlay found, owner class \"%ls\" has no OK handler", cn);
                if (T.ndismissed < 8) T.dismissed[T.ndismissed++] = hud;
                continue;
            }
            uint8_t parms[0x40];
            memset(parms, 0, sizeof parms);
            o_pe(hud, fn, parms);
            if (T.ndismissed < 8) T.dismissed[T.ndismissed++] = hud;
            slog("text: boot notice dismissed through its OK handler (HUD %p)", (void *)hud);
        }
    }
}


/* Development aid: log every live object whose name contains g_dump_pat (case-insensitive) with its class
   and outer, once, a few seconds after the main menu appears. */
static void dump_objects(void)
{
    uint8_t *objs = *(uint8_t **)AT(RVA_GUOBJ_OBJECTS);
    int32_t num = *(int32_t *)AT(RVA_GUOBJ_NUM);
    if (!plausible_ptr(objs) || num <= 0 || num > 8 * 1024 * 1024) return;
    wchar_t pat[64];
    wcscpy(pat, g_dump_pat);
    for (wchar_t *c = pat; *c; c++) *c = (wchar_t)towlower(*c);
    int hits = 0;
    for (int32_t i = 0; i < num && hits < 80; i++) {
        uint8_t *item = objs + (size_t)i * 16;
        uint8_t *obj = *(uint8_t **)item;
        if (!obj || (*(int32_t *)(item + 8) & 0x20000000)) continue;
        wchar_t nm[128], lo[128];
        fname_str(obj + 0x18, nm, 128);
        if (pat[0] == L'@') {      /* "@text": match TextBlocks by their current text instead of their name */
            const uint8_t *tc = *(const uint8_t *const *)(obj + 0x10);
            if (!plausible_ptr(tc) || ((const FNameI *)(tc + 0x18))->idx != T.textblock.idx) continue;
            if (*(const uint32_t *)(obj + 8) & 0x10) continue;
            wchar_t tx[600], tl[600];
            if (!get_textblock(obj, tx, 600)) continue;
            wcscpy(tl, tx);
            for (wchar_t *c = tl; *c; c++) *c = (wchar_t)towlower(*c);
            if (!wcsstr(tl, pat + 1)) continue;
            for (wchar_t *c = tx; *c; c++) if (*c == L'\n' || *c == L'\r') *c = L'|';
            const uint8_t *outer = *(const uint8_t *const *)(obj + 0x20);
            wchar_t on[96] = L"";
            if (plausible_ptr(outer)) fname_str(outer + 0x18, on, 96);
            slog("dump: TextBlock %p \"%ls\" outer \"%ls\" text \"%.300ls\"", (void *)obj, nm, on, tx);
            hits++;
            continue;
        }
        wcscpy(lo, nm);
        for (wchar_t *c = lo; *c; c++) *c = (wchar_t)towlower(*c);
        if (!wcsstr(lo, pat)) continue;
        wchar_t cn[96] = L"", on[96] = L"";
        const uint8_t *cls = *(const uint8_t *const *)(obj + 0x10);
        if (plausible_ptr(cls)) fname_str(cls + 0x18, cn, 96);
        const uint8_t *outer = *(const uint8_t *const *)(obj + 0x20);
        if (plausible_ptr(outer)) fname_str(outer + 0x18, on, 96);
        slog("dump: %p \"%ls\" class \"%ls\" outer \"%ls\" flags %08x", (void *)obj, nm, cn, on, *(const uint32_t *)(obj + 8));
        hits++;
    }
    slog("dump: %d match(es) for \"%ls\"", hits, g_dump_pat);
}

static void text_tick(void *fn)
{
    if (!g_build_label[0] && !cfg.hide_shutdown && !NOTICE_ON && !g_dump_pat[0]) return;
    if (GetCurrentThreadId() != *(DWORD *)AT(RVA_GAME_THREAD_ID)) return;
    /* FName lookup without creating: a name is only known once the asset that has it is loaded, so retry. */
    {
        FNameCtorFn mk = (FNameCtorFn)AT(RVA_FNAME_CTOR);
        FNameI *ns[] = { &T.overlay_cls, &T.build_text, &T.update_build, &T.textblock, &T.ktl_cdo_name, &T.conv_name, &T.settext_name,
                         &T.overlay_name, &T.ok_name, &T.header_name, &T.message_name };
        static const wchar_t *nn[] = { L"Overlay", L"BuildVersionText", L"UpdateBuildInfoText", L"TextBlock", L"Default__KismetTextLibrary",
                                       L"Conv_StringToText", L"SetText", L"ShutdownOverlay",
                                       L"BndEvt__ShutdownConfirmation_K2Node_ComponentBoundEvent_725_OnClicked__DelegateSignature", L"Header", L"Message" };
        for (int i = 0; i < 11; i++) {
            if (ns[i]->idx) continue;
            mk(ns[i], nn[i], 0);
            if (ns[i]->idx) slog("text: name \"%ls\" resolved (%d)", nn[i], ns[i]->idx);
        }
        T.init = 1;
    }
    ULONGLONG now = GetTickCount64();
    int force = (T.update_build.idx != 0 && fn && plausible_ptr(fn) &&
                 ((const FNameI *)((uint8_t *)fn + 0x18))->idx == T.update_build.idx);
    if (!force && now < T.next_scan) return;
    T.next_scan = now + 1000;
    text_scan(force);
    static int dumped; static ULONGLONG first;
    if (g_dump_pat[0] && !dumped) {
        if (!first) first = now;
        if (now - first > 6000) { dumped = 1; dump_objects(); }
    }
}


/* ------------------------------------------------------------------------ */
/* Console variables and FOV                                                 */
/* ------------------------------------------------------------------------ */
/* [Cvars] in the ini: "name=value" lines applied with IConsoleVariable::Set(value, SetByConsole) found
   through IConsoleManager::FindConsoleVariable (vtable slot 17; Set is slot 11 of the variable's vtable).
   This skips the console text path, whose Cheat check would refuse some variables. Applied once per
   map load on the game thread, a few seconds after the load. VerticalFOV / VerticalZoomFOV call the
   game's own exec functions of the same names on the player controller. */
#define RVA_CONSOLE_MGR 0x29D1E50u

static int g_cv_gen = -1;
static ULONGLONG g_cv_due;
static void *g_fov_done[8];
static int g_nfov_done;
static FNameI g_n_pc, g_n_vfov, g_n_vzfov;

static void cvars_apply(void)
{
    void **pm = (void **)AT(RVA_CONSOLE_MGR);
    void *mgr = *pm;
    if (!plausible_ptr(mgr)) { slog("cvars: console manager not ready"); return; }
    void **mvt = *(void ***)mgr;
    if (!plausible_ptr(mvt)) return;
    for (int i = 0; i < g_ncv; i++) {
        void *cv = ((void *(*)(void *, const wchar_t *))mvt[17])(mgr, g_cv[i].name);
        if (!plausible_ptr(cv)) { slog("cvars: %ls does not exist", g_cv[i].name); continue; }
        void **cvt = *(void ***)cv;
        if (!plausible_ptr(cvt)) continue;
        ((void (*)(void *, const wchar_t *, uint32_t))cvt[11])(cv, g_cv[i].val, 0x09000000u);
        slog("cvars: %ls = %ls (reads back %g)", g_cv[i].name, g_cv[i].val, (double)((float (*)(void *))cvt[13])(cv));
    }
}

static void fov_apply(void)
{
    uint8_t *objs = *(uint8_t **)AT(RVA_GUOBJ_OBJECTS);
    int32_t num = *(int32_t *)AT(RVA_GUOBJ_NUM);
    if (!plausible_ptr(objs) || num <= 0 || num > 8 * 1024 * 1024) return;
    FNameCtorFn mk = (FNameCtorFn)AT(RVA_FNAME_CTOR);
    if (!g_n_pc.idx) mk(&g_n_pc, L"SurvivalPlayerController_C", 0);
    if (!g_n_vfov.idx) mk(&g_n_vfov, L"VerticalFOV", 0);
    if (!g_n_vzfov.idx) mk(&g_n_vzfov, L"VerticalZoomFOV", 0);
    if (!g_n_pc.idx || !g_n_vfov.idx) return;
    for (int32_t i = 0; i < num; i++) {
        uint8_t *item = objs + (size_t)i * 16;
        uint8_t *obj = *(uint8_t **)item;
        if (!obj || (*(int32_t *)(item + 8) & 0x20000000)) continue;
        if (((const FNameI *)(obj + 0x18))->idx != g_n_pc.idx) continue;
        if (*(const uint32_t *)(obj + 8) & 0x10) continue;
        if (in_list(g_fov_done, g_nfov_done, obj)) continue;
        void *cls = *(void **)(obj + 0x10);
        if (!plausible_ptr(cls)) continue;
        struct { float v; float pad[7]; } parms;
        void *fn = ((FindFunctionFn)AT(RVA_FIND_FUNCTION))(cls, g_n_vfov, 1);
        if (g_vfov > 0 && fn) { memset(&parms, 0, sizeof parms); parms.v = g_vfov; o_pe(obj, fn, &parms); slog("fov: VerticalFOV %.1f on %p", g_vfov, (void *)obj); }
        fn = g_n_vzfov.idx ? ((FindFunctionFn)AT(RVA_FIND_FUNCTION))(cls, g_n_vzfov, 1) : NULL;
        if (g_vzfov > 0 && fn) { memset(&parms, 0, sizeof parms); parms.v = g_vzfov; o_pe(obj, fn, &parms); slog("fov: VerticalZoomFOV %.1f on %p", g_vzfov, (void *)obj); }
        if (g_nfov_done < 8) g_fov_done[g_nfov_done++] = obj;
    }
}

static void game_tick(void)
{
    if (!g_ncv && g_vfov <= 0 && g_vzfov <= 0) return;
    if (GetCurrentThreadId() != *(DWORD *)AT(RVA_GAME_THREAD_ID)) return;
    ULONGLONG now = GetTickCount64();
    LONG gen = g_map_gen;
    if (gen != g_cv_gen) { g_cv_gen = gen; g_cv_due = now + 4000; g_nfov_done = 0; }
    if (g_cv_due && now >= g_cv_due) {
        g_cv_due = 0;
        if (g_ncv) cvars_apply();
    }
    static ULONGLONG next_fov;
    if ((g_vfov > 0 || g_vzfov > 0) && now >= next_fov) { next_fov = now + 2000; fov_apply(); }
}

static void h_process_event(void *self, void *fn, void *parms)
{
    if (g_play_flag) play_tick(self);
    o_pe(self, fn, parms);
    if (g_build_label[0] || cfg.hide_shutdown || NOTICE_ON || g_dump_pat[0]) text_tick(fn);
    if (g_ncv || g_vfov > 0 || g_vzfov > 0) game_tick();
}


/* ------------------------------------------------------------------------ */
/* Unreleased cosmetics: Ronin set + one Cynic beard                         */
/* ------------------------------------------------------------------------ */
/* Steam DLC ownership for cosmetics: IsEntitlementAvailable (0x140166D90) and IsDLCInstalled
   (0x140166CD0) both start with 40 53 48 83 EC 40 and return bool. The stub below answers true
   without calling the original, so every DLC-gated outfit, gesture and the name plate unlock. */
#define RVA_ENTITLEMENT 0x0166D90
#define RVA_DLC_INSTALLED 0x0166CD0
static uint8_t h_owned(void *a, void *b) { (void)a; (void)b; return 1; }

/* ------------------------------------------------------------------------ */
/* CustomizationLibrary per-item availability check (0x140166970):
   bool (void *ctx, const TSubclassOf *asset). *asset is the asset's UClass; the class default
   object is at class+0x100 and its EAssetStatus byte at +0x3C1 (3 = Released). The check lets only
   Released items through. For a short allow-list of asset classes the status byte is set to 3 just
   for the duration of the call and restored afterwards. Everything else is untouched.
   Entitlement (Steam DLC) and role checks still run unchanged. */
#define RVA_AVAIL_CHECK 0x0166970
typedef uint8_t (*AvailFn)(void *ctx, void *asset);
static AvailFn o_avail;
static struct { int32_t idx; int allow; } g_avail_cache[2048];
static int g_avail_cache_n;

static int avail_allowed(const uint8_t *cls)
{
    int32_t idx = *(const int32_t *)(cls + 0x18);
    for (int i = 0; i < g_avail_cache_n; i++)
        if (g_avail_cache[i].idx == idx) return g_avail_cache[i].allow;
    wchar_t nm[96];
    nm[0] = 0;
    fname_str(cls + 0x18, nm, 96);
    int allow = !wcsncmp(nm, L"CA_MaleRonin_", 13) || !wcsncmp(nm, L"CA_MaleCynic_FacialHair_A", 25);
    if (allow) slog("unreleased cosmetics: allowing %ls", nm);
    if (g_avail_cache_n < 2048) { g_avail_cache[g_avail_cache_n].idx = idx; g_avail_cache[g_avail_cache_n].allow = allow; g_avail_cache_n++; }
    return allow;
}

static uint8_t h_avail(void *ctx, void *asset)
{
    uint8_t *cls = asset && plausible_ptr(asset) ? *(uint8_t **)asset : NULL;
    if (cls && plausible_ptr(cls) && avail_allowed(cls)) {
        uint8_t *cdo = *(uint8_t **)(cls + 0x100);
        if (plausible_ptr(cdo)) {
            uint8_t old = cdo[0x3C1];
            if (old == 1 || old == 2) {
                cdo[0x3C1] = 3;
                uint8_t r = o_avail(ctx, asset);
                cdo[0x3C1] = old;
                return r;
            }
        }
    }
    return o_avail(ctx, asset);
}

/* Replace "call [rip+disp]" (FF 15 disp32) at the given RVA with "call thunk; nop",
   if it really targets the expected IAT slot. The thunk jumps to `hook`. */
static int patch_call_site(uint8_t **cursor, uint32_t rva, void **slot, void *hook, const char *what)
{
    uint8_t *site = g_base + rva;
    if (!slot || !*cursor) return 0;
    if (site[0] != 0xFF || site[1] != 0x15) { slog("%s: call site +%07x has unexpected bytes", what, rva); return 0; }
    int32_t disp = *(int32_t *)(site + 2);
    if ((void **)(site + 6 + disp) != slot) { slog("%s: call site +%07x targets another slot", what, rva); return 0; }
    uint8_t *thunk = *cursor;
    uint64_t to = (uint64_t)(uintptr_t)hook;
    thunk[0] = 0x48; thunk[1] = 0xB8; memcpy(thunk + 2, &to, 8); thunk[10] = 0xFF; thunk[11] = 0xE0;
    FlushInstructionCache(GetCurrentProcess(), thunk, 16);
    int64_t rel = (int64_t)(thunk - (site + 5));
    int32_t rel32 = (int32_t)rel;
    uint8_t code[6] = { 0xE8, 0, 0, 0, 0, 0x90 };
    memcpy(code + 1, &rel32, 4);
    if (rel != rel32 || !write_code(site, code, 6)) { slog("%s: call-site patch failed", what); return 0; }
    *cursor += 16;
    slog("call site hooked: %s at +%07x", what, rva);
    return 1;
}

/* ------------------------------------------------------------------------ */
/* Install                                                                   */
/* ------------------------------------------------------------------------ */

static void install(void)
{
    g_base = (uint8_t *)GetModuleHandleW(NULL);
    if (!identify()) return;
    slog("sos_client loaded into SOS: Classic at %p (backend %ls, OverrideEndpoints=%d, Overlay=%d, "
         "ShowButtonEverywhere=%d)", g_base, g_backend_w, cfg.override_endpoints, cfg.overlay, cfg.show_everywhere);

    uint8_t *page = alloc_near(g_base, 4096);
    if (!page) { slog("no memory near the exe for hook thunks; nothing hooked"); return; }
    uint8_t *cursor = page;

    if (cfg.override_endpoints) {
        /* mov [rsp+10h],rbx; mov [rsp+18h],rbp; mov [rsp+20h],rsi */
        static const uint8_t p_get[15] = { 0x48, 0x89, 0x5C, 0x24, 0x10, 0x48, 0x89, 0x6C,
                                           0x24, 0x18, 0x48, 0x89, 0x74, 0x24, 0x20 };
        build_overrides();
        o_getstring = (GetStringFn)hook_entry(&cursor, RVA_GETSTRING, p_get, 15, (void *)h_getstring,
                                              "FConfigCacheIni::GetString");
        if (!o_getstring) slog("endpoint override unavailable");
    }

    {
        /* push rbx; push rbp; push rsi; push rdi (REX-prefixed rbx) */
        static const uint8_t p_log[5] = { 0x40, 0x53, 0x55, 0x56, 0x57 };
        if (cfg.game_log) {
            wchar_t path[MAX_PATH];
            _snwprintf(path, MAX_PATH - 1, L"%lssos_client_game_%lu.log", g_dir, GetCurrentProcessId());
            path[MAX_PATH - 1] = 0;
            g_game_log = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS,
                                     FILE_ATTRIBUTE_NORMAL, NULL);
            if (g_game_log != INVALID_HANDLE_VALUE) slog("game log -> %ls", path);
        }
        void *t = hook_entry(&cursor, RVA_LOG_FN, p_log, 5, (void *)log_hook, "FMsg::Logf_Internal");
        if (t) g_log_tramp = t;
        else {
            slog("map tracking unavailable");
            if (g_game_log != INVALID_HANDLE_VALUE) { CloseHandle(g_game_log); g_game_log = INVALID_HANDLE_VALUE; }
        }
    }

    {
        /* The game calls these through its IAT from exactly one site each
           (found by scanning .text for FF 15 xrefs). Patch the IAT slot and
           also the call site itself, so a cached pointer cannot bypass us. */
        void **slot_send = NULL, **slot_open = NULL, **slot_read = NULL, **slot_add = NULL;
        o_send = (HttpSendRequestWFn)iat_hook("WININET.dll", "HttpSendRequestW", NULL, &slot_send);
        o_openreq = (HttpOpenRequestWFn)iat_hook("WININET.dll", "HttpOpenRequestW", NULL, &slot_open);
        o_readfile = (InternetReadFileFn)iat_hook("WININET.dll", "InternetReadFile", NULL, &slot_read);
        o_addhdr = (HttpAddRequestHeadersWFn)iat_hook("WININET.dll", "HttpAddRequestHeadersW", NULL, &slot_add);
        slog("WinInet IAT slots: send=%p (rva %lx) open=%p read=%p addhdr=%p (expected send rva 1f21d98)",
             (void *)slot_send, slot_send ? (unsigned long)((uint8_t *)slot_send - g_base) : 0UL,
             (void *)slot_open, (void *)slot_read, (void *)slot_add);
        if (o_send) {
            iat_hook("WININET.dll", "HttpSendRequestW", (void *)h_send, NULL);
            slog("IAT hook: HttpSendRequestW");
            patch_call_site(&cursor, 0x0AAAC43u, slot_send, (void *)h_send, "HttpSendRequestW");
        } else slog("HttpSendRequestW not imported; token capture unavailable");
        if (o_openreq) {
            iat_hook("WININET.dll", "HttpOpenRequestW", (void *)h_openreq, NULL);
            patch_call_site(&cursor, 0x0AAAAE5u, slot_open, (void *)h_openreq, "HttpOpenRequestW");
        }
        if (o_readfile) {
            iat_hook("WININET.dll", "InternetReadFile", (void *)h_readfile, NULL);
            patch_call_site(&cursor, 0x0AA66D4u, slot_read, (void *)h_readfile, "InternetReadFile");
        }
        if (o_addhdr) {
            iat_hook("WININET.dll", "HttpAddRequestHeadersW", (void *)h_addhdr, NULL);
            slog("IAT hook: HttpAddRequestHeadersW");
        }
    }

    {
        /* mov [rsp+8],rbx; mov [rsp+10h],rbp; mov [rsp+18h],rsi */
        static const uint8_t p_ws[15] = { 0x48, 0x89, 0x5C, 0x24, 0x08, 0x48, 0x89, 0x6C, 0x24, 0x10, 0x48, 0x89, 0x74, 0x24, 0x18 };
        o_ws_connect = (WsConnectFn)hook_entry(&cursor, RVA_WS_CONNECT, p_ws, 15, (void *)h_ws_connect,
                                               "OutpostWebSocket connect");
    }

    if (cfg.unlock_dlc) {
        static const uint8_t p_dlc[6] = { 0x40, 0x53, 0x48, 0x83, 0xEC, 0x40 };
        void *a = hook_entry(&cursor, RVA_ENTITLEMENT, p_dlc, 6, (void *)h_owned, "IsEntitlementAvailable");
        void *b = hook_entry(&cursor, RVA_DLC_INSTALLED, p_dlc, 6, (void *)h_owned, "IsDLCInstalled");
        if (!a || !b) slog("DLC cosmetics unlock incomplete");
    }

    if (cfg.unlock_unreleased) {
        /* mov [rsp+10h],rbx; mov [rsp+18h],rbp */
        static const uint8_t p_av[10] = { 0x48, 0x89, 0x5C, 0x24, 0x10, 0x48, 0x89, 0x6C, 0x24, 0x18 };
        o_avail = (AvailFn)hook_entry(&cursor, RVA_AVAIL_CHECK, p_av, 10, (void *)h_avail,
                                      "CustomizationLibrary availability check");
        if (!o_avail) slog("unreleased cosmetics unavailable");
    }

    if (cfg.auto_play || g_build_label[0] || cfg.hide_shutdown || NOTICE_ON || g_dump_pat[0] || g_ncv || g_vfov > 0 || g_vzfov > 0) {
        /* push rbp; push rsi; push rdi; push r12; push r13; push r14; push r15 (REX on rbp) */
        static const uint8_t p_pe[12] = { 0x40, 0x55, 0x56, 0x57, 0x41, 0x54, 0x41, 0x55, 0x41, 0x56, 0x41, 0x57 };
        o_pe = (ProcessEventFn)hook_entry(&cursor, RVA_PROCESS_EVENT, p_pe, 12, (void *)h_process_event,
                                          "UObject::ProcessEvent");
        if (!o_pe) slog("play trigger unavailable");
    }

    if (cfg.overlay && g_log_tramp) {
        /* mov [rsp+8],rbx; mov [rsp+10h],edx; push rdi */
        static const uint8_t p_present[10] = { 0x48, 0x89, 0x5C, 0x24, 0x08, 0x89, 0x54, 0x24, 0x10, 0x57 };
        o_present = (PresentFn)hook_entry(&cursor, RVA_PRESENT, p_present, 10, (void *)h_present,
                                          "FD3D11Viewport inner present");
        if (!o_present) slog("overlay unavailable");
    } else if (cfg.overlay) {
        slog("overlay needs map tracking; overlay off");
    }
    {
        /* Pass-through check: does the real XInput report a connected pad? (The proxy never invents one.) */
        int pads = 0;
        for (DWORD i = 0; i < 4; i++) {
            uint8_t st[16];
            if (p_XInputGetState && ((DWORD (WINAPI *)(DWORD, void *))p_XInputGetState)(i, st) == 0) pads++;
        }
        slog("xinput: real XInput %s, %d gamepad(s) connected", g_real_xinput ? "loaded" : "NOT loaded (stub)", pads);
    }
    slog("ready");
}

#ifdef SOS_REPORT_TEST
/* Test build only (-DSOS_REPORT_TEST): drives the report worker functions synchronously from a small exe,
   without the game. The token comes from the env var SOS_TEST_TOKEN. */
__declspec(dllexport) int sos_test_init(const char *backend)
{
    InitializeCriticalSection(&g_log_lock);
    InitializeCriticalSection(&g_ui_lock);
    InitializeCriticalSection(&g_tok_lock);
    wchar_t wb[256];
    u8w(backend, wb, 256);
    parse_backend(wb);
    const char *t = getenv("SOS_TEST_TOKEN");
    if (t) snprintf(g_token, sizeof g_token, "%s", t);
    g_wh_session = WinHttpOpen(L"sos_client/1.0", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME,
                               WINHTTP_NO_PROXY_BYPASS, 0);
    if (g_wh_session) WinHttpSetTimeouts(g_wh_session, 3000, 3000, 5000, 5000);
    return g_wh_session != NULL;
}
__declspec(dllexport) int sos_test_report(const char *target, const char *reason, const char *link, wchar_t *status_out)
{
    int st = send_report(target, reason, link);
    EnterCriticalSection(&g_ui_lock);
    wcscpy(status_out, U.status);
    LeaveCriticalSection(&g_ui_lock);
    return st;
}
__declspec(dllexport) int sos_test_accounts(void)
{
    do_accounts();
    return U.rcount;
}
__declspec(dllexport) int sos_test_account(int i, char *id, wchar_t *name)
{
    if (i < 0 || i >= U.rcount) return 0;
    strcpy(id, U.racc[i].id);
    wcscpy(name, U.racc[i].name);
    return 1;
}
__declspec(dllexport) int sos_test_link(const wchar_t *in, char *out8)
{
    wchar_t d[512];
    return clip_to_link(in, out8, 1700, d, 512);
}
__declspec(dllexport) int sos_test_clip(char *out8, wchar_t *status_out)
{
    do_paste();
    EnterCriticalSection(&g_ui_lock);
    wcscpy(status_out, U.status);
    strcpy(out8, U.rlink);
    LeaveCriticalSection(&g_ui_lock);
    return out8[0] != 0;
}
#endif

#ifdef SOS_CORE
#ifndef SOS_CORE_VERSION
#define SOS_CORE_VERSION 1
#endif
__declspec(dllexport) const unsigned long sos_core_version = SOS_CORE_VERSION;

/* Called by the loader (from its DllMain, before the game has read any config) with the real XInputGetState. */
__declspec(dllexport) int sos_core_start(HMODULE self, void *real_xinput_get_state)
{
    InitializeCriticalSection(&g_log_lock);
    InitializeCriticalSection(&g_ui_lock);
    InitializeCriticalSection(&g_tok_lock);
    InitializeCriticalSection(&g_game_lock);
    InitializeCriticalSection(&g_trk_lock);
    p_XInputGetState = real_xinput_get_state;
    g_real_xinput = real_xinput_get_state ? self : NULL;   /* only used for the log line */
    load_config(self);
    install();
    upd_start();   /* independent of the game build: a fix for a patched game must still arrive */
    return 1;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) DisableThreadLibraryCalls(inst);
    return TRUE;
}
#else
BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        InitializeCriticalSection(&g_log_lock);
        InitializeCriticalSection(&g_ui_lock);
        InitializeCriticalSection(&g_tok_lock);
        InitializeCriticalSection(&g_game_lock);
        InitializeCriticalSection(&g_trk_lock);
        load_real_xinput(inst);
        load_config(inst);
        install();
    }
    return TRUE;
}
#endif
