/*
 * sos_host: version.dll proxy that gives the SOS shipping client a working
 * UWorld::Listen, so one copy of the game can host a listen server.
 *
 * Both shipping builds (main, Steam app 619080, and SOS: Classic, app 802240)
 * were compiled with UWorld::Listen stubbed to "xor al,al; ret". UEngine::LoadMap
 * calls it once when the URL has ?listen. This DLL redirects that one CALL to
 * HostListen() below, a reimplementation of UE 4.12.5 UWorld::Listen built from
 * functions that are still in the exe (the same ones UGameInstance::PlayReplay
 * uses to create the demo net driver).
 *
 * The game loads version.dll from its own folder before the system copy, so
 * dropping this file next to the exe is enough. Every export forwards to the
 * real %SystemRoot%\System32\version.dll. If the exe is not one of the known
 * builds, nothing is patched.
 *
 * See docs/HOSTING_DLL.md.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdarg.h>
#include <wchar.h>

/* ------------------------------------------------------------------------ */
/* version.dll forwarding                                                    */
/* ------------------------------------------------------------------------ */

#define VERSION_EXPORTS(X) \
    X(GetFileVersionInfoA) X(GetFileVersionInfoByHandle) X(GetFileVersionInfoExA) \
    X(GetFileVersionInfoExW) X(GetFileVersionInfoSizeA) X(GetFileVersionInfoSizeExA) \
    X(GetFileVersionInfoSizeExW) X(GetFileVersionInfoSizeW) X(GetFileVersionInfoW) \
    X(VerFindFileA) X(VerFindFileW) X(VerInstallFileA) X(VerInstallFileW) \
    X(VerLanguageNameA) X(VerLanguageNameW) X(VerQueryValueA) X(VerQueryValueW)

/* Each export is a tail jump through a pointer filled in at load time. */
#define DECLARE_FWD(n) void *p_##n = NULL;
VERSION_EXPORTS(DECLARE_FWD)
#define ASM_FWD(n) ".globl " #n "\n" #n ":\n jmp *p_" #n "(%rip)\n"
__asm__(".text\n" VERSION_EXPORTS(ASM_FWD));

static void load_real_version(void)
{
    wchar_t path[MAX_PATH];
    UINT n = GetSystemDirectoryW(path, MAX_PATH);
    if (n == 0 || n > MAX_PATH - 16) return;
    wcscat(path, L"\\version.dll");
    HMODULE h = LoadLibraryW(path);
    if (!h) return;
#define RESOLVE_FWD(n) p_##n = (void *)GetProcAddress(h, #n);
    VERSION_EXPORTS(RESOLVE_FWD)
}

/* ------------------------------------------------------------------------ */
/* Config and logging                                                        */
/* ------------------------------------------------------------------------ */

static struct {
    int enable_listen;        /* 1: replace the Listen stub */
    int port;                 /* 0: keep the URL port (7777 from [URL] Port) */
    int unfilter_cmdline;     /* 1: NOP the shipping command-line allow-list */
    int steam_sockets;        /* 0: force plain IP sockets on SteamNetDriver */
    int login_timeout;        /* >0: set blackbird.LoginPendingTimeout (main only) */
    int game_log;             /* 1: mirror every UE_LOG line to sos_game_<pid>.log */
    int fix_join_state;       /* 1: send ClientGotoState(Playing) after ClientRetryClientRestart */
    int block_eliminate;      /* 1: skip UTeamManager::EliminatePlayer (test switch) */
} cfg = { 1, 0, 1, 0, 0, 1, 1, 0 };

static wchar_t g_dir[MAX_PATH];
static wchar_t g_log_path[MAX_PATH];
static CRITICAL_SECTION g_log_lock;

