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
    int max_client_rate;      /* >0: UNetDriver MaxClientRate/MaxInternetClientRate after Listen */
    int replicate_actors;     /* 1: run our own actor replication pass (client builds lack it) */
    int replicate_startup;    /* 1: also replicate actors placed in the map (bNetStartup); 2: only near each joiner */
    int startup_radius;       /* cm, for ReplicateStartupActors=2 */
    int ack_moves;            /* 1: answer each joiner ServerMove with ClientAckGoodMove */
    int skip_login_check;     /* 1: RestartPlayer treats every player as logged in (test switch) */
} cfg = { 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 15000, 1, 0 };

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
    cfg.max_client_rate  = GetPrivateProfileIntW(L"Host", L"MaxClientRate", cfg.max_client_rate, ini);
    cfg.replicate_actors = GetPrivateProfileIntW(L"Host", L"ReplicateActors", cfg.replicate_actors, ini);
    cfg.replicate_startup = GetPrivateProfileIntW(L"Host", L"ReplicateStartupActors", cfg.replicate_startup, ini);
    cfg.startup_radius = GetPrivateProfileIntW(L"Host", L"StartupActorRadius", 15000, ini);
    {   /* Env override, for launchers that rewrite the ini. */
        char ev[16];
        if (GetEnvironmentVariableA("SOS_HOST_REPLICATE_STARTUP", ev, sizeof ev) > 0)
            cfg.replicate_startup = atoi(ev);
    }
    cfg.ack_moves        = GetPrivateProfileIntW(L"Host", L"AckMoves", cfg.ack_moves, ini);
    cfg.skip_login_check = GetPrivateProfileIntW(L"Host", L"SkipLoginCheck", cfg.skip_login_check, ini);

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
    /* Actor replication (Classic only; 0 = not mapped) */
    uint32_t tick_flush;        /* void UNetDriver::TickFlush(UNetDriver*, float) */
    uint32_t find_channel;      /* TMap<FWeakObjectPtr, UActorChannel*>::FindIndex(map, int*, key*) */
    uint32_t weak_ctor;         /* FWeakObjectPtr::operator=(FWeakObjectPtr*, UObject*) */
    uint32_t create_channel;    /* UChannel* UNetConnection::CreateChannel(conn, type, bOpenedLocally, index) */
    uint32_t set_channel_actor; /* void UActorChannel::SetChannelActor(ch, AActor*) */
    uint32_t replicate_actor;   /* bool UActorChannel::ReplicateActor(ch) */
    uint32_t is_pending_kill;   /* bool UObjectBaseUtility::IsPendingKill(obj) */
    /* Move acks (Classic only; 0 = not mapped) */
    uint32_t exec_server_move;  /* UCharacterMovementComponent::execServerMove(cmc, FFrame&, void*) */
    uint32_t exec_server_move_dual;   /* execServerMoveDual */
    uint32_t exec_server_move_hybrid; /* execServerMoveDualHybridRootMotion */
    uint32_t step_compiled_in;  /* FFrame::StepCompiledIn(FFrame*, void* Result, UProperty*) */
    uint32_t ack_good_move;     /* UCharacterMovementComponent::ClientAckGoodMove(cmc, float TimeStamp) RPC sender */
    uint32_t adjust_position;   /* CMC::ClientAdjustPosition(cmc, ts, FVector* Loc, FVector* Vel, Base, FName Bone, bHasBase, bRelative, uint8 Mode) sender */
    uint32_t move_mode_shift;   /* uint8/int GroundShift used by PackNetworkMovementMode */
    uint32_t move_mode_custom;  /* uint8 custom-mode base used by PackNetworkMovementMode */
    uint32_t login_check;       /* JNE (75 xx) after IsLoggedIn in the RestartPlayer override; 0 = not mapped */
    uint32_t gmalloc;           /* FMalloc* GMalloc (vtable: +0x10 Malloc(size, align), +0x20 Free) */
} GameBuild;