static void hlog(const char *fmt, ...)
{
    char buf[1024];
    SYSTEMTIME t;
    GetLocalTime(&t);
    int n = snprintf(buf, sizeof buf, "[%02d:%02d:%02d.%03d][%lu] ",
                     t.wHour, t.wMinute, t.wSecond, t.wMilliseconds, GetCurrentProcessId());
    va_list ap;
    va_start(ap, fmt);
    n += vsnprintf(buf + n, sizeof buf - n - 2, fmt, ap);
    va_end(ap);
    if (n > (int)sizeof buf - 2) n = sizeof buf - 2;
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

static void load_config(HMODULE self)
{
    GetModuleFileNameW(self, g_dir, MAX_PATH);
    wchar_t *slash = wcsrchr(g_dir, L'\\');
    if (slash) slash[1] = 0;

    wchar_t ini[MAX_PATH];
    _snwprintf(ini, MAX_PATH, L"%lssos_host.ini", g_dir);
    ini[MAX_PATH - 1] = 0;

    cfg.enable_listen    = GetPrivateProfileIntW(L"Host", L"EnableListen", cfg.enable_listen, ini);
    cfg.port             = GetPrivateProfileIntW(L"Host", L"Port", cfg.port, ini);
    cfg.unfilter_cmdline = GetPrivateProfileIntW(L"Host", L"UnfilterCommandLine", cfg.unfilter_cmdline, ini);
    cfg.steam_sockets    = GetPrivateProfileIntW(L"Host", L"SteamSockets", cfg.steam_sockets, ini);
    cfg.login_timeout    = GetPrivateProfileIntW(L"Host", L"LoginPendingTimeout", cfg.login_timeout, ini);
    cfg.game_log         = GetPrivateProfileIntW(L"Host", L"GameLog", cfg.game_log, ini);
    cfg.fix_join_state   = GetPrivateProfileIntW(L"Host", L"FixJoinState", cfg.fix_join_state, ini);
    cfg.block_eliminate  = GetPrivateProfileIntW(L"Host", L"BlockEliminate", cfg.block_eliminate, ini);

    wchar_t log_name[MAX_PATH];
    GetPrivateProfileStringW(L"Host", L"LogFile", L"sos_host.log", log_name, MAX_PATH, ini);
    if (log_name[0] && wcscmp(log_name, L"-") != 0) {
        if (wcschr(log_name, L':') || log_name[0] == L'\\')
            wcsncpy(g_log_path, log_name, MAX_PATH - 1);
        else
            _snwprintf(g_log_path, MAX_PATH - 1, L"%ls%ls", g_dir, log_name);
    }
}

/* ------------------------------------------------------------------------ */
/* Per-build address tables (RVAs from image base 0x140000000)               */
/* ------------------------------------------------------------------------ */

typedef struct {
    const char *name;
    uint32_t size_of_image;     /* OptionalHeader.SizeOfImage */
    uint32_t timestamp;         /* FileHeader.TimeDateStamp */
    uint32_t listen_call;       /* CALL Listen-stub; TEST AL,AL in UEngine::LoadMap */
    uint32_t listen_stub;       /* 32 C0 C3 */
    uint32_t filter_call;       /* CALL filter in FCommandLine::Set */
    uint32_t gengine;           /* UEngine* GEngine */
    uint32_t fname_ctor;        /* FName* FName(FName*, const TCHAR*, EFindName) */
    uint32_t create_driver;     /* bool UEngine::CreateNamedNetDriver(UWorld*, FName, FName) */
    uint32_t find_driver;       /* UNetDriver* UEngine::FindNamedNetDriver(UWorld*, FName) */
    uint32_t destroy_driver;    /* void UEngine::DestroyNamedNetDriver(UWorld*, FName) */
    uint32_t set_world;         /* void UNetDriver::SetWorld(UWorld*) */
    uint32_t steam_listen;      /* USteamNetDriver::InitListen */
    uint32_t ip_listen;         /* UIpNetDriver::InitListen */
    uint32_t mem_free;          /* FMemory::Free */
    uint32_t login_timeout_cvar;/* float* behind blackbird.LoginPendingTimeout, 0 if absent */
    uint32_t log_fn;            /* FMsg::Logf_Internal(File, Line, Category, Verbosity, Fmt, ...) */
    uint32_t fname_tostring;    /* FString* FName::ToString(const FName*, FString*) */
    /* Join flow (main build only; 0 = not mapped) */
    uint32_t restart_player;    /* void AShooterGameMode::RestartPlayer(GM*, AController*) */
    uint32_t server_restart;    /* void APlayerController::ServerRestartPlayer_Implementation(PC*) */
    uint32_t client_retry;      /* void PC::ClientRetryClientRestart(PC*, APawn*) RPC sender */
    uint32_t client_goto_state; /* void PC::ClientGotoState(PC*, FName) RPC sender */
    uint32_t eliminate;         /* UTeamManager::EliminatePlayer(TM*, APlayerState*) */
} GameBuild;

static const GameBuild k_builds[] = {
    {
        "SOS main (619080)", 48713728, 0x5bc0f502,
        0x147cef4, 0x0188b70, 0x047504f,
        0x2bf5818, 0x04d3280, 0x146a1c0, 0x1471a30, 0x146c3b0, 0x1258c90,
        0x1aeafc0, 0x0eb75b0, 0x040d1b0, 0x2a4b0b0,
        0x04a9f30, 0x04de7a0,
        0x01cd360, 0x01c7370, 0x14e9160, 0x14e8d20, 0x01f0600,
    },
    {
        "SOS: Classic (802240)", 48156672, 0x5b971052,
        0x1417674, 0x0b6edf0, 0x041578f,
        0x2b766a0, 0x0472c50, 0x14048e0, 0x140c1d0, 0x1406ad0, 0x11f3aa0,
        0x1a7ec40, 0x0e542b0, 0x03acc40, 0,
        0x044a500, 0x047e090,
        0, 0, 0, 0, 0,
    },
};

/* Engine layout, identical in both builds (UE 4.12.5). */
#define UWORLD_NOTIFY      0x28   /* FNetworkNotify base of UWorld */
#define UWORLD_NETDRIVER   0x38   /* UNetDriver* UWorld::NetDriver */
#define NETDRIVER_STEAM_PASSTHROUGH 0x390 /* USteamNetDriver::bIsPassthrough */
#define VTBL_INITLISTEN    0x1F8  /* UNetDriver::InitListen */
#define FURL_PORT          0x20
#define FURL_MAP           0x28

typedef struct { uint64_t v; } FName;
typedef struct { wchar_t *data; int32_t num; int32_t max; } FString;

typedef FName *(*FNameCtorFn)(FName *, const wchar_t *, int);
typedef uint8_t (*CreateDriverFn)(void *engine, void *world, FName name, FName def);
typedef void *(*FindDriverFn)(void *engine, void *world, FName name);
typedef void (*DestroyDriverFn)(void *engine, void *world, FName name);
typedef void (*SetWorldFn)(void *driver, void *world);
typedef uint8_t (*InitListenFn)(void *driver, void *notify, void *url, uint8_t reuse, FString *err);
typedef void (*FreeFn)(void *);

static const GameBuild *g_build;
static uint8_t *g_base;

#define AT(rva) ((void *)(g_base + (rva)))

/* ------------------------------------------------------------------------ */
/* UWorld::Listen replacement                                                */
/* ------------------------------------------------------------------------ */

static void fstring_log_free(const char *what, FString *s)
{
    if (s->data) {
        hlog("%s: %ls", what, s->num ? s->data : L"");
        ((FreeFn)AT(g_build->mem_free))(s->data);
        s->data = NULL;
    }
}

static void apply_login_timeout(void)
{
    if (cfg.login_timeout <= 0 || !g_build->login_timeout_cvar) return;
    float *value = *(float **)AT(g_build->login_timeout_cvar);
    if (!value) {
        hlog("LoginPendingTimeout cvar not registered yet");
        return;
    }
    hlog("blackbird.LoginPendingTimeout %.1f -> %d", *value, cfg.login_timeout);
    *value = (float)cfg.login_timeout;
}

/* Called from UEngine::LoadMap in place of UWorld::Listen(FURL&). */
static uint8_t HostListen(uint8_t *world, uint8_t *url)
{
    FString *map = (FString *)(url + FURL_MAP);
    hlog("Listen(%ls) requested, port %d", (map->num && map->data) ? map->data : L"?",
         *(int32_t *)(url + FURL_PORT));

    apply_login_timeout();

    if (!cfg.enable_listen) {
        hlog("EnableListen=0, refusing (stock behaviour)");
        return 0;
    }
    if (*(void **)(world + UWORLD_NETDRIVER)) {
        hlog("World already has a net driver, refusing (NetDriverAlreadyExists)");
        return 0;
    }

    void *engine = *(void **)AT(g_build->gengine);
    if (!engine) {
        hlog("GEngine is null");
        return 0;
    }

    FName name;
    ((FNameCtorFn)AT(g_build->fname_ctor))(&name, L"GameNetDriver", 1 /* FNAME_Add */);

    void *driver = NULL;
    if (((CreateDriverFn)AT(g_build->create_driver))(engine, world, name, name)) {
        driver = ((FindDriverFn)AT(g_build->find_driver))(engine, world, name);
        *(void **)(world + UWORLD_NETDRIVER) = driver;
        if (driver) ((SetWorldFn)AT(g_build->set_world))(driver, world);
    }
    if (!driver) {
        hlog("CreateNamedNetDriver(GameNetDriver) failed (see the game log)");
        return 0;
    }

    if (cfg.port > 0 && cfg.port < 65536) *(int32_t *)(url + FURL_PORT) = cfg.port;

    void **vtbl = *(void ***)driver;
    InitListenFn init_listen = (InitListenFn)vtbl[VTBL_INITLISTEN / 8];
    const char *kind = "net driver";
    if ((void *)init_listen == AT(g_build->steam_listen)) {
        kind = "SteamNetDriver";
        if (!cfg.steam_sockets) {
            /* Same as the ?bIsLanMatch branch of USteamNetDriver::InitListen:
               plain IP sockets, so clients can join by address. */
            *(uint8_t *)((uint8_t *)driver + NETDRIVER_STEAM_PASSTHROUGH) = 1;
            init_listen = (InitListenFn)AT(g_build->ip_listen);
            kind = "SteamNetDriver (IP passthrough)";
        }
    } else if ((void *)init_listen == AT(g_build->ip_listen)) {
        kind = "IpNetDriver";
    }

    FString err = { 0 };
    uint8_t ok = init_listen(driver, world + UWORLD_NOTIFY, url, 0, &err);
    if (!ok) {
        fstring_log_free("InitListen failed", &err);
        ((DestroyDriverFn)AT(g_build->destroy_driver))(engine, world, name);
        *(void **)(world + UWORLD_NETDRIVER) = NULL;
        return 0;
    }
    fstring_log_free("InitListen message", &err);
    hlog("Listening with %s on port %d", kind, *(int32_t *)(url + FURL_PORT));
    return 1;
}

/* ------------------------------------------------------------------------ */
/* UE_LOG mirror                                                             */
/* ------------------------------------------------------------------------ */
/* The shipping client writes no SOS.log in these runs, so the DLL copies every
   line that reaches FMsg::Logf_Internal into sos_game_<pid>.log. The function
   entry (push rbx/rbp/rsi/rdi, 5 bytes) jumps to log_hook, which records the
   line and continues in a trampoline holding the displaced bytes. */

typedef FString *(*FNameToStringFn)(const FName *, FString *);

static HANDLE g_game_log = INVALID_HANDLE_VALUE;
static CRITICAL_SECTION g_game_lock;
void *g_log_tramp;   /* referenced from log_hook */

void log_capture(uint64_t *frame)
{
    /* frame[0] = return address, frame[1..4] = homed rcx rdx r8 r9,
       frame[5] = format, frame[6..] = variadic arguments. */
    static const char *const verb_names[] = {
        "", "Fatal", "Error", "Warning", "Display", "Log", "Verbose", "VeryVerbose" };
    const FName *category = (const FName *)frame[3];
    unsigned verbosity = (unsigned)frame[4] & 0xF;
    const wchar_t *fmt = (const wchar_t *)frame[5];
    if (!fmt || g_game_log == INVALID_HANDLE_VALUE) return;

    DWORD saved_error = GetLastError();
    wchar_t msg[2048];
    int n = _vsnwprintf(msg, 2047, fmt, (va_list)(frame + 6));
    if (n < 0) n = 2047;
    msg[n] = 0;

    wchar_t cat[64] = L"?";
    if (category) {
        FString fs = { 0 };
        ((FNameToStringFn)AT(g_build->fname_tostring))(category, &fs);
        if (fs.data) {
            wcsncpy(cat, fs.data, 63);
            cat[63] = 0;
            ((FreeFn)AT(g_build->mem_free))(fs.data);
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
/* Join flow: release a joiner stuck in client-side LoginPending              */
/* ------------------------------------------------------------------------ */
/* The host's first RestartPlayer for a joiner fails IsLoggedIn (app data not
   ready) and sends ClientGotoState(LoginPending). The retry spawns the pawn,
   but if ClientRestart reaches the client before the pawn has replicated, the
   client asks ServerRestartPlayer again; the server's copy is already Playing,
   so it only sends ClientRetryClientRestart(Pawn), which sets the pawn on the
   client but not its state. After that call we also send
   ClientGotoState(Playing), which is what the client is missing. */

#define PC_PAWN          0x388   /* APawn* AController::Pawn */
#define PC_PLAYERSTATE   0x3a0   /* APlayerState* */
#define PC_STATENAME     0x3d0   /* FName AController::StateName */
#define PS_PLAYERID      0x3a8   /* int32 APlayerState::PlayerId */
#define ACTOR_ROLE       0x110   /* uint8 AActor::Role (3 = authority) */
#define NAME_PLAYING     0x140ull

typedef void (*RestartPlayerFn)(void *gm, uint8_t *pc);
typedef void (*ServerRestartFn)(uint8_t *pc);
typedef void (*ClientRetryFn)(uint8_t *pc, void *pawn);
typedef void (*GotoStateFn)(uint8_t *pc, uint64_t name);
typedef uint64_t (*EliminateFn)(void *tm, uint8_t *ps);

static RestartPlayerFn o_restart_player;
static ServerRestartFn o_server_restart;
static ClientRetryFn o_client_retry;
static EliminateFn o_eliminate;

static int pc_player_id(uint8_t *pc)
{
    uint8_t *ps = *(uint8_t **)(pc + PC_PLAYERSTATE);
    return ps ? *(int32_t *)(ps + PS_PLAYERID) : -1;
}

static void h_restart_player(void *gm, uint8_t *pc)
{
    o_restart_player(gm, pc);
    if (pc)
        hlog("RestartPlayer: player %d state %#x pawn %p", pc_player_id(pc),
             *(uint32_t *)(pc + PC_STATENAME), *(void **)(pc + PC_PAWN));
}

static void h_server_restart(uint8_t *pc)
{
    hlog("ServerRestartPlayer: player %d state %#x pawn %p", pc_player_id(pc),
         *(uint32_t *)(pc + PC_STATENAME), *(void **)(pc + PC_PAWN));
    o_server_restart(pc);
}

static void h_client_retry(uint8_t *pc, void *pawn)
{
    o_client_retry(pc, pawn);
    int playing = *(uint64_t *)(pc + PC_STATENAME) == NAME_PLAYING;
    int send = cfg.fix_join_state && pawn && playing && pc[ACTOR_ROLE] == 3;
    hlog("ClientRetryClientRestart: player %d pawn %p state %#x%s", pc_player_id(pc), pawn,
         *(uint32_t *)(pc + PC_STATENAME), send ? " -> sending ClientGotoState(Playing)" : "");
    if (send) ((GotoStateFn)AT(g_build->client_goto_state))(pc, NAME_PLAYING);
}

static uint64_t h_eliminate(void *tm, uint8_t *ps)
{
    int id = ps ? *(int32_t *)(ps + PS_PLAYERID) : -1;
    if (cfg.block_eliminate) {
        hlog("TeamManager EliminatePlayer(player %d): blocked (BlockEliminate=1)", id);
        return 0;
    }
    hlog("TeamManager EliminatePlayer(player %d)", id);
    return o_eliminate(tm, ps);
}

/* ------------------------------------------------------------------------ */
/* Patching                                                                  */
/* ------------------------------------------------------------------------ */

static int bytes_equal(const void *a, const void *b, size_t n)
{
    return memcmp(a, b, n) == 0;
}

static int32_t call_rel(uint32_t from_rva)
{
    return *(int32_t *)(g_base + from_rva + 1);
}

static int write_code(void *dst, const void *src, size_t n)
{
    DWORD old;
    if (!VirtualProtect(dst, n, PAGE_EXECUTE_READWRITE, &old)) return 0;
    memcpy(dst, src, n);
    VirtualProtect(dst, n, old, &old);
    FlushInstructionCache(GetCurrentProcess(), dst, n);
    return 1;
}

/* Executable page within +-2 GB of the exe for an absolute-jump thunk. */
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
   entry becomes jmp rel32 to a thunk that jumps to `hook`. The hook gets the
   original arguments and calls the returned trampoline to run the original.
   rax is free at both points (no prologue here sets or reads it). Uses 48
   bytes at *cursor. */
static void *hook_entry(uint8_t **cursor, uint32_t rva, const uint8_t *expect, size_t n,
                        void *hook, const char *what)
{
    uint8_t *fn = g_base + rva;
    if (!rva || !*cursor) return NULL;
    if (n < 5 || n > 16 || !bytes_equal(fn, expect, n)) {
        hlog("%s: prologue mismatch at +%07x; not hooked", what, rva);
        return NULL;
    }
    uint8_t *tramp = *cursor, *entry = *cursor + 32;
    uint64_t back = (uint64_t)(uintptr_t)(fn + n), to = (uint64_t)(uintptr_t)hook;
    memcpy(tramp, fn, n);
    tramp[n] = 0x48; tramp[n + 1] = 0xB8; memcpy(tramp + n + 2, &back, 8);
    tramp[n + 10] = 0xFF; tramp[n + 11] = 0xE0;
    entry[0] = 0x48; entry[1] = 0xB8; memcpy(entry + 2, &to, 8); entry[10] = 0xFF; entry[11] = 0xE0;
    FlushInstructionCache(GetCurrentProcess(), tramp, 48);
    *cursor += 48;

    uint8_t jmp[16];
    memset(jmp, 0x90, sizeof jmp);
    jmp[0] = 0xE9;
    int64_t rel = (int64_t)(entry - (fn + 5));
    int32_t rel32 = (int32_t)rel;
    memcpy(jmp + 1, &rel32, 4);
    if (rel != rel32 || !write_code(fn, jmp, n)) {
        hlog("%s: patch failed", what);
        return NULL;
    }
    hlog("%s hooked at +%07x", what, rva);
    return tramp;
}

static const GameBuild *identify(void)
{
    IMAGE_DOS_HEADER *dos = (IMAGE_DOS_HEADER *)g_base;
    IMAGE_NT_HEADERS64 *nt = (IMAGE_NT_HEADERS64 *)(g_base + dos->e_lfanew);
    for (size_t i = 0; i < sizeof k_builds / sizeof k_builds[0]; i++) {
        const GameBuild *b = &k_builds[i];
        if (nt->OptionalHeader.SizeOfImage != b->size_of_image) continue;
        if (nt->FileHeader.TimeDateStamp != b->timestamp) continue;
        static const uint8_t stub[3] = { 0x32, 0xC0, 0xC3 };
        if (!bytes_equal(g_base + b->listen_stub, stub, 3)) continue;
        if (g_base[b->listen_call] != 0xE8) continue;
        if (b->listen_call + 5 + call_rel(b->listen_call) != b->listen_stub) continue;
        if (g_base[b->listen_call + 5] != 0x84 || g_base[b->listen_call + 6] != 0xC0) continue;
        return b;
    }
    hlog("Unknown exe (SizeOfImage %u, timestamp %08x): not patching",
         nt->OptionalHeader.SizeOfImage, nt->FileHeader.TimeDateStamp);
    return NULL;
}

static void install(void)
{
    g_base = (uint8_t *)GetModuleHandleW(NULL);
    g_build = identify();
    if (!g_build) return;
    hlog("sos_host loaded into %s at %p (EnableListen=%d Port=%d UnfilterCommandLine=%d "
         "SteamSockets=%d LoginPendingTimeout=%d)", g_build->name, g_base, cfg.enable_listen,
         cfg.port, cfg.unfilter_cmdline, cfg.steam_sockets, cfg.login_timeout);

    uint8_t *near_page = alloc_near(g_base, 4096);

    if (cfg.game_log && near_page) {
        static const uint8_t prologue[5] = { 0x40, 0x53, 0x55, 0x56, 0x57 };
        uint8_t *fn = g_base + g_build->log_fn;
        wchar_t path[MAX_PATH];
        _snwprintf(path, MAX_PATH - 1, L"%lssos_game_%lu.log", g_dir, GetCurrentProcessId());
        path[MAX_PATH - 1] = 0;
        if (!bytes_equal(fn, prologue, 5)) {
            hlog("Log function prologue mismatch; game log mirror off");
        } else if ((g_game_log = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS,
                                             FILE_ATTRIBUTE_NORMAL, NULL)) == INVALID_HANDLE_VALUE) {
            hlog("Cannot create the game log file");
        } else {
            InitializeCriticalSection(&g_game_lock);
            /* near_page+16: trampoline = displaced prologue; mov rax, fn+5; jmp rax */
            uint8_t *tramp = near_page + 16;
            uint64_t back = (uint64_t)(uintptr_t)(fn + 5);
            memcpy(tramp, prologue, 5);
            tramp[5] = 0x48; tramp[6] = 0xB8; memcpy(tramp + 7, &back, 8); tramp[15] = 0xFF; tramp[16] = 0xE0;
            g_log_tramp = tramp;
            /* near_page+48: mov rax, log_hook; jmp rax */
            uint8_t *entry = near_page + 48;
            uint64_t hook = (uint64_t)(uintptr_t)&log_hook;
            entry[0] = 0x48; entry[1] = 0xB8; memcpy(entry + 2, &hook, 8); entry[10] = 0xFF; entry[11] = 0xE0;
            FlushInstructionCache(GetCurrentProcess(), near_page, 4096);
            uint8_t jmp[5] = { 0xE9 };
            int32_t rel = (int32_t)(entry - (fn + 5));
            memcpy(jmp + 1, &rel, 4);
            if (write_code(fn, jmp, 5)) hlog("Game log mirror -> %ls", path);
        }
    }

    if (cfg.enable_listen) {
        uint8_t *thunk = near_page;
        if (!thunk) {
            hlog("No memory near the exe for the Listen thunk; hosting disabled");
        } else {
            /* mov rax, imm64; jmp rax */
            uint8_t code[12] = { 0x48, 0xB8, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xE0 };
            uint64_t fn = (uint64_t)(uintptr_t)&HostListen;
            memcpy(code + 2, &fn, 8);
            memcpy(thunk, code, sizeof code);
            FlushInstructionCache(GetCurrentProcess(), thunk, sizeof code);

            uint8_t call[5] = { 0xE8 };
            int64_t rel = (int64_t)(thunk - (g_base + g_build->listen_call + 5));
            int32_t rel32 = (int32_t)rel;
            memcpy(call + 1, &rel32, 4);
            if (rel == rel32 && write_code(g_base + g_build->listen_call, call, 5))
                hlog("Patched LoadMap Listen call at +%07x -> thunk %p", g_build->listen_call, thunk);
            else
                hlog("Failed to patch the Listen call");
        }
    }

    if (near_page && g_build->restart_player) {
        static const uint8_t p_restart[5] = { 0x48, 0x89, 0x5C, 0x24, 0x18 };
        static const uint8_t p_server[6]  = { 0x40, 0x53, 0x48, 0x83, 0xEC, 0x40 };
        static const uint8_t p_retry[5]   = { 0x48, 0x89, 0x5C, 0x24, 0x10 };
        static const uint8_t p_elim[5]    = { 0x48, 0x89, 0x5C, 0x24, 0x18 };
        uint8_t *cursor = near_page + 128;
        o_restart_player = (RestartPlayerFn)hook_entry(&cursor, g_build->restart_player, p_restart, 5,
                                                       (void *)h_restart_player, "RestartPlayer");
        o_server_restart = (ServerRestartFn)hook_entry(&cursor, g_build->server_restart, p_server, 6,
                                                       (void *)h_server_restart, "ServerRestartPlayer");
        o_client_retry = (ClientRetryFn)hook_entry(&cursor, g_build->client_retry, p_retry, 5,
                                                   (void *)h_client_retry, "ClientRetryClientRestart");
        o_eliminate = (EliminateFn)hook_entry(&cursor, g_build->eliminate, p_elim, 5,
                                              (void *)h_eliminate, "TeamManager EliminatePlayer");
        hlog("FixJoinState=%d BlockEliminate=%d", cfg.fix_join_state, cfg.block_eliminate);
    }

    if (cfg.unfilter_cmdline) {
        uint8_t *site = g_base + g_build->filter_call;
        static const uint8_t expect[5] = { 0xE8, 0x0C, 0x3A, 0x00, 0x00 };
        static const uint8_t nop5[5] = { 0x0F, 0x1F, 0x44, 0x00, 0x00 };
        if (bytes_equal(site, expect, 5) && write_code(site, nop5, 5))
            hlog("Command-line filter disabled at +%07x", g_build->filter_call);
        else
            hlog("Command-line filter call not found; left as is");
    }
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        InitializeCriticalSection(&g_log_lock);
        load_real_version();
        load_config(inst);
        install();
    }
    return TRUE;
}