static const GameBuild k_builds[] = {
    {
        "SOS main (619080)", 48713728, 0x5bc0f502,
        0x147cef4, 0x0188b70, 0x047504f,
        0x2bf5818, 0x04d3280, 0x146a1c0, 0x1471a30, 0x146c3b0, 0x1258c90,
        0x1aeafc0, 0x0eb75b0, 0x040d1b0, 0x2a4b0b0,
        0x04a9f30, 0x04de7a0,
        0x01cd360, 0x01c7370, 0x14e9160, 0x14e8d20, 0x01f0600,
        0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    },
    {
        "SOS: Classic (802240)", 48156672, 0x5b971052,
        0x1417674, 0x0b6edf0, 0x041578f,
        0x2b766a0, 0x0472c50, 0x14048e0, 0x140c1d0, 0x1406ad0, 0x11f3aa0,
        0x1a7ec40, 0x0e542b0, 0x03acc40, 0,
        0x044a500, 0x047e090,
        0x0185c30, 0, 0x1482e90, 0x1482a50, 0,
        0x11f5460, 0x0ac6ce0, 0x053ecd0, 0x11dba20, 0x1080c10, 0x107dbe0, 0x01672f0,
        0x161e450, 0x161e770, 0x161ebd0, 0x0537810, 0x14824b0, 0x14824f0, 0x2b5a6ec, 0x2b5a7d8,
        0x0185ca0, 0x29e7560,
    },
};

/* Engine layout, identical in both builds (UE 4.12.5). */
#define UWORLD_NOTIFY      0x28   /* FNetworkNotify base of UWorld */
#define UWORLD_NETDRIVER   0x38   /* UNetDriver* UWorld::NetDriver */
#define NETDRIVER_STEAM_PASSTHROUGH 0x390 /* USteamNetDriver::bIsPassthrough */
#define VTBL_INITLISTEN    0x1F8  /* UNetDriver::InitListen */
#define NETDRIVER_MAXINETRATE 0x4C /* int32 MaxInternetClientRate; MaxClientRate at +0x50 (main, reflection) */
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
#define VCALL(obj, off) (*(void **)(*(uint8_t **)(obj) + (off)))

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
    if (cfg.max_client_rate > 0) {
        int32_t *rates = (int32_t *)((uint8_t *)driver + NETDRIVER_MAXINETRATE);
        /* rates[0] = MaxInternetClientRate, rates[1] = MaxClientRate. Only write
           over values that look like byte rates, in case the layout differs. */
        if (rates[0] >= 1000 && rates[0] <= 10000000 && rates[1] >= 1000 && rates[1] <= 10000000) {
            hlog("MaxInternetClientRate %d -> %d, MaxClientRate %d -> %d",
                 rates[0], cfg.max_client_rate, rates[1], cfg.max_client_rate);
            rates[0] = rates[1] = cfg.max_client_rate;
        } else {
            hlog("MaxClientRate not set: unexpected driver values %d %d", rates[0], rates[1]);
        }
    }
    return 1;
}

/* ------------------------------------------------------------------------ */
/* Test joiner: travel to a host once the frontend login is done             */
/* ------------------------------------------------------------------------ */
/* For unattended tests only. With the environment variable SOS_HOST_AUTOJOIN
   set (for example 127.0.0.1:7777?AuthToken=<jwt>), a client that boots into
   the frontend logs in to the backend as usual and then travels to that URL
   by itself, as if PLAY had found the session. A direct URL on the command
   line skips the login, so the host keeps that player in LoginPending.
   The travel is requested like UEngine::SetClientTravel does it: the first
   world context gets TravelURL (an FString from GMalloc, which the engine
   frees after Browse) and TravelType 0 (TRAVEL_Absolute). */

#define ENGINE_WORLDLIST   0xB78  /* FWorldContext** (count at +0xB80) */
#define CTX_TRAVELURL      0xD0   /* FString */
#define CTX_TRAVELTYPE     0xE0   /* uint8 */

typedef void *(*MallocFn)(void *gmalloc, size_t size, uint32_t align);
static wchar_t g_autojoin[1024];
static volatile LONG g_autojoin_state;   /* 0 idle, 1 armed, 2 fired */

static DWORD WINAPI autojoin_thread(LPVOID arg)
{
    (void)arg;
    Sleep(3000);
    void *engine = *(void **)AT(g_build->gengine);
    void *gmalloc = *(void **)AT(g_build->gmalloc);
    if (!engine || !gmalloc) { hlog("AutoJoin: engine not ready"); return 0; }
    uint8_t **ctxs = *(uint8_t ***)((uint8_t *)engine + ENGINE_WORLDLIST);
    int n = *(int32_t *)((uint8_t *)engine + ENGINE_WORLDLIST + 8);
    if (!ctxs || n < 1 || !ctxs[0]) { hlog("AutoJoin: no world context"); return 0; }
    uint8_t *ctx = ctxs[0];
    FString *travel = (FString *)(ctx + CTX_TRAVELURL);
    if (travel->num > 1) { hlog("AutoJoin: a travel is already pending"); return 0; }
    int len = (int)wcslen(g_autojoin) + 1;
    wchar_t *buf = ((MallocFn)VCALL(gmalloc, 0x10))(gmalloc, len * sizeof(wchar_t), 0);
    if (!buf) return 0;
    memcpy(buf, g_autojoin, len * sizeof(wchar_t));
    ctx[CTX_TRAVELTYPE] = 0;
    travel->data = buf;
    travel->max = len;
    MemoryBarrier();
    travel->num = len;   /* last: the engine tick tests Num */
    hlog("AutoJoin: travel to %.*ls... requested", 40, g_autojoin);
    return 0;
}

static void autojoin_on_log(const wchar_t *msg)
{
    if (g_autojoin_state != 1) return;
    if (!wcsstr(msg, L"\"LoadingLoginEnd\"")) return;
    /* {"Type":"LoadingLoginEnd","PlayerId":"<steam id>",...}; an empty PlayerId means no login. */
    if (wcsstr(msg, L"\"PlayerId\":\"\"") || wcsstr(msg, L"\"Success\":\"false\"")) {
        hlog("AutoJoin: login failed, not travelling"); g_autojoin_state = 2; return;
    }
    if (InterlockedCompareExchange(&g_autojoin_state, 2, 1) != 1) return;
    HANDLE t = CreateThread(NULL, 0, autojoin_thread, NULL, 0, NULL);
    if (t) CloseHandle(t);
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
    autojoin_on_log(msg);

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
/* Actor replication                                                         */
/* ------------------------------------------------------------------------ */

/* The shipping clients are built without server code: UNetDriver::TickFlush
   never calls ServerReplicateActors. On a listen host the only actor channels
   that open are the ones UNetDriver::ProcessRemoteFunction opens for an RPC
   target (the joiner's PlayerController, the GameState), and nothing sends
   later property changes. The joiner's own pawn never reaches it, so its camera
   sits under the map. This pass does a small ServerReplicateActors before each
   TickFlush, using the same calls ProcessRemoteFunction uses to open a channel.
   No distance culling; actors placed in the map are skipped unless
   ReplicateStartupActors=1 (the client already has them loaded). */

#define DRV_SERVERCONN    0x70    /* UNetConnection* ServerConnection (0 on a server) */
#define DRV_CLIENTCONNS   0x78    /* TArray<UNetConnection*> ClientConnections */
#define DRV_WORLD         0xA0    /* UWorld* */
#define DRV_NAME          0xE0    /* FName NetDriverName */
#define DRV_MAXTICKRATE   0x48    /* int32 NetServerMaxTickRate */
#define DRV_VT_LEVELINIT  0x300   /* bool IsLevelInitializedForActor(actor, conn) */
#define WORLD_LEVELS      0x108   /* TArray<ULevel*> */
#define WORLD_TIMESECONDS 0x878   /* float */
#define LEVEL_ACTORS      0xA0    /* TArray<AActor*> */
#define CONN_OWNINGACTOR  0x30
#define CONN_STATE        0x124   /* 1 = closed */
#define CONN_ACTORCHANNELS 0x51490 /* TMap<FWeakObjectPtr, UActorChannel*> elements */
#define CONN_VT_ISNETREADY 0x240  /* int IsNetReady(bool bSaturate) */
#define ACTOR_FLAGS       0x7C    /* 1 bHidden, 4 bNetStartup, 8 bOnlyRelevantToOwner, 0x10 bAlwaysRelevant */
#define ACTOR_FLAGS2      0x7E    /* 4 bReplicates */
#define ACTOR_NETDRIVER   0x80    /* FName NetDriverName */
#define ACTOR_OWNER       0x90
#define ACTOR_NETUPDATETIME 0x12C /* float; unused by the stripped engine, used here as the schedule */
#define ACTOR_NETUPDATEFREQ 0x130 /* float */
#define ACTOR_ROOTCOMP    0x160   /* USceneComponent* RootComponent */
#define ACTOR_COMPLOC     0x120   /* ComponentToWorld translation */
#define CH_REPFLAGS       0x88    /* 8 = bIsReplicatingActor */
#define CHTYPE_ACTOR      2

typedef void (*TickFlushFn)(uint8_t *drv, float dt);
typedef void (*WeakCtorFn)(uint64_t *weak, void *obj);
typedef void (*FindChannelFn)(void *map, int32_t *index, uint64_t *key);
typedef uint8_t *(*CreateChannelFn)(void *conn, int type, int opened_locally, int index);
typedef void (*SetChannelActorFn)(void *ch, void *actor);
typedef uint8_t (*ReplicateActorFn)(void *ch);
typedef uint8_t (*IsPendingKillFn)(void *obj);
typedef uint8_t (*LevelInitFn)(void *drv, void *actor, void *conn);
typedef int (*IsNetReadyFn)(void *conn, int saturate);

static TickFlushFn o_tick_flush;
static uint8_t **g_due;
static int g_due_cap;
static float g_next_pass;
static unsigned g_opened, g_sent, g_passes;
static DWORD g_last_report;


static uint8_t *find_actor_channel(uint8_t *conn, uint8_t *actor)
{
    uint64_t key;
    int32_t index = -1;
    ((WeakCtorFn)AT(g_build->weak_ctor))(&key, actor);
    ((FindChannelFn)AT(g_build->find_channel))(conn + CONN_ACTORCHANNELS, &index, &key);
    if (index < 0) return NULL;
    uint8_t *elems = *(uint8_t **)(conn + CONN_ACTORCHANNELS);
    return elems ? *(uint8_t **)(elems + (int64_t)index * 0x18 + 8) : NULL;
}

/* 1 = handled (or nothing to do), 0 = connection saturated, stop for now. */
static int replicate_to(uint8_t *drv, uint8_t *conn, uint8_t *actor, int *opens_left)
{
    if (!((IsNetReadyFn)VCALL(conn, CONN_VT_ISNETREADY))(conn, 0)) return 0;
    uint8_t *ch = find_actor_channel(conn, actor);
    if (!ch) {
        if (*opens_left <= 0) return 1;
        if (!((LevelInitFn)VCALL(drv, DRV_VT_LEVELINIT))(drv, actor, conn)) return 1;
        ch = ((CreateChannelFn)AT(g_build->create_channel))(conn, CHTYPE_ACTOR, 1, -1);
        if (!ch) return 1;
        ((SetChannelActorFn)AT(g_build->set_channel_actor))(ch, actor);
        (*opens_left)--;
        g_opened++;
    }
    if (ch[CH_REPFLAGS] & 8) return 1;
    ((ReplicateActorFn)AT(g_build->replicate_actor))(ch);
    g_sent++;
    return 1;
}

static int relevant_to(uint8_t *actor, uint8_t *pc)
{
    if (!(actor[ACTOR_FLAGS] & 8)) return 1;           /* not owner-only */
    uint8_t *top = actor;
    for (int i = 0; i < 16; i++) {
        uint8_t *owner = *(uint8_t **)(top + ACTOR_OWNER);
        if (!owner) break;
        top = owner;
    }
    return top == pc || actor == *(uint8_t **)(pc + PC_PAWN);
}

/* 1 = actor's root is within r cm of loc (or either has no location). */
static int near_loc(uint8_t *actor, const float *loc, float r)
{
    if (!loc) return 1;
    uint8_t *root = *(uint8_t **)(actor + ACTOR_ROOTCOMP);
    if (!root) return 1;
    const float *p = (const float *)(root + ACTOR_COMPLOC);
    float dx = p[0] - loc[0], dy = p[1] - loc[1], dz = p[2] - loc[2];
    return dx * dx + dy * dy + dz * dz <= r * r;
}

static void replicate_actors(uint8_t *drv)
{
    if (*(void **)(drv + DRV_SERVERCONN)) return;              /* client */
    uint8_t **conns = *(uint8_t ***)(drv + DRV_CLIENTCONNS);
    int nconns = *(int32_t *)(drv + DRV_CLIENTCONNS + 8);
    uint8_t *world = *(uint8_t **)(drv + DRV_WORLD);
    if (!conns || nconns <= 0 || !world) return;
    if (*(uint8_t **)(world + UWORLD_NETDRIVER) != drv) return;  /* game driver only, not demo */

    float now = *(float *)(world + WORLD_TIMESECONDS);
    int rate = *(int32_t *)(drv + DRV_MAXTICKRATE);
    if (rate < 5 || rate > 120) rate = 30;
    if (now < g_next_pass && now + 5.0f > g_next_pass) return;
    g_next_pass = now + 1.0f / rate;
    g_passes++;

    uint64_t drv_name = *(uint64_t *)(drv + DRV_NAME);
    IsPendingKillFn pending_kill = (IsPendingKillFn)AT(g_build->is_pending_kill);

    /* Due actors from every level. */
    int ndue = 0;
    uint8_t **levels = *(uint8_t ***)(world + WORLD_LEVELS);
    int nlevels = *(int32_t *)(world + WORLD_LEVELS + 8);
    for (int l = 0; levels && l < nlevels; l++) {
        uint8_t *level = levels[l];
        if (!level) continue;
        uint8_t **acts = *(uint8_t ***)(level + LEVEL_ACTORS);
        int nacts = *(int32_t *)(level + LEVEL_ACTORS + 8);
        for (int i = 0; acts && i < nacts; i++) {
            uint8_t *a = acts[i];
            if (!a || !(a[ACTOR_FLAGS2] & 4)) continue;
            if ((a[ACTOR_FLAGS] & 4) && !cfg.replicate_startup) continue;
            if (*(uint64_t *)(a + ACTOR_NETDRIVER) != drv_name) continue;
            float next = *(float *)(a + ACTOR_NETUPDATETIME);
            if (next > now && next < now + 10.0f) continue;
            if (pending_kill(a)) continue;
            if (ndue == g_due_cap) {
                int cap = g_due_cap ? g_due_cap * 2 : 4096;
                uint8_t **p = (uint8_t **)realloc(g_due, cap * sizeof *p);
                if (!p) break;
                g_due = p; g_due_cap = cap;
            }
            g_due[ndue++] = a;
        }
    }

    /* Actors before done_upto were offered to every connection. */
    int done_upto = ndue;
    for (int c = 0; c < nconns; c++) {
        uint8_t *conn = conns[c];
        if (!conn || *(int32_t *)(conn + CONN_STATE) == 1) continue;
        uint8_t *pc = *(uint8_t **)(conn + CONN_OWNINGACTOR);
        if (!pc) continue;
        int opens_left = 64;
        /* The joiner's own controller, pawn and player state first. */
        uint8_t *own[3] = { pc, *(uint8_t **)(pc + PC_PAWN), *(uint8_t **)(pc + PC_PLAYERSTATE) };
        int ok = 1;
        for (int k = 0; k < 3 && ok; k++)
            if (own[k] && (own[k][ACTOR_FLAGS2] & 4) && !pending_kill(own[k]))
                ok = replicate_to(drv, conn, own[k], &opens_left);
        const float *ploc = NULL;
        if (cfg.replicate_startup == 2 && own[1]) {
            uint8_t *root = *(uint8_t **)(own[1] + ACTOR_ROOTCOMP);
            if (root) ploc = (const float *)(root + ACTOR_COMPLOC);
        }
        float radius = (float)cfg.startup_radius;
        int i = 0;
        for (; ok && i < ndue; i++) {
            uint8_t *a = g_due[i];
            if (a == own[0] || a == own[1] || a == own[2] || !relevant_to(a, pc)) continue;
            if (cfg.replicate_startup == 2 && (a[ACTOR_FLAGS] & 4)) {
                /* No pawn yet: hold map actors back. Not yet near: skip; a channel
                   that is already open keeps getting updates. */
                if (!ploc) continue;
                if (!near_loc(a, ploc, radius) && !find_actor_channel(conn, a)) continue;
            }
            if (!replicate_to(drv, conn, a, &opens_left)) { ok = 0; break; }
        }
        if (!ok && i < done_upto) done_upto = i;
    }

    for (int i = 0; i < done_upto; i++) {
        float f = *(float *)(g_due[i] + ACTOR_NETUPDATEFREQ);
        if (!(f >= 1.0f)) f = 1.0f;
        if (f > (float)rate) f = (float)rate;
        *(float *)(g_due[i] + ACTOR_NETUPDATETIME) = now + 1.0f / f;
    }

    DWORD t = GetTickCount();
    if (t - g_last_report >= 10000) {
        g_last_report = t;
        hlog("ReplicateActors: %d connection(s), %d due, %d fully served, %u channels opened, %u updates sent, %u passes",
             nconns, ndue, done_upto, g_opened, g_sent, g_passes);
    }
}

static void h_tick_flush(uint8_t *drv, float dt)
{
    if (cfg.replicate_actors) replicate_actors(drv);
    o_tick_flush(drv, dt);
}

/* ------------------------------------------------------------------------ */
/* Move acks                                                                 */
/* ------------------------------------------------------------------------ */

/* The shipping clients are also built without
   UCharacterMovementComponent::SendClientAdjustment, so a host never answers a
   joiner's ServerMove. The joiner keeps every move it sent, hits "Hit limit of
   96 saved moves" and stops moving. The ServerMove RPCs still run on the host
   (they move the pawn there), so we hook their native exec thunks: before the
   original runs, read the move's TimeStamp from the RPC parameters the same
   way the thunk does (FFrame::StepCompiledIn over PropertyChainForCompiledIn,
   then put the chain back), and after it runs send ClientAckGoodMove for that
   TimeStamp. ServerMove: TimeStamp is parameter 1. ServerMoveDual and
   ServerMoveDualHybridRootMotion: parameter 5 is the newer move's TimeStamp
   (TimeStamp0, InAccel0, PendingFlags, View0, TimeStamp, ...); acking it also
   acks the older one. The joiner is never corrected: it trusts its own
   position. */

#define FRAME_CODE       0x20    /* uint8* Code (0 for a native call) */
#define FRAME_PROPCHAIN  0x80    /* UField* PropertyChainForCompiledIn */
#define PROP_NEXT        0x28    /* UField::Next */

typedef void (*ExecFn)(void *ctx, uint8_t *stack, void *result);
typedef void (*StepFn)(uint8_t *stack, void *result, void *prop);
typedef void (*AckGoodMoveFn)(void *cmc, float ts);
static ExecFn o_exec_move, o_exec_dual, o_exec_hybrid;
static unsigned g_moves_acked;
static DWORD g_last_ack_report;

/* Copy the first `size` bytes of the n-th (1-based) RPC parameter; 0 if not readable. */
static int peek_param(uint8_t *stack, int n, void *out, size_t size)
{
    if (*(void **)(stack + FRAME_CODE)) return 0;
    void *saved = *(void **)(stack + FRAME_PROPCHAIN);
    uint8_t scratch[64];
    int ok = 1;
    for (int i = 1; i <= n; i++) {
        void *prop = *(void **)(stack + FRAME_PROPCHAIN);
        if (!prop) { ok = 0; break; }
        *(void **)(stack + FRAME_PROPCHAIN) = *(void **)((uint8_t *)prop + PROP_NEXT);
        memset(scratch, 0, sizeof scratch);
        ((StepFn)AT(g_build->step_compiled_in))(stack, scratch, prop);
    }
    *(void **)(stack + FRAME_PROPCHAIN) = saved;
    if (ok) memcpy(out, scratch, size);
    return ok;
}

#define CMC_UPDATEDCOMP   0xC8    /* USceneComponent* UpdatedComponent */
#define CMC_MOVEMODE      0x180   /* uint8 MovementMode, +0x181 CustomMovementMode */
#define CMC_GROUNDMODE    0x372   /* uint8 GroundMovementMode */
#define COMP_LOCATION     0x120   /* ComponentToWorld translation */
#define ADJUST_DIST       100.0f  /* cm the joiner may be off before it is corrected */
#define ADJUST_INTERVAL   0.25f   /* s between corrections of one joiner */

typedef void (*AdjustFn)(void *cmc, float ts, const float *loc, const float *vel, void *base,
                         uint64_t bone, uint8_t has_base, uint8_t relative, uint8_t mode);
static unsigned g_moves_adjusted;
static struct { void *cmc; float ts; } g_last_adjust[32];

static uint8_t packed_move_mode(uint8_t *cmc)
{
    uint8_t mode = cmc[CMC_MOVEMODE];
    if (mode == 6) /* MOVE_Custom */
        return (uint8_t)(cmc[CMC_MOVEMODE + 1] + *(uint8_t *)AT(g_build->move_mode_custom));
    return (uint8_t)(mode | ((cmc[CMC_GROUNDMODE] != 1) << *(uint8_t *)AT(g_build->move_mode_shift)));
}

/* After a ServerMove ran: ack it, or, when the host's position for this pawn is
   far from where the joiner says it is (a teleport such as the start of the
   match, a blocked move), send the host's position with ClientAdjustPosition. */
static void answer_move(uint8_t *cmc, int ok, float ts, int have_loc, const float *client_loc)
{
    if (!cfg.ack_moves || !ok || !(ts > 0.0f)) return;
    if (((IsPendingKillFn)AT(g_build->is_pending_kill))(cmc)) return;
    uint8_t *comp = *(uint8_t **)(cmc + CMC_UPDATEDCOMP);
    if (have_loc && comp && g_build->adjust_position) {
        const float *loc = (const float *)(comp + COMP_LOCATION);
        float dx = loc[0] - client_loc[0], dy = loc[1] - client_loc[1], dz = loc[2] - client_loc[2];
        if (dx * dx + dy * dy + dz * dz > ADJUST_DIST * ADJUST_DIST) {
            int slot = -1, free_slot = -1;
            for (int i = 0; i < 32; i++) {
                if (g_last_adjust[i].cmc == cmc) slot = i;
                else if (!g_last_adjust[i].cmc && free_slot < 0) free_slot = i;
            }
            if (slot < 0) slot = free_slot >= 0 ? free_slot : (int)(((uintptr_t)cmc >> 4) & 31);
            if (g_last_adjust[slot].cmc == cmc && ts > g_last_adjust[slot].ts
                && ts - g_last_adjust[slot].ts < ADJUST_INTERVAL)
                return;                     /* a correction is on its way */
            g_last_adjust[slot].cmc = cmc;
            g_last_adjust[slot].ts = ts;
            static const float zero[3] = { 0, 0, 0 };
            ((AdjustFn)AT(g_build->adjust_position))(cmc, ts, loc, zero, NULL, 0, 0, 0, packed_move_mode(cmc));
            g_moves_adjusted++;
            hlog("AdjustPosition: joiner at (%.0f %.0f %.0f), host has (%.0f %.0f %.0f); corrected (%u so far)",
                 client_loc[0], client_loc[1], client_loc[2], loc[0], loc[1], loc[2], g_moves_adjusted);
            return;
        }
    }
    ((AckGoodMoveFn)AT(g_build->ack_good_move))(cmc, ts);
    g_moves_acked++;
    DWORD t = GetTickCount();
    if (t - g_last_ack_report >= 10000) {
        g_last_ack_report = t;
        hlog("AckMoves: %u moves acked, %u corrected so far (last TimeStamp %.3f)", g_moves_acked, g_moves_adjusted, ts);
    }
}

/* ServerMove(TimeStamp, InAccel, ClientLoc, ...);
   ServerMoveDual(...)(TimeStamp0, InAccel0, PendingFlags, View0, TimeStamp, InAccel, ClientLoc, ...). */
static void h_exec_move(void *cmc, uint8_t *stack, void *result)
{
    float ts = 0, loc[3];
    int ok = peek_param(stack, 1, &ts, sizeof ts);
    int have_loc = peek_param(stack, 3, loc, sizeof loc);
    o_exec_move(cmc, stack, result);
    answer_move(cmc, ok, ts, have_loc, loc);
}

static void h_exec_dual(void *cmc, uint8_t *stack, void *result)
{
    float ts = 0, loc[3];
    int ok = peek_param(stack, 5, &ts, sizeof ts);
    int have_loc = peek_param(stack, 7, loc, sizeof loc);
    o_exec_dual(cmc, stack, result);
    answer_move(cmc, ok, ts, have_loc, loc);
}

static void h_exec_hybrid(void *cmc, uint8_t *stack, void *result)
{
    float ts = 0, loc[3];
    int ok = peek_param(stack, 5, &ts, sizeof ts);
    int have_loc = peek_param(stack, 7, loc, sizeof loc);
    o_exec_hybrid(cmc, stack, result);
    answer_move(cmc, ok, ts, have_loc, loc);
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
   The trampoline returns with jmp [rip] (no register touched), so displaced
   code may set rax; the entry stub clobbers rax before the hook runs. Uses
   48 bytes at *cursor. */
static void *hook_entry(uint8_t **cursor, uint32_t rva, const uint8_t *expect, size_t n,
                        void *hook, const char *what)
{
    uint8_t *fn = g_base + rva;
    if (!rva || !*cursor) return NULL;
    if (n < 5 || n > 18 || !bytes_equal(fn, expect, n)) {
        hlog("%s: prologue mismatch at +%07x; not hooked", what, rva);
        return NULL;
    }
    uint8_t *tramp = *cursor, *entry = *cursor + 32;
    uint64_t back = (uint64_t)(uintptr_t)(fn + n), to = (uint64_t)(uintptr_t)hook;
    memcpy(tramp, fn, n);
    tramp[n] = 0xFF; tramp[n + 1] = 0x25; memset(tramp + n + 2, 0, 4); /* jmp [rip+0] */
    memcpy(tramp + n + 6, &back, 8);
    entry[0] = 0x48; entry[1] = 0xB8; memcpy(entry + 2, &to, 8); entry[10] = 0xFF; entry[11] = 0xE0;
    FlushInstructionCache(GetCurrentProcess(), tramp, 48);
    *cursor += 48;

    uint8_t jmp[18];
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

    if (g_build->gmalloc && GetEnvironmentVariableW(L"SOS_HOST_AUTOJOIN", g_autojoin, 1024) > 0
        && g_autojoin[1023] == 0) {
        if (cfg.game_log) {
            g_autojoin_state = 1;
            hlog("AutoJoin armed: will travel after the frontend login");
        } else {
            hlog("AutoJoin needs GameLog=1; ignored");
        }
    }

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
        if (cfg.replicate_actors && g_build->tick_flush) {
            static const uint8_t p_flush[15] = { 0x48, 0x8B, 0xC4, 0x48, 0x89, 0x58, 0x10, 0x48,
                                                 0x89, 0x70, 0x18, 0x48, 0x89, 0x78, 0x20 };
            o_tick_flush = (TickFlushFn)hook_entry(&cursor, g_build->tick_flush, p_flush, 15,
                                                   (void *)h_tick_flush, "UNetDriver::TickFlush");
        }
        hlog("ReplicateActors=%d ReplicateStartupActors=%d", cfg.replicate_actors && o_tick_flush,
             cfg.replicate_startup);
        if (cfg.ack_moves && g_build->exec_server_move) {
            /* mov [rsp+18h],rbx; push rbp; push rsi; push rdi; lea rbp,[rsp-47h] */
            static const uint8_t p_exec[13] = { 0x48, 0x89, 0x5C, 0x24, 0x18, 0x55, 0x56, 0x57,
                                                0x48, 0x8D, 0x6C, 0x24, 0xB9 };
            o_exec_move = (ExecFn)hook_entry(&cursor, g_build->exec_server_move, p_exec, 13,
                                             (void *)h_exec_move, "CMC::execServerMove");
            o_exec_dual = (ExecFn)hook_entry(&cursor, g_build->exec_server_move_dual, p_exec, 13,
                                             (void *)h_exec_dual, "CMC::execServerMoveDual");
            o_exec_hybrid = (ExecFn)hook_entry(&cursor, g_build->exec_server_move_hybrid, p_exec, 13,
                                               (void *)h_exec_hybrid, "CMC::execServerMoveDualHybridRootMotion");
        }
        hlog("AckMoves=%d", cfg.ack_moves && o_exec_move && o_exec_dual);
        if (cfg.skip_login_check && g_build->login_check) {
            /* RestartPlayer: IsLoggedIn(gm, pc); test al,al; jne <spawn> -> jmp <spawn>.
               Otherwise a player with no backend login (a direct-URL joiner, the host's
               own player) is sent ClientGotoState(LoginPending) and never spawns. */
            uint8_t *site = g_base + g_build->login_check;
            uint8_t jmp = 0xEB;
            if (site[0] == 0x75 && site[-2] == 0x84 && site[-1] == 0xC0 && write_code(site, &jmp, 1))
                hlog("SkipLoginCheck: RestartPlayer login check bypassed at +%07x", g_build->login_check);
            else
                hlog("SkipLoginCheck: login check not found at +%07x; left as is", g_build->login_check);
        }
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
