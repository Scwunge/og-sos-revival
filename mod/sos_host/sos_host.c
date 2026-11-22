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
#define _CRT_RAND_S
#include <windows.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdarg.h>
#include <wchar.h>
#include <string.h>
#include <stdlib.h>
#include <winhttp.h>

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
    int tick_char_radius;     /* cm; >0: Characters this near a joiner always tick their pose */
    int max_fps;              /* >0: cap the host's frame rate (sleep in TickFlush) */
    int conn_net_speed;       /* >0: bytes/s each joiner connection may receive (UPlayer::CurrentNetSpeed) */
    int set_pawn_owner;       /* 1: joiner pawn Owner = its controller */
    wchar_t backend[256];     /* http://host:port of the revival backend ("" = no lobby events) */
    wchar_t session[128];     /* backend session id of this match */
    wchar_t token[512];       /* optional "Authorization: Token <this>" for backend calls */
    int mirror_streaming;     /* 1: send the host's streaming-level states to joiners (kept joiners on the loading screen) */
    int correct_moves;        /* 1: correct a joiner the host has far from its own position */
    int correct_dist;         /* cm the joiner may be off before it is corrected */
    int test_match_end;       /* test switch: >0 = fire the match end this many s after the first joiner pawn */
    wchar_t stat_props[512];  /* PlayerState properties added to each player's match-end entry */
} cfg = {
    .enable_listen = 1, .unfilter_cmdline = 1, .game_log = 1, .fix_join_state = 1,
    .replicate_actors = 1, .startup_radius = 15000, .ack_moves = 1,
    .correct_moves = 1, .correct_dist = 300,
    .tick_char_radius = 15000, .conn_net_speed = 400000, .set_pawn_owner = 1,
};

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

/* Copy the value of a "-KEY=value" command-line switch (case-insensitive key,
   value ends at a space or quote). Leaves out untouched if the switch is absent. */
static void cmdline_value(const wchar_t *key, wchar_t *out, int cap)
{
    const wchar_t *cl = GetCommandLineW();
    size_t kl = wcslen(key);
    for (const wchar_t *p = cl; *p; p++) {
        if (_wcsnicmp(p, key, kl) != 0) continue;
        if (p != cl && p[-1] != L' ' && p[-1] != L'"' && p[-1] != L'\t') continue;
        p += kl;
        int n = 0;
        while (p[n] && p[n] != L' ' && p[n] != L'"' && p[n] != L'\t' && n < cap - 1) n++;
        if (n > 0) { memcpy(out, p, n * sizeof(wchar_t)); out[n] = 0; }
        return;
    }
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
    cfg.startup_radius = GetPrivateProfileIntW(L"Host", L"StartupActorRadius", cfg.startup_radius, ini);
    {   /* Env override, for launchers that rewrite the ini. */
        char ev[16];
        if (GetEnvironmentVariableA("SOS_HOST_REPLICATE_STARTUP", ev, sizeof ev) > 0)
            cfg.replicate_startup = atoi(ev);
    }
    cfg.ack_moves        = GetPrivateProfileIntW(L"Host", L"AckMoves", cfg.ack_moves, ini);
    cfg.skip_login_check = GetPrivateProfileIntW(L"Host", L"SkipLoginCheck", cfg.skip_login_check, ini);
    cfg.tick_char_radius = GetPrivateProfileIntW(L"Host", L"TickCharacterRadius", cfg.tick_char_radius, ini);
    cfg.max_fps          = GetPrivateProfileIntW(L"Host", L"MaxFPS", cfg.max_fps, ini);
    cfg.conn_net_speed   = GetPrivateProfileIntW(L"Host", L"JoinerNetSpeed", cfg.conn_net_speed, ini);
    GetPrivateProfileStringW(L"Host", L"BackendUrl", L"", cfg.backend, 256, ini);
    GetPrivateProfileStringW(L"Host", L"SessionId", L"", cfg.session, 128, ini);
    GetEnvironmentVariableW(L"SOS_HOST_BACKEND", cfg.backend, 256);
    GetEnvironmentVariableW(L"SOS_HOST_SESSION", cfg.session, 128);
    GetPrivateProfileStringW(L"Host", L"SessionToken", L"", cfg.token, 512, ini);
    GetEnvironmentVariableW(L"SOS_HOST_TOKEN", cfg.token, 512);
    /* Fallback: the supervisor always passes -SESSION_ID= / -SESSION_TOKEN=. */
    if (!cfg.session[0]) cmdline_value(L"-SESSION_ID=", cfg.session, 128);
    if (!cfg.token[0])   cmdline_value(L"-SESSION_TOKEN=", cfg.token, 512);
    cfg.correct_moves    = GetPrivateProfileIntW(L"Host", L"CorrectMoves", cfg.correct_moves, ini);
    cfg.correct_dist     = GetPrivateProfileIntW(L"Host", L"CorrectDistance", cfg.correct_dist, ini);
    GetPrivateProfileStringW(L"Host", L"StatProps", L"", cfg.stat_props, 512, ini);
    cfg.test_match_end   = GetPrivateProfileIntW(L"Host", L"TestMatchEndSec", 0, ini);
    cfg.set_pawn_owner   = GetPrivateProfileIntW(L"Host", L"SetPawnOwner", cfg.set_pawn_owner, ini);
    cfg.mirror_streaming = GetPrivateProfileIntW(L"Host", L"MirrorStreamingLevels", cfg.mirror_streaming, ini);
    {
        char ev[16];
        if (GetEnvironmentVariableA("SOS_HOST_MAX_FPS", ev, sizeof ev) > 0)
            cfg.max_fps = atoi(ev);
    }

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
    uint32_t call_prereplication; /* void AActor::CallPreReplication(AActor*, UNetDriver*) */
    uint32_t stream_status_rpc; /* PC::ClientUpdateLevelStreamingStatus(pc, FName, bLoaded, bVisible, bBlock, int LOD) sender */
    uint32_t ls_package_name;   /* FName* ULevelStreaming::GetWorldAssetPackageFName(ls, FName* out) */
    uint32_t notify_destroyed;  /* void UNetDriver::NotifyActorDestroyed(drv, actor, bool bIsSeamlessTravel); server part stripped */
    /* Match stats (Classic only; 0 = not mapped) */
    uint32_t gm_killed;         /* void GameMode::Killed(GM*, AController* Killer, AController* Victim, APawn*, UDamageType*) */
    uint32_t escaped_call;      /* E8 call to UEventLogLibrary::LogPlayerEscaped(AShooterCharacter*) in its exec thunk */
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
        0, 0, 0, 0,
        0, 0,
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
        0x0eb1400, 0x1483480, 0x118a410, 0x11ea410,
        0x0168bf0, 0x031a990,
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

/* Match end. The match's end (extraction, everyone out) loads the post-game
   show's sublevel: "ActivateLevel /Game/Maps/Test_Ben/Ben_Layout_02_PostGame 1 1 0"
   right after RopeExtractionComponent.MatchHasEnded. Log one clear line for
   host supervisors and tell the backend so it can recycle the session. */
static void backend_session_event(const char *json);
static void build_match_end_json(char *out, size_t cap, float now);
static void reset_match_stats(void);
static DWORD g_match_end_tick;
static float g_world_now;   /* world seconds at the last replication pass */
static float g_match_first_pawn_pub;   /* copy of g_match_first_pawn for the log hook */
static float g_first_tracked;          /* world seconds when the first joiner was seen (test switch) */

static void match_end_on_log(const wchar_t *msg)
{
    if (!wcsstr(msg, L"ActivateLevel") || !wcsstr(msg, L"_PostGame")) {
        /* Test switch: pretend the match ended N s after the first joiner pawn. */
        static int fired;
        if (!cfg.test_match_end || fired || !g_first_tracked ||
            g_world_now - g_first_tracked < (float)cfg.test_match_end) return;
        fired = 1;
        hlog("TestMatchEndSec=%d reached", cfg.test_match_end);
    }
    DWORD t = GetTickCount();
    if (g_match_end_tick && t - g_match_end_tick < 60000) return;   /* logged twice per end */
    g_match_end_tick = t;
    hlog("[sos_host] MatchEnded reason=postgame");
    static char body[16000];
    build_match_end_json(body, sizeof body, g_world_now);
    hlog("[sos_host] MatchResults %s", body);
    backend_session_event(body);
    reset_match_stats();
}

void log_capture(uint64_t *frame)
{
    /* frame[0] = return address, frame[1..4] = homed rcx rdx r8 r9,
       frame[5] = format, frame[6..] = variadic arguments. */
    static const char *const verb_names[] = {
        "", "Fatal", "Error", "Warning", "Display", "Log", "Verbose", "VeryVerbose" };
    const FName *category = (const FName *)frame[3];
    unsigned verbosity = (unsigned)frame[4] & 0xF;
    const wchar_t *fmt = (const wchar_t *)frame[5];
    if (!fmt) return;

    DWORD saved_error = GetLastError();
    wchar_t msg[2048];
    int n = _vsnwprintf(msg, 2047, fmt, (va_list)(frame + 6));
    if (n < 0) n = 2047;
    msg[n] = 0;
    match_end_on_log(msg);
    if (g_game_log == INVALID_HANDLE_VALUE) { SetLastError(saved_error); return; }
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
#define DRV_REPFRAME      0x280   /* uint32 ReplicationFrame: property changelists are only recompared when it moves */
#define DRV_MAXTICKRATE   0x48    /* int32 NetServerMaxTickRate */
#define DRV_VT_LEVELINIT  0x300   /* bool IsLevelInitializedForActor(actor, conn) */
#define WORLD_LEVELS      0x108   /* TArray<ULevel*> */
#define WORLD_TIMESECONDS 0x878   /* float */
#define LEVEL_ACTORS      0xA0    /* TArray<AActor*> */
#define CONN_OWNINGACTOR  0x30    /* UPlayer::PlayerController */
#define CONN_NETSPEED     0x38    /* int32 UPlayer::CurrentNetSpeed, bytes/s */
#define CONN_VIEWTARGET   0x88    /* AActor* ViewTarget; multicast RPCs skip connections where it is null */
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
#define CHAR_MESH         0x3E0   /* USkeletalMeshComponent* ACharacter::Mesh */
#define OBJ_OUTER         0x20
#define MESH_UPDATEFLAG   0x704   /* uint8 MeshComponentUpdateFlag: 0 AlwaysTickPoseAndRefreshBones, 1 OnlyTickPoseWhenRendered */
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
typedef void (*CallPreRepFn)(void *actor, void *drv);

static TickFlushFn o_tick_flush;
static uint8_t **g_due;
static uint8_t *g_prepped;
static uint8_t *g_served;     /* per due actor: connections it was offered to this pass */    /* per due actor: CallPreReplication done this pass */
static int g_due_cap;
static float g_next_pass;
static unsigned g_opened, g_sent, g_passes;
static int64_t g_pass_ticks;   /* QPC ticks spent in replicate_actors */
static unsigned g_destroy_closed, g_destroy_startup;
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
static void prep_actor(uint8_t *drv, uint8_t *actor, uint8_t *done)
{
    if (done && *done) return;
    if (g_build->call_prereplication)
        ((CallPreRepFn)AT(g_build->call_prereplication))(actor, drv);
    if (done) *done = 1;
}

static int replicate_to(uint8_t *drv, uint8_t *conn, uint8_t *actor, int *opens_left, uint8_t *done)
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
    prep_actor(drv, actor, done);
    ((ReplicateActorFn)AT(g_build->replicate_actor))(ch);
    g_sent++;
    return 1;
}

static int relevant_to(uint8_t *actor, uint8_t *pc)
{
    if (!(actor[ACTOR_FLAGS] & 8)) return 1;           /* not owner-only */
    /* The engine's pawns have no Owner here (PossessedBy leaves it null), so an
       item owned by the joiner's pawn counts as the joiner's too. */
    uint8_t *pawn = *(uint8_t **)(pc + PC_PAWN);
    for (uint8_t *a = actor; a; a = *(uint8_t **)(a + ACTOR_OWNER)) {
        if (a == pc || (pawn && a == pawn)) return 1;
        if (a != actor && a == *(uint8_t **)(a + ACTOR_OWNER)) break;
    }
    return 0;
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

/* Class -> "derives from Character" cache. Only Characters get their Mesh
   field read, so the +0x3E0 read never lands outside a smaller actor. */
#define CLASS_SUPER       0x30    /* UStruct::SuperStruct */
#define OBJ_CLASS         0x10
#define OBJ_NAME          0x18
static struct { uint8_t *cls; uint8_t flags; } g_cls_cache[2048];
static uint64_t g_char_name, g_show_name, g_sps_name;
#define CLS_CHARACTER 1
#define CLS_GAMESHOW  2   /* the pregame/match show the joiner's intro plays from */
#define CLS_SHOOTERPS 4   /* AShooterPlayerState (native stat counters) */

static uint8_t class_flags(uint8_t *actor)
{
    uint8_t *cls = *(uint8_t **)(actor + OBJ_CLASS);
    if (!cls) return 0;
    if (!g_char_name) {
        FName n;
        ((FNameCtorFn)AT(g_build->fname_ctor))(&n, L"Character", 1 /* FNAME_Add */);
        memcpy(&g_char_name, &n, sizeof g_char_name);
        ((FNameCtorFn)AT(g_build->fname_ctor))(&n, L"GameShow_C", 1);
        memcpy(&g_show_name, &n, sizeof g_show_name);
        ((FNameCtorFn)AT(g_build->fname_ctor))(&n, L"ShooterPlayerState", 1);
        memcpy(&g_sps_name, &n, sizeof g_sps_name);
    }
    unsigned h = (unsigned)(((uintptr_t)cls >> 4) * 2654435761u) & 2047;
    for (unsigned k = 0; k < 2048; k++, h = (h + 1) & 2047) {
        if (g_cls_cache[h].cls == cls) return g_cls_cache[h].flags;
        if (!g_cls_cache[h].cls) {
            uint8_t r = 0;
            int depth = 0;
            for (uint8_t *c = cls; c && depth < 64; c = *(uint8_t **)(c + CLASS_SUPER), depth++) {
                uint64_t nm = *(uint64_t *)(c + OBJ_NAME);
                if (nm == g_char_name) r |= CLS_CHARACTER;
                if (nm == g_show_name) r |= CLS_GAMESHOW;
                if (nm == g_sps_name) r |= CLS_SHOOTERPS;
            }
            g_cls_cache[h].cls = cls;
            g_cls_cache[h].flags = r;
            return r;
        }
    }
    return 0;   /* cache full */
}

static int is_character(uint8_t *actor) { return class_flags(actor) & CLS_CHARACTER; }

/* ------------------------------------------------------------------------ */
/* Per-player match stats (for the backend's XP and leaderboards)            */
/* ------------------------------------------------------------------------ */

/* Read memory that may not be mapped (game objects we only half know). */
static int safe_read(const void *src, void *dst, size_t n)
{
    SIZE_T got = 0;
    return src && ReadProcessMemory(GetCurrentProcess(), src, dst, n, &got) && got == n;
}

#define STRUCT_CHILDREN   0x38    /* UStruct::Children (UField*) */
#define FIELD_NEXT        0x28    /* UField::Next */
#define PROP_OFFSET       0x50    /* UProperty::Offset_Internal */
#define PS_UNIQUEID       0x3d8   /* FUniqueNetId* inside APlayerState::UniqueId */

/* Find a reflected property by name on obj's class chain. Returns its offset
   and the FName of its property class (IntProperty, FloatProperty, ...), or -1. */
static int find_prop_f(uint8_t *obj, const wchar_t *name, uint64_t *type, uint8_t **field)
{
    FName fn;
    ((FNameCtorFn)AT(g_build->fname_ctor))(&fn, name, 0 /* FNAME_Find */);
    if (!fn.v) return -1;
    uint8_t *cls = *(uint8_t **)(obj + OBJ_CLASS);
    for (int depth = 0; cls && depth < 64; cls = *(uint8_t **)(cls + CLASS_SUPER), depth++) {
        int guard = 0;
        for (uint8_t *f = *(uint8_t **)(cls + STRUCT_CHILDREN); f && guard < 4096; f = *(uint8_t **)(f + FIELD_NEXT), guard++) {
            if (*(uint64_t *)(f + OBJ_NAME) != fn.v) continue;
            uint8_t *fcls = *(uint8_t **)(f + OBJ_CLASS);
            if (type) *type = fcls ? *(uint64_t *)(fcls + OBJ_NAME) : 0;
            if (field) *field = f;
            return *(int32_t *)(f + PROP_OFFSET);
        }
    }
    return -1;
}
#define find_prop(o, n, t) find_prop_f(o, n, t, NULL)

static void json_escape(char *out, size_t cap, const wchar_t *in, int n)
{
    size_t o = 0;
    for (int i = 0; in && i < n && in[i] && o + 7 < cap; i++) {
        wchar_t c = in[i];
        if (c == L'"' || c == L'\\') { out[o++] = '\\'; out[o++] = (char)c; }
        else if (c < 0x20 || c > 0x7e) o += snprintf(out + o, cap - o, "\\u%04x", (unsigned)c);
        else out[o++] = (char)c;
    }
    out[o] = 0;
}

/* Steam ID (or backend id string) of a PlayerState, "" if unknown. */
static void ps_player_id(uint8_t *ps, char *out, size_t cap)
{
    out[0] = 0;
    uint8_t *id = NULL, raw[48];
    if (!safe_read(ps + PS_UNIQUEID, &id, sizeof id) || !safe_read(id, raw, sizeof raw)) {
        static int said;
        if (!said++) hlog("PlayerState %p: no UniqueId object (%p)", (void *)ps, (void *)id);
        /* No online id (Steam off on that client): fall back to the match-local
           PlayerId so the player is still listed; the backend can't credit it. */
        snprintf(out, cap, "player-%d", *(int32_t *)(ps + PS_PLAYERID));
        return;
    }
    {
        static int said;
        if (said++ < 4)
            hlog("PlayerState %p UniqueId %p: %016llx %016llx %016llx %016llx %016llx %016llx",
                 (void *)ps, (void *)id, ((unsigned long long *)raw)[0], ((unsigned long long *)raw)[1],
                 ((unsigned long long *)raw)[2], ((unsigned long long *)raw)[3], ((unsigned long long *)raw)[4],
                 ((unsigned long long *)raw)[5]);
    }
    /* FUniqueNetId derives from TSharedFromThis: vtable, WeakThis (self pointer
       and reference controller), then the subclass data at +24 (a Steam id as
       uint64, or an FString). +8 is kept as a fallback for other layouts. */
    static const int offs[2] = { 24, 8 };
    for (int k = 0; k < 2; k++) {
        uint64_t v; memcpy(&v, raw + offs[k], 8);
        if ((v >> 32) == 0x01100001ull) { snprintf(out, cap, "%llu", (unsigned long long)v); return; }
    }
    for (int k = 0; k < 2; k++) {
        FString s; memcpy(&s, raw + offs[k], sizeof s);          /* FUniqueNetIdString */
        wchar_t buf[64];
        if (s.num > 1 && s.num < 64 && safe_read(s.data, buf, s.num * sizeof(wchar_t))) {
            json_escape(out, cap, buf, s.num - 1);
            if (out[0]) return;
        }
    }
    /* Unknown layout: keep the player listed under its match-local id. */
    snprintf(out, cap, "player-%d", *(int32_t *)(ps + PS_PLAYERID));
}

static void ps_name(uint8_t *ps, char *out, size_t cap)
{
    static int off = -2;
    out[0] = 0;
    if (off == -2) off = find_prop(ps, L"PlayerName", NULL);
    if (off < 0) return;
    FString s; wchar_t buf[128];
    if (safe_read(ps + off, &s, sizeof s) && s.num > 1 && s.num < 128 && safe_read(s.data, buf, s.num * sizeof(wchar_t)))
        json_escape(out, cap, buf, s.num - 1);
}

#define MAX_TRACKED 64
static struct {
    uint8_t *pc, *ps;
    char id[48], name[96];
    float first_pawn, last_alive;   /* world seconds; 0 = never */
    int had_pawn, deaths, connected, escaped;
    unsigned seen;
    /* Last stats read from the PlayerState, kept for when the player has left
       (the PlayerState is gone by the time the match ends). */
    int sn_native, sn_score_ok;
    int sn_kills, sn_npc_kills, sn_deaths, sn_dealt, sn_dealt_npc, sn_taken, sn_taken_npc, sn_healed, sn_team, sn_score;
    char sn_props[512];
    float sn_time;
} g_pl[MAX_TRACKED];
static void snapshot_player(int slot, float now, int force);
static float g_match_first_pawn;
static char g_match_id[40], g_started_at[40];   /* set when the first joiner gets a pawn */

static void new_match_id(void)
{
    unsigned r[4] = { 0 };
    for (int i = 0; i < 4; i++) rand_s(&r[i]);
    r[1] = (r[1] & 0xffff0fffu) | 0x00004000u;               /* version 4 */
    r[2] = (r[2] & 0x3fffffffu) | 0x80000000u;               /* variant */
    snprintf(g_match_id, sizeof g_match_id, "%08x-%04x-%04x-%04x-%04x%08x",
             r[0], r[1] >> 16, r[1] & 0xffff, r[2] >> 16, r[2] & 0xffff, r[3]);
    SYSTEMTIME st; GetSystemTime(&st);
    snprintf(g_started_at, sizeof g_started_at, "%04u-%02u-%02uT%02u:%02u:%02uZ",
             st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    hlog("[sos_host] MatchStarted matchId=%s startedAt=%s", g_match_id, g_started_at);
}

/* Once per replication pass, for each connected joiner. */
static void track_player(uint8_t *pc, float now, unsigned pass)
{
    int slot = -1;
    for (int i = 0; i < MAX_TRACKED; i++)
        if (g_pl[i].pc == pc) { slot = i; break; }
    if (slot >= 0 && !g_pl[slot].connected && g_pl[slot].seen) {
        /* A new connection reusing a departed player's controller address. */
        slot = -1;
        for (int i = 0; i < MAX_TRACKED; i++)
            if (g_pl[i].pc == pc) g_pl[i].pc = (uint8_t *)(uintptr_t)1;   /* keep its record, release the address */
    }
    if (slot < 0)
        for (int i = 0; i < MAX_TRACKED; i++)
            if (!g_pl[i].pc) { slot = i; g_pl[i].pc = pc; break; }
    if (slot < 0) return;
    uint8_t *ps = *(uint8_t **)(pc + PC_PLAYERSTATE);
    /* Re-read while the id is unknown or only the match-local "player-N" one:
       the replicated UniqueId can arrive after the controller. */
    if (ps && (ps != g_pl[slot].ps || !g_pl[slot].id[0] || !strncmp(g_pl[slot].id, "player-", 7))) {
        char old_id[48];
        memcpy(old_id, g_pl[slot].id, sizeof old_id);
        g_pl[slot].ps = ps;
        ps_player_id(ps, g_pl[slot].id, sizeof g_pl[slot].id);
        ps_name(ps, g_pl[slot].name, sizeof g_pl[slot].name);
        if (g_pl[slot].id[0] && strcmp(old_id, g_pl[slot].id))
            hlog("Player %s (%s) tracked", g_pl[slot].id, g_pl[slot].name);
    }
    uint8_t *p = *(uint8_t **)(pc + PC_PAWN);
    int alive = p && !((IsPendingKillFn)AT(g_build->is_pending_kill))(p);
    if (alive) {
        if (!g_pl[slot].first_pawn) g_pl[slot].first_pawn = now;
        if (!g_match_first_pawn) { g_match_first_pawn = now; new_match_id(); }
        g_pl[slot].last_alive = now;
    } else if (g_pl[slot].had_pawn) {
        g_pl[slot].deaths++;
        hlog("Player %s lost its pawn at %.0f s", g_pl[slot].id, now);
    }
    if (!g_first_tracked) g_first_tracked = now > 0 ? now : 0.001f;
    g_pl[slot].had_pawn = alive;
    g_pl[slot].connected = 1;
    g_pl[slot].seen = pass;
    snapshot_player(slot, now, 0);
}

/* After a pass: joiners not seen in it have left. */
static void track_disconnects(unsigned pass)
{
    for (int i = 0; i < MAX_TRACKED; i++)
        if (g_pl[i].pc && g_pl[i].connected && g_pl[i].seen != pass) {
            g_pl[i].connected = 0;
            g_pl[i].had_pawn = 0;   /* leaving is not a death */
        }
}

/* Append ,"Name":value for each PlayerState property listed in StatProps. */
static size_t stat_props_json(uint8_t *ps, char *out, size_t cap)
{
    size_t o = 0;
    if (!ps || !cfg.stat_props[0]) return 0;
    static FName t_int, t_float, t_byte, t_bool;
    if (!t_int.v) {
        ((FNameCtorFn)AT(g_build->fname_ctor))(&t_int, L"IntProperty", 1);
        ((FNameCtorFn)AT(g_build->fname_ctor))(&t_float, L"FloatProperty", 1);
        ((FNameCtorFn)AT(g_build->fname_ctor))(&t_byte, L"ByteProperty", 1);
        ((FNameCtorFn)AT(g_build->fname_ctor))(&t_bool, L"BoolProperty", 1);
    }
    wchar_t list[512];
    wcsncpy(list, cfg.stat_props, 511); list[511] = 0;
    wchar_t *ctx = NULL;
    for (wchar_t *nm = wcstok(list, L", ", &ctx); nm; nm = wcstok(NULL, L", ", &ctx)) {
        uint64_t type = 0;
        uint8_t *field = NULL;
        int off = find_prop_f(ps, nm, &type, &field);
        if (off < 0 || o + 96 > cap) continue;
        char key[96]; json_escape(key, sizeof key, nm, (int)wcslen(nm));
        if (type == t_int.v)        o += snprintf(out + o, cap - o, ",\"%s\":%d", key, *(int32_t *)(ps + off));
        else if (type == t_float.v) o += snprintf(out + o, cap - o, ",\"%s\":%.2f", key, *(float *)(ps + off));
        else if (type == t_byte.v)  o += snprintf(out + o, cap - o, ",\"%s\":%u", key, ps[off]);
        else if (type == t_bool.v) {
            /* UBoolProperty: FieldSize, ByteOffset, ByteMask, FieldMask follow
               UProperty (0x70 bytes in 4.12). */
            uint8_t bo = field[0x71], mask = field[0x72];
            if (!mask) mask = 0xff;
            o += snprintf(out + o, cap - o, ",\"%s\":%s", key, (ps[off + bo] & mask) ? "true" : "false");
        }
    }
    return o;
}

static int pl_slot(const uint8_t *pc)
{
    for (int i = 0; pc && i < MAX_TRACKED; i++)
        if (g_pl[i].pc == pc) return i;
    return -1;
}

static void post_player_event(const char *event, int who, int other)
{
    if (who < 0 || !g_pl[who].id[0]) return;
    char body[512];
    int n = snprintf(body, sizeof body, "{\"type\":\"player-event\",\"event\":\"%s\",\"playerId\":\"%s\"",
                     event, g_pl[who].id);
    if (other >= 0 && g_pl[other].id[0])
        n += snprintf(body + n, sizeof body - n, ",\"otherId\":\"%s\"", g_pl[other].id);
    if (g_match_id[0])
        n += snprintf(body + n, sizeof body - n, ",\"matchId\":\"%s\"", g_match_id);
    if (g_match_first_pawn > 0)
        n += snprintf(body + n, sizeof body - n, ",\"atSec\":%.0f", g_world_now - g_match_first_pawn);
    snprintf(body + n, sizeof body - n, "}");
    hlog("[sos_host] PlayerEvent %s", body);
    backend_session_event(body);
}

/* GameMode::Killed(GM, KillerController, VictimController, VictimPawn, DamageType):
   the native kill handler that bumps the PlayerState kill and death counters. */
typedef void (*KilledFn)(void *gm, uint8_t *killer, uint8_t *victim, void *pawn, void *dmg);
static KilledFn o_killed;
static void h_killed(void *gm, uint8_t *killer, uint8_t *victim, void *pawn, void *dmg)
{
    o_killed(gm, killer, victim, pawn, dmg);
    int k = pl_slot(killer), v = pl_slot(victim);
    if (v >= 0) post_player_event("death", v, k);
    if (k >= 0 && v >= 0 && k != v) post_player_event("kill", k, v);
}

/* UEventLogLibrary::LogPlayerEscaped(AShooterCharacter*): the Blueprint escape
   path (helicopter or rope extraction) calls it once per escaping player. */
typedef void (*EscapedFn)(uint8_t *ch);
static EscapedFn o_escaped;
static void h_escaped(uint8_t *ch)
{
    for (int i = 0; ch && i < MAX_TRACKED; i++)
        if (g_pl[i].pc && g_pl[i].connected && *(uint8_t **)(g_pl[i].pc + PC_PAWN) == ch) {
            g_pl[i].escaped = 1;
            post_player_event("escape", i, -1);
            break;
        }
    o_escaped(ch);
}

static void reset_match_stats(void)
{
    memset(g_pl, 0, sizeof g_pl);
    g_match_first_pawn = 0;
    g_match_id[0] = g_started_at[0] = 0;
}

/* AShooterPlayerState counters (offsets from the Classic build, V). */
#define SPS_TEAM            0x688
#define SPS_PLAYER_KILLS    0x690
#define SPS_NPC_KILLS       0x694
#define SPS_DEATHS          0x698
#define SPS_DMG_TAKEN_PL    0x6a4
#define SPS_DMG_TAKEN_NPC   0x6a8
#define SPS_DMG_HEALED      0x6ac
#define SPS_DMG_DEALT_PL    0x6b0
#define SPS_DMG_DEALT_NPC   0x6b4

/* PlayerState_Survival_C's Blueprint bool "Escaped" (offset found by name). */
static int ps_escaped(uint8_t *ps)
{
    uint64_t type = 0; uint8_t *field = NULL;
    int off = find_prop_f(ps, L"Escaped", &type, &field);
    if (off < 0 || !field) return -1;
    uint8_t bo = field[0x71], mask = field[0x72];
    if (!mask) mask = 0xff;
    return (ps[off + bo] & mask) != 0;
}

static int ps_int_prop(uint8_t *ps, const wchar_t *name, int *out)
{
    static FName t_int;
    if (!t_int.v) ((FNameCtorFn)AT(g_build->fname_ctor))(&t_int, L"IntProperty", 1);
    uint64_t type = 0;
    int off = find_prop(ps, name, &type);
    if (off < 0 || type != t_int.v) return 0;
    *out = *(int32_t *)(ps + off);
    return 1;
}

/* 1 = escaped; otherwise players still alive at the end, then the latest to die. */
static int better_than(int a, int b, float now)
{
    if (g_pl[a].escaped != g_pl[b].escaped) return g_pl[a].escaped;
    if (g_pl[a].escaped) return 0;
    int aa = g_pl[a].had_pawn && g_pl[a].connected, ab = g_pl[b].had_pawn && g_pl[b].connected;
    if (aa != ab) return aa;
    if (aa) return 0;
    (void)now;
    return g_pl[a].last_alive > g_pl[b].last_alive + 0.5f;
}

/* Copy the live PlayerState's stats into the slot's snapshot (about once a second). */
static void snapshot_player(int slot, float now, int force)
{
    uint8_t *ps = g_pl[slot].connected || force ? g_pl[slot].ps : NULL;
    if (!ps || !(class_flags(ps) & CLS_SHOOTERPS)) return;
    if (!force && g_pl[slot].sn_time && now - g_pl[slot].sn_time < 1.0f) return;
    g_pl[slot].sn_time = now > 0 ? now : 0.001f;
    g_pl[slot].sn_native = 1;
    g_pl[slot].sn_kills = *(int32_t *)(ps + SPS_PLAYER_KILLS);
    g_pl[slot].sn_npc_kills = *(int32_t *)(ps + SPS_NPC_KILLS);
    g_pl[slot].sn_deaths = *(int32_t *)(ps + SPS_DEATHS);
    g_pl[slot].sn_dealt = *(int32_t *)(ps + SPS_DMG_DEALT_PL);
    g_pl[slot].sn_dealt_npc = *(int32_t *)(ps + SPS_DMG_DEALT_NPC);
    g_pl[slot].sn_taken = *(int32_t *)(ps + SPS_DMG_TAKEN_PL);
    g_pl[slot].sn_taken_npc = *(int32_t *)(ps + SPS_DMG_TAKEN_NPC);
    g_pl[slot].sn_healed = *(int32_t *)(ps + SPS_DMG_HEALED);
    g_pl[slot].sn_team = *(int32_t *)(ps + SPS_TEAM);
    g_pl[slot].sn_score_ok = ps_int_prop(ps, L"TotalScore", &g_pl[slot].sn_score);
    if (ps_escaped(ps) == 1) g_pl[slot].escaped = 1;
    g_pl[slot].sn_props[0] = 0;
    stat_props_json(ps, g_pl[slot].sn_props, sizeof g_pl[slot].sn_props);
}

/* JSON body of the match-end event, with one entry per joiner seen this match. */
static void build_match_end_json(char *out, size_t cap, float now)
{
    /* Escaped flags from the PlayerStates (the escape hook may have set them already). */
    for (int i = 0; i < MAX_TRACKED; i++)
        if (g_pl[i].pc && g_pl[i].connected && g_pl[i].ps)
            snapshot_player(i, now, 1);
    size_t o = (size_t)snprintf(out, cap, "{\"type\":\"match-end\",\"reason\":\"postgame\"");
    if (g_match_id[0])
        o += snprintf(out + o, cap - o, ",\"matchId\":\"%s\",\"startedAt\":\"%s\"", g_match_id, g_started_at);
    if (g_match_first_pawn > 0 && now > g_match_first_pawn)
        o += snprintf(out + o, cap - o, ",\"durationSec\":%.0f", now - g_match_first_pawn);
    o += snprintf(out + o, cap - o, ",\"players\":[");
    int n = 0;
    for (int i = 0; i < MAX_TRACKED && o + 512 < cap; i++) {
        if (!g_pl[i].pc || !g_pl[i].id[0]) continue;
        int alive = g_pl[i].had_pawn && g_pl[i].connected;
        int native = g_pl[i].sn_native;
        /* The game's own death count; our pawn-loss count also counts an escape. */
        int deaths = native ? g_pl[i].sn_deaths : g_pl[i].deaths;
        o += snprintf(out + o, cap - o, "%s{\"playerId\":\"%s\",\"name\":\"%s\",\"connected\":%s,\"aliveAtEnd\":%s,\"deaths\":%d",
                      n++ ? "," : "", g_pl[i].id, g_pl[i].name, g_pl[i].connected ? "true" : "false",
                      alive ? "true" : "false", deaths);
        if (g_pl[i].first_pawn > 0)
            o += snprintf(out + o, cap - o, ",\"survivalSec\":%.0f",
                          (alive ? now : g_pl[i].last_alive) - g_pl[i].first_pawn);
        int place = 1;
        for (int j = 0; j < MAX_TRACKED; j++)
            if (j != i && g_pl[j].pc && g_pl[j].id[0] && better_than(j, i, now)) place++;
        o += snprintf(out + o, cap - o, ",\"escaped\":%s,\"placement\":%d",
                      g_pl[i].escaped ? "true" : "false", place);
        if (native) {
            o += snprintf(out + o, cap - o,
                          ",\"kills\":%d,\"npcKills\":%d,\"damageDealt\":%d,\"damageDealtNpc\":%d,"
                          "\"damageTaken\":%d,\"damageTakenNpc\":%d,\"damageHealed\":%d,\"teamId\":%d",
                          g_pl[i].sn_kills, g_pl[i].sn_npc_kills, g_pl[i].sn_dealt, g_pl[i].sn_dealt_npc,
                          g_pl[i].sn_taken, g_pl[i].sn_taken_npc, g_pl[i].sn_healed, g_pl[i].sn_team);
            if (g_pl[i].sn_score_ok) o += snprintf(out + o, cap - o, ",\"score\":%d", g_pl[i].sn_score);
        }
        o += snprintf(out + o, cap - o, "%s", g_pl[i].sn_props);
        o += snprintf(out + o, cap - o, "}");
    }
    snprintf(out + o, cap - o, "]}");
}

/* A listen host only ticks a skeletal mesh's pose while it is rendered there
   (OnlyTickPoseWhenRendered). Off the host's screen, montages on joiner pawns
   and AI never advance: no AnimNotifies (eating, melee hit windows) and no root
   motion. A dedicated server ticks every pose; do that for Characters. */
static void tick_pose_always(uint8_t *ch)
{
    uint8_t *mesh = *(uint8_t **)(ch + CHAR_MESH);
    if (mesh && *(uint8_t **)(mesh + OBJ_OUTER) == ch && mesh[MESH_UPDATEFLAG] == 1)
        mesh[MESH_UPDATEFLAG] = 0;
}

/* Streaming levels. The host loads sublevels (the pregame intro, end-of-match
   cameras) with BP LoadStreamLevel, which only tells PCs already in the
   world's list; the join catch-up (PostLogin) never runs for our joiners. So
   mirror the host's StreamingLevels to each joiner: everything once its pawn
   exists, then every change. */
#define WORLD_STREAMINGLEVELS 0x90    /* TArray<ULevelStreaming*> */
#define LS_FLAGS          0xB0    /* bit5 bShouldBeLoaded, bit6 bShouldBeVisible, bit7 bShouldBlockOnLoad */
#define LS_LODINDEX       0xB4
#define MAX_TRACKED_CONNS 32
#define MAX_TRACKED_LEVELS 128
typedef void (*StreamStatusFn)(void *pc, uint64_t name, uint8_t loaded, uint8_t visible, uint8_t block, int lod);
typedef uint64_t *(*LsPackageNameFn)(void *ls, uint64_t *out);
static struct {
    uint8_t *conn, *pc;
    void *level[MAX_TRACKED_LEVELS];
    uint8_t sent[MAX_TRACKED_LEVELS];   /* 0x80 | loaded | visible<<1 | block<<2 */
} g_stream[MAX_TRACKED_CONNS];

static void mirror_streaming(uint8_t *world, uint8_t *conn, uint8_t *pc)
{
    if (!g_build->stream_status_rpc || !g_build->ls_package_name) return;
    if (!*(uint8_t **)(pc + PC_PAWN)) return;    /* joiner still loading the map */
    int slot = -1, free_slot = -1;
    for (int i = 0; i < MAX_TRACKED_CONNS; i++) {
        if (g_stream[i].conn == conn) { slot = i; break; }
        if (free_slot < 0 && !g_stream[i].conn) free_slot = i;
    }
    if (slot < 0) {
        if (free_slot < 0) {   /* table full: drop entries of closed connections */
            free_slot = 0;
        }
        slot = free_slot;
        memset(&g_stream[slot], 0, sizeof g_stream[slot]);
        g_stream[slot].conn = conn;
    }
    if (g_stream[slot].pc != pc) {   /* new controller on this connection: resend all */
        memset(g_stream[slot].sent, 0, sizeof g_stream[slot].sent);
        memset(g_stream[slot].level, 0, sizeof g_stream[slot].level);
        g_stream[slot].pc = pc;
    }
    uint8_t **lv = *(uint8_t ***)(world + WORLD_STREAMINGLEVELS);
    int n = *(int32_t *)(world + WORLD_STREAMINGLEVELS + 8);
    if (!lv || n <= 0) return;
    if (n > MAX_TRACKED_LEVELS) n = MAX_TRACKED_LEVELS;
    for (int i = 0; i < n; i++) {
        uint8_t *ls = lv[i];
        if (!ls) continue;
        uint32_t f = *(uint32_t *)(ls + LS_FLAGS);
        uint8_t loaded = (f >> 5) & 1, visible = (f >> 6) & 1, block = (f >> 7) & 1;
        uint8_t st = 0x80 | loaded | visible << 1 | block << 2;
        if (g_stream[slot].level[i] == ls && g_stream[slot].sent[i] == st) continue;
        uint64_t name = 0;
        uint64_t *pn = ((LsPackageNameFn)AT(g_build->ls_package_name))(ls, &name);
        if (!pn || !*pn) continue;
        ((StreamStatusFn)AT(g_build->stream_status_rpc))(pc, *pn, loaded, visible, block,
                                                           *(int32_t *)(ls + LS_LODINDEX));
        hlog("Streaming level %d -> %p: loaded=%d visible=%d block=%d", i, (void *)pc, loaded, visible, block);
        g_stream[slot].level[i] = ls;
        g_stream[slot].sent[i] = st;
    }
}

static void replicate_actors(uint8_t *drv)
{
    if (*(void **)(drv + DRV_SERVERCONN)) return;              /* client */
    uint8_t **conns = *(uint8_t ***)(drv + DRV_CLIENTCONNS);
    int nconns = *(int32_t *)(drv + DRV_CLIENTCONNS + 8);
    uint8_t *world = *(uint8_t **)(drv + DRV_WORLD);
    if (!world) return;
    if (*(uint8_t **)(world + UWORLD_NETDRIVER) != drv) return;  /* game driver only, not demo */
    if (!conns || nconns <= 0) {
        /* The last joiner left: nobody is connected any more. Mark every
           tracked player disconnected (their snapshots stay for the match-end
           event) and keep the world clock moving for it. */
        track_disconnects(~0u);
        g_world_now = *(float *)(world + WORLD_TIMESECONDS);
        /* The host supervisor reads this line to see that everyone has left
           (it waits for the post-game show to finish before recycling the game). */
        static DWORD last_idle_log;
        DWORD t = GetTickCount();
        if (t - last_idle_log >= 10000) {
            last_idle_log = t;
            hlog("[sos_host] Players alive=0 connected=0");
        }
        return;
    }

    float now = *(float *)(world + WORLD_TIMESECONDS);
    int rate = *(int32_t *)(drv + DRV_MAXTICKRATE);
    if (rate < 5 || rate > 120) rate = 30;
    if (now < g_next_pass && now + 5.0f > g_next_pass) return;
    g_next_pass = now + 1.0f / rate;
    g_passes++;
    /* Stock ServerReplicateActors starts with ReplicationFrame++. Without it
       FReplicationChangelistMgr::Update reuses the first compare forever, so
       only an actor's initial state is ever sent. */
    (*(uint32_t *)(drv + DRV_REPFRAME))++;

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
                g_due = p;
                uint8_t *pp = (uint8_t *)realloc(g_prepped, cap);
                if (!pp) break;
                g_prepped = pp;
                uint8_t *sv = (uint8_t *)realloc(g_served, cap);
                if (!sv) break;
                g_served = sv; g_due_cap = cap;
            }
            g_prepped[ndue] = 0;
            g_served[ndue] = 0;
            g_due[ndue++] = a;
        }
    }

    int nserved_conns = 0;   /* connections processed this pass; g_served[i] counts offers */
    for (int c = 0; c < nconns; c++) {
        uint8_t *conn = conns[c];
        if (!conn || *(int32_t *)(conn + CONN_STATE) == 1) continue;
        uint8_t *pc = *(uint8_t **)(conn + CONN_OWNINGACTOR);
        if (!pc) continue;
        track_player(pc, now, g_passes);
        int opens_left = 64;
        /* Stock ServerReplicateActors sets this every frame; the multicast path in
           UIpNetDriver::ProcessRemoteFunction skips connections without one. */
        {
            uint8_t *vt_pawn = *(uint8_t **)(pc + PC_PAWN);
            *(uint8_t **)(conn + CONN_VIEWTARGET) = vt_pawn ? vt_pawn : pc;
        }
        if (cfg.mirror_streaming) mirror_streaming(world, conn, pc);
        /* The client asks for its ConfiguredInternetSpeed (100000) and the host
           clamps it to MaxClientRate, so a joiner over the internet gets
           100 KB/s: the first seconds of map actors saturate it and its own
           pawn's position and corrections are dropped for a minute or more.
           (A local joiner is LAN-rated and never saw this.) */
        if (cfg.conn_net_speed > 0 && *(int32_t *)(conn + CONN_NETSPEED) != cfg.conn_net_speed) {
            hlog("Joiner %p net speed %d -> %d", (void *)pc, *(int32_t *)(conn + CONN_NETSPEED), cfg.conn_net_speed);
            *(int32_t *)(conn + CONN_NETSPEED) = cfg.conn_net_speed;
        }
        /* A listen host never renders the joiner's character, so with the
           default OnlyTickPoseWhenRendered its montages don't tick here: no
           AnimNotifies (eat, use, melee hit windows) and no root motion. A
           dedicated server ticks every pose; do the same for joiner pawns. */
        {
            uint8_t *p = *(uint8_t **)(pc + PC_PAWN);
            if (p && is_character(p)) tick_pose_always(p);
        }
        /* PossessedBy on this host leaves the pawn's Owner null (a dedicated
           server sets it to the controller). Owner replicates, and the joiner
           uses it for bOwnerNoSee/bOnlyOwnerSee: with no owner it draws its own
           third-person body around the first-person camera ("camera inside
           my head") and hides its first-person arms. */
        {
            uint8_t *p = *(uint8_t **)(pc + PC_PAWN);
            if (cfg.set_pawn_owner && p && !*(uint8_t **)(p + ACTOR_OWNER)) {
                *(uint8_t **)(p + ACTOR_OWNER) = pc;
                hlog("Pawn %p: Owner set to its controller %p", (void *)p, (void *)pc);
            }
        }
        /* The joiner's own controller, pawn and player state first. */
        uint8_t *own[3] = { pc, *(uint8_t **)(pc + PC_PAWN), *(uint8_t **)(pc + PC_PLAYERSTATE) };
        int ok = 1;
        for (int k = 0; k < 3 && ok; k++)
            if (own[k] && (own[k][ACTOR_FLAGS2] & 4) && !pending_kill(own[k]))
                ok = replicate_to(drv, conn, own[k], &opens_left, NULL);
        const float *ploc_any = NULL;
        if (own[1]) {
            uint8_t *root = *(uint8_t **)(own[1] + ACTOR_ROOTCOMP);
            if (root) ploc_any = (const float *)(root + ACTOR_COMPLOC);
        }
        const float *ploc = cfg.replicate_startup == 2 ? ploc_any : NULL;
        float radius = (float)cfg.startup_radius;
        /* Two phases: everything dynamic (GameState, players, AI, loot) first,
           then map-placed actors with a smaller opening budget, so a joiner's
           first seconds of bandwidth don't go to thousands of crates and
           obstructions while it waits on its loading screen. */
        int startup_opens = 16;
        for (int phase = 0; phase < 2 && ok; phase++) {
            for (int i = 0; i < ndue; i++) {
                uint8_t *a = g_due[i];
                int startup = (a[ACTOR_FLAGS] & 4) != 0;
                if (startup != phase) continue;
                if (a == own[0] || a == own[1] || a == own[2] || !relevant_to(a, pc)) { g_served[i]++; continue; }
                if (cfg.tick_char_radius > 0 && ploc_any && is_character(a) &&
                    near_loc(a, ploc_any, (float)cfg.tick_char_radius))
                    tick_pose_always(a);
                /* Always-relevant map actors and the GameShow (the pregame intro and
                   match flow play on the joiner from its replicated segment index)
                   go to every joiner at once, pawn or not, near or not. */
                if (cfg.replicate_startup == 2 && startup &&
                    !(a[ACTOR_FLAGS] & 0x10) && !(class_flags(a) & CLS_GAMESHOW)) {
                    /* No pawn yet: hold map actors back. Not yet near: skip; a channel
                       that is already open keeps getting updates. */
                    if (!ploc) { g_served[i]++; continue; }
                    if (!near_loc(a, ploc, radius) && !find_actor_channel(conn, a)) { g_served[i]++; continue; }
                }
                if (!replicate_to(drv, conn, a, startup ? &startup_opens : &opens_left, &g_prepped[i])) { ok = 0; break; }
                g_served[i]++;
            }
        }
        nserved_conns++;
    }
    track_disconnects(g_passes);
    g_world_now = now;
    g_match_first_pawn_pub = g_match_first_pawn;

    int done_upto = 0;
    for (int i = 0; i < ndue; i++) {
        if (g_served[i] < nserved_conns) continue;   /* not offered to every connection yet */
        done_upto++;
        float f = *(float *)(g_due[i] + ACTOR_NETUPDATEFREQ);
        if (!(f >= 1.0f)) f = 1.0f;
        if (f > (float)rate) f = (float)rate;
        *(float *)(g_due[i] + ACTOR_NETUPDATETIME) = now + 1.0f / f;
    }

    DWORD t = GetTickCount();
    if (t - g_last_report >= 10000) {
        LARGE_INTEGER f;
        QueryPerformanceFrequency(&f);
        hlog("ReplicateActors: %d connection(s), %d due, %d fully served, %u channels opened, %u updates sent, %u passes, %.0f ms in passes over %.1f s, %u destroy closes (%u startup)",
             nconns, ndue, done_upto, g_opened, g_sent, g_passes,
             g_pass_ticks * 1000.0 / f.QuadPart, (t - g_last_report) / 1000.0,
             g_destroy_closed, g_destroy_startup);
        g_pass_ticks = 0;
        g_last_report = t;
        int alive = 0, connected = 0;
        for (int c = 0; c < nconns; c++) {
            uint8_t *conn = conns[c];
            if (!conn || *(int32_t *)(conn + CONN_STATE) == 1) continue;
            uint8_t *pc = *(uint8_t **)(conn + CONN_OWNINGACTOR);
            if (!pc) continue;
            connected++;
            uint8_t *p = *(uint8_t **)(pc + PC_PAWN);
            if (p && !pending_kill(p)) alive++;
        }
        hlog("[sos_host] Players alive=%d connected=%d", alive, connected);
    }
}

/* Frame cap. TickFlush runs once per engine frame, so sleeping here until the
   next frame is due caps the whole host (game tick, rendering, net) at MaxFPS.
   The client build has no server tick-rate limit of its own. */
static void cap_frame(void)
{
    static LARGE_INTEGER freq, next;
    static HANDLE timer;
    static int init;
    if (!init) {
        init = 1;
        QueryPerformanceFrequency(&freq);
        timer = CreateWaitableTimerExW(NULL, NULL, 0x2 /* HIGH_RESOLUTION */, TIMER_ALL_ACCESS);
        if (!timer) timer = CreateWaitableTimerW(NULL, TRUE, NULL);
        hlog("MaxFPS=%d (%s timer)", cfg.max_fps, timer ? "waitable" : "Sleep");
    }
    LARGE_INTEGER now;
    QueryPerformanceCounter(&now);
    int64_t period = freq.QuadPart / cfg.max_fps;
    if (!next.QuadPart || now.QuadPart - next.QuadPart > period * 4) next = now;  /* first frame or long hitch */
    int64_t wait = next.QuadPart - now.QuadPart;
    if (wait > 0) {
        int64_t hns = wait * 10000000 / freq.QuadPart;
        LARGE_INTEGER due; due.QuadPart = -hns;
        if (timer && SetWaitableTimer(timer, &due, 0, NULL, NULL, FALSE))
            WaitForSingleObject(timer, (DWORD)(hns / 10000 + 50));
        else
            Sleep((DWORD)(hns / 10000));
    }
    next.QuadPart += period;
}

/* Destroyed actors. The client build's UNetDriver::NotifyActorDestroyed only
   drops the property tracker: the server part (close each connection's
   channel, remember destroyed startup actors) is compiled out, so joiners
   keep ghosts of everything the host destroys (picked-up items, broken
   obstructions, used loot). Here, while the actor is still valid:
   - a connection with a channel for it gets the channel closed, which makes
     the client destroy its copy;
   - a map-placed (bNetStartup) actor the connection never received gets a
     channel opened, its first bunch sent (the client resolves its stable
     name to its own copy of the map actor) and closed at once.
   Not covered: joiners that connect after the destroy (the stock engine
   keeps a DestroyedStartupOrDormantActors list for them). */
#define CH_FLAGS          0x30    /* 2 = Closing */
#define CH_VT_CLOSE       0x1F0   /* UChannel::Close (0x141063820 in Classic) */
typedef void (*NotifyDestroyedFn)(uint8_t *drv, uint8_t *actor, int seamless);
typedef void (*ChanCloseFn)(void *ch);
static NotifyDestroyedFn o_notify_destroyed;

static void h_notify_destroyed(uint8_t *drv, uint8_t *actor, int seamless)
{
    if (cfg.replicate_actors && actor && !seamless && !*(void **)(drv + DRV_SERVERCONN) &&
        (actor[ACTOR_FLAGS2] & 4)) {
        uint8_t *world = *(uint8_t **)(drv + DRV_WORLD);
        uint8_t **conns = *(uint8_t ***)(drv + DRV_CLIENTCONNS);
        int nconns = *(int32_t *)(drv + DRV_CLIENTCONNS + 8);
        int startup = (actor[ACTOR_FLAGS] & 4) && cfg.replicate_startup;
        if (world && *(uint8_t **)(world + UWORLD_NETDRIVER) == drv && conns &&
            *(uint64_t *)(actor + ACTOR_NETDRIVER) == *(uint64_t *)(drv + DRV_NAME)) {
            for (int c = 0; c < nconns; c++) {
                uint8_t *conn = conns[c];
                if (!conn || *(int32_t *)(conn + CONN_STATE) == 1) continue;
                uint8_t *pc = *(uint8_t **)(conn + CONN_OWNINGACTOR);
                uint8_t *ch = find_actor_channel(conn, actor);
                if (!ch && startup && pc && *(uint8_t **)(pc + PC_PAWN)) {
                    if (!((LevelInitFn)VCALL(drv, DRV_VT_LEVELINIT))(drv, actor, conn)) continue;
                    ch = ((CreateChannelFn)AT(g_build->create_channel))(conn, CHTYPE_ACTOR, 1, -1);
                    if (!ch) continue;
                    ((SetChannelActorFn)AT(g_build->set_channel_actor))(ch, actor);
                    ((ReplicateActorFn)AT(g_build->replicate_actor))(ch);
                    g_destroy_startup++;
                }
                if (!ch || (*(uint32_t *)(ch + CH_FLAGS) & 2)) continue;
                ((ChanCloseFn)VCALL(ch, CH_VT_CLOSE))(ch);
                g_destroy_closed++;
            }
        }
    }
    o_notify_destroyed(drv, actor, seamless);
}

static void h_tick_flush(uint8_t *drv, float dt)
{
    if (cfg.replicate_actors) {
        LARGE_INTEGER t0, t1;
        QueryPerformanceCounter(&t0);
        replicate_actors(drv);
        QueryPerformanceCounter(&t1);
        g_pass_ticks += t1.QuadPart - t0.QuadPart;
    }
    o_tick_flush(drv, dt);
    /* Once per frame: only for the world's game driver, and only when hosting. */
    if (cfg.max_fps > 0 && !*(void **)(drv + DRV_SERVERCONN)) {
        uint8_t *world = *(uint8_t **)(drv + DRV_WORLD);
        if (world && *(uint8_t **)(world + UWORLD_NETDRIVER) == drv) cap_frame();
    }
}


/* ------------------------------------------------------------------------ */
/* Backend events (lobby lifecycle)                                          */
/* ------------------------------------------------------------------------ */

/* Fire-and-forget JSON POSTs to the revival backend, on a worker thread so the
   game thread never waits on the network. */
typedef struct BackendReq { struct BackendReq *next; wchar_t path[256]; char body[16384]; int retries; } BackendReq;
static BackendReq *g_req_head, *g_req_tail;
static CRITICAL_SECTION g_req_lock;
static HANDLE g_req_event;

static DWORD WINAPI backend_worker(LPVOID unused)
{
    (void)unused;
    for (;;) {
        WaitForSingleObject(g_req_event, INFINITE);
        for (;;) {
            EnterCriticalSection(&g_req_lock);
            BackendReq *r = g_req_head;
            if (r) { g_req_head = r->next; if (!g_req_head) g_req_tail = NULL; }
            LeaveCriticalSection(&g_req_lock);
            if (!r) break;
            static const DWORD backoff_ms[] = { 2000, 5000, 10000, 10000, 10000 };
            for (int attempt = 0; ; attempt++) {
            URL_COMPONENTS u;
            wchar_t hostname[128];
            memset(&u, 0, sizeof u);
            u.dwStructSize = sizeof u;
            u.lpszHostName = hostname; u.dwHostNameLength = 128;
            u.dwUrlPathLength = (DWORD)-1;
            DWORD status = 0;
            if (WinHttpCrackUrl(cfg.backend, 0, 0, &u)) {
                /* Keep the base URL's own path (e.g. /api), without a trailing '/'. */
                wchar_t full[512], headers[640];
                int base_len = u.lpszUrlPath ? (int)u.dwUrlPathLength : 0;
                while (base_len > 0 && u.lpszUrlPath[base_len - 1] == L'/') base_len--;
                if (base_len > 256) base_len = 256;
                _snwprintf(full, 511, L"%.*ls%ls", base_len, base_len ? u.lpszUrlPath : L"", r->path);
                full[511] = 0;
                if (cfg.token[0])
                    _snwprintf(headers, 639, L"Content-Type: application/json\r\nAuthorization: Token %ls\r\n", cfg.token);
                else
                    _snwprintf(headers, 639, L"Content-Type: application/json\r\n");
                headers[639] = 0;
                HINTERNET ses = WinHttpOpen(L"sos_host", WINHTTP_ACCESS_TYPE_NO_PROXY, NULL, NULL, 0);
                HINTERNET con = ses ? WinHttpConnect(ses, hostname, u.nPort, 0) : NULL;
                HINTERNET req = con ? WinHttpOpenRequest(con, L"POST", full, NULL, NULL, NULL,
                                                         u.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0) : NULL;
                if (req) {
                    WinHttpSetTimeouts(req, 5000, 5000, 5000, 5000);
                    DWORD len = (DWORD)strlen(r->body);
                    if (WinHttpSendRequest(req, headers, (DWORD)-1,
                                           r->body, len, len, 0) && WinHttpReceiveResponse(req, NULL)) {
                        DWORD sz = sizeof status;
                        WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                            NULL, &status, &sz, NULL);
                    }
                    WinHttpCloseHandle(req);
                }
                if (con) WinHttpCloseHandle(con);
                if (ses) WinHttpCloseHandle(ses);
            }
            hlog("Backend POST %.*ls%ls %s (token %s) -> %lu",
                 (int)(u.lpszUrlPath ? u.dwUrlPathLength : 0), u.lpszUrlPath ? u.lpszUrlPath : L"",
                 r->path, r->body, cfg.token[0] ? "sent" : "none", status);
            if ((status >= 200 && status < 300) || attempt >= r->retries || attempt >= 5) break;
            hlog("Backend POST retry %d in %lu ms", attempt + 1, backoff_ms[attempt]);
            Sleep(backoff_ms[attempt]);
            }
            free(r);
        }
    }
    return 0;
}

/* path relative to the backend root, e.g. L"/session/<id>/events". */
static void backend_post_retry(const wchar_t *path, const char *json, int retries)
{
    if (!cfg.backend[0]) return;
    static int started;
    if (!started) {
        started = 1;
        InitializeCriticalSection(&g_req_lock);
        g_req_event = CreateEventW(NULL, FALSE, FALSE, NULL);
        CloseHandle(CreateThread(NULL, 0, backend_worker, NULL, 0, NULL));
    }
    BackendReq *r = (BackendReq *)calloc(1, sizeof *r);
    if (!r) return;
    wcsncpy(r->path, path, 255);
    strncpy(r->body, json, sizeof r->body - 1);
    r->retries = retries;
    EnterCriticalSection(&g_req_lock);
    if (g_req_tail) g_req_tail->next = r; else g_req_head = r;
    g_req_tail = r;
    LeaveCriticalSection(&g_req_lock);
    SetEvent(g_req_event);
}


static void backend_session_event(const char *json)
{
    if (!cfg.session[0]) return;
    wchar_t path[256];
    _snwprintf(path, 255, L"/session/%ls/events", cfg.session);
    path[255] = 0;
    /* The match end is the backend's only source of match results: retry it. */
    backend_post_retry(path, json, strstr(json, "\"match-end\"") ? 3 : 0);
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
   acks the older one. The joiner is trusted with its position unless the host
   has it more than CorrectDistance away (FALL_DIST while falling), e.g. after
   a teleport; then it gets ClientAdjustPosition instead of the ack. */

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
#define COMP_ROTATION     0x110   /* ComponentToWorld rotation (FQuat x y z w) */
#define COMP_LOCATION     0x120   /* ComponentToWorld translation */
#define COMP_SCALE        0x130   /* ComponentToWorld scale */
#define ADJUST_INTERVAL   0.25f   /* s between corrections of one joiner */
#define FALL_DIST         1000.0f /* cm; while falling only a gap this big is corrected */
#define BASE_DIST         2000.0f /* cm; same while the joiner stands on a base */
#define LAG_FLOOR        15000.0f /* cm; a host pawn that lags behind its joiner (the host simulates the
                                     moves slower than the client) must not drag the joiner back: only a
                                     teleport-sized gap (match start, 100s of m) is corrected */
#define MOVE_FALLING      3

/* World position of a point given relative to a movement base component. */
static void base_to_world(const uint8_t *base, const float *rel, float *out)
{
    const float *q = (const float *)(base + COMP_ROTATION);
    const float *t = (const float *)(base + COMP_LOCATION);
    const float *s = (const float *)(base + COMP_SCALE);
    float v[3] = { rel[0] * s[0], rel[1] * s[1], rel[2] * s[2] };
    /* v' = v + 2w(q x v) + 2 q x (q x v) */
    float cx = q[1] * v[2] - q[2] * v[1], cy = q[2] * v[0] - q[0] * v[2], cz = q[0] * v[1] - q[1] * v[0];
    float c2x = q[1] * cz - q[2] * cy, c2y = q[2] * cx - q[0] * cz, c2z = q[0] * cy - q[1] * cx;
    out[0] = v[0] + 2 * (q[3] * cx + c2x) + t[0];
    out[1] = v[1] + 2 * (q[3] * cy + c2y) + t[1];
    out[2] = v[2] + 2 * (q[3] * cz + c2z) + t[2];
}

static float dist2(const float *a, const float *b)
{
    float dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz;
}

typedef void (*AdjustFn)(void *cmc, float ts, const float *loc, const float *vel, void *base,
                         uint64_t bone, uint8_t has_base, uint8_t relative, uint8_t mode);
static unsigned g_moves_adjusted;
static struct { void *cmc; float ts; } g_last_adjust[32];
static DWORD g_adjust_win[32];
static unsigned g_adjust_n[32];
#define ADJUST_WINDOW_MS  10000
#define MAX_ADJUST_BURST  6

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
/* A movement base whose rotation is a unit quaternion. Scale and location are
   not checked: terrain and static meshes legitimately have scale 100 or sit at
   the origin. */
static int base_sane(const uint8_t *base)
{
    const float *q = (const float *)(base + COMP_ROTATION);
    float n = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
    return n > 0.9f && n < 1.1f;
}

/* Name of a UObject (its FName) as ASCII, "?" if unreadable. */
static void uobj_name(const uint8_t *o, char *out, size_t cap)
{
    snprintf(out, cap, "?");
    if (!o || !g_build->fname_tostring) return;
    FString fs = { 0 };
    ((FNameToStringFn)AT(g_build->fname_tostring))((const FName *)(o + OBJ_NAME), &fs);
    if (!fs.data) return;
    size_t i = 0;
    for (; i + 1 < cap && fs.data[i]; i++) out[i] = fs.data[i] < 0x7f ? (char)fs.data[i] : '?';
    out[i] = 0;
    ((FreeFn)AT(g_build->mem_free))(fs.data);
}

/* Once per new movement base pointer (first 24): what it is, for the log. */
static void log_new_base(const uint8_t *base, const float *client_loc)
{
    static const uint8_t *seen[24];
    static int n;
    for (int i = 0; i < n; i++) if (seen[i] == base) return;
    if (n >= 24) return;
    seen[n++] = base;
    char nm[96] = "?", cn[96] = "?", on[96] = "?";
    uobj_name(base, nm, sizeof nm);
    uobj_name(*(uint8_t **)(base + OBJ_CLASS), cn, sizeof cn);
    uobj_name(*(uint8_t **)(base + OBJ_OUTER), on, sizeof on);
    const float *t = (const float *)(base + COMP_LOCATION), *sc = (const float *)(base + COMP_SCALE);
    hlog("Base %p: %s (%s) in %s, loc (%.0f %.0f %.0f) scale (%.2f %.2f %.2f); joiner reports (%.0f %.0f %.0f)",
         (const void *)base, nm, cn, on, t[0], t[1], t[2], sc[0], sc[1], sc[2], client_loc[0], client_loc[1], client_loc[2]);
}

static int client_mode_falling(int packed)
{
    if (packed < 0) return 0;
    if (packed >= (int)*(uint8_t *)AT(g_build->move_mode_custom)) return 0;   /* custom mode */
    return (packed & ((1 << *(uint8_t *)AT(g_build->move_mode_shift)) - 1)) == MOVE_FALLING;
}

static void answer_move(uint8_t *cmc, int ok, float ts, int have_loc, const float *client_loc, uint8_t *base, int client_mode)
{
    if (!cfg.ack_moves || !ok || !(ts > 0.0f)) return;
    if (((IsPendingKillFn)AT(g_build->is_pending_kill))(cmc)) return;
    uint8_t *comp = *(uint8_t **)(cmc + CMC_UPDATEDCOMP);
    if (cfg.correct_moves && have_loc && comp && g_build->adjust_position) {
        const float *loc = (const float *)(comp + COMP_LOCATION);
        /* On a movable base the joiner sends its location relative to the base;
           on a static one it sends world. Take whichever is nearer. */
        float d2 = dist2(loc, client_loc), world[3];
        int base_ok = 0;
        if (base && !((IsPendingKillFn)AT(g_build->is_pending_kill))(base)) {
            if (base_sane(base)) {
                base_ok = 1;
                base_to_world(base, client_loc, world);
                float d2b = dist2(loc, world);
                if (d2b < d2) d2 = d2b;
            }
        }
        int falling = cmc[CMC_MOVEMODE] == MOVE_FALLING || client_mode_falling(client_mode);
        if (base) log_new_base(base, client_loc);
        {   /* every 10 s: how far apart the joiner and its host pawn are, and how fast each moves */
            static struct { void *cmc; DWORD tick; float cl[3], hl[3]; } samp[8];
            int si = (int)(((uintptr_t)cmc >> 4) & 7);
            DWORD tk = GetTickCount();
            if (samp[si].cmc != cmc) { samp[si].cmc = cmc; samp[si].tick = tk; memcpy(samp[si].cl, client_loc, 12); memcpy(samp[si].hl, loc, 12); }
            else if (tk - samp[si].tick >= 10000) {
                float secs = (tk - samp[si].tick) / 1000.0f;
                hlog("MoveDiag: joiner (%.0f %.0f %.0f)%s host (%.0f %.0f %.0f) gap %.0f cm; client moved %.0f cm/s, host pawn %.0f cm/s, host mode %u",
                     client_loc[0], client_loc[1], client_loc[2], base ? " rel" : "", loc[0], loc[1], loc[2], sqrtf(d2),
                     sqrtf(dist2(client_loc, samp[si].cl)) / secs, sqrtf(dist2(loc, samp[si].hl)) / secs, cmc[CMC_MOVEMODE]);
                samp[si].tick = tk; memcpy(samp[si].cl, client_loc, 12); memcpy(samp[si].hl, loc, 12);
            }
        }
        /* While falling the host's simulation runs ahead of the joiner's, and a
           correction (sent with zero velocity) costs the joiner its momentum. */
        float lim = falling ? FALL_DIST : (float)cfg.correct_dist;
        /* On a base (the drop vehicle, the pregame line-up) the base itself is
           often somewhere else on the host than on the joiner, since the intro
           sequence moves it client-side. Only a teleport-sized gap is corrected. */
        if (base && lim < BASE_DIST) lim = BASE_DIST;
        if (lim < LAG_FLOOR && !falling) lim = LAG_FLOOR;
        /* Falling or dropping from a vehicle while the client still reports a base:
           the base (a helicopter, the drop ship) moves client-side, so the host's
           base transform is unreliable and relative coordinates can't be compared
           with the host's world position. Let the landing reconcile. A base whose
           transform fails the sanity check is never trusted either. */
        int skip = (base && (!base_ok || falling));
        if (falling && !base) lim = FALL_DIST * 10.0f;       /* 100 m: only a real teleport */
        if (skip && d2 > lim * lim) {
            static DWORD last_skip;
            DWORD tk = GetTickCount();
            if (tk - last_skip >= 5000) {
                last_skip = tk;
                hlog("AdjustPosition skipped: joiner at (%.0f %.0f %.0f) on a base%s, host has (%.0f %.0f %.0f) mode %u",
                     client_loc[0], client_loc[1], client_loc[2], base_ok ? "" : " (bad transform)",
                     loc[0], loc[1], loc[2], cmc[CMC_MOVEMODE]);
            }
        } else if (d2 > lim * lim) {
            int slot = -1, free_slot = -1;
            for (int i = 0; i < 32; i++) {
                if (g_last_adjust[i].cmc == cmc) slot = i;
                else if (!g_last_adjust[i].cmc && free_slot < 0) free_slot = i;
            }
            if (slot < 0) slot = free_slot >= 0 ? free_slot : (int)(((uintptr_t)cmc >> 4) & 31);
            if (g_last_adjust[slot].cmc == cmc && ts > g_last_adjust[slot].ts
                && ts - g_last_adjust[slot].ts < ADJUST_INTERVAL)
                return;                     /* a correction is on its way */
            /* At most MAX_ADJUST_BURST corrections per ADJUST_WINDOW_MS for one joiner. */
            DWORD nowt = GetTickCount();
            if (nowt - g_adjust_win[slot] > ADJUST_WINDOW_MS || g_last_adjust[slot].cmc != cmc) {
                g_adjust_win[slot] = nowt; g_adjust_n[slot] = 0;
            }
            if (g_adjust_n[slot] >= MAX_ADJUST_BURST) goto ack;
            g_adjust_n[slot]++;
            g_last_adjust[slot].cmc = cmc;
            g_last_adjust[slot].ts = ts;
            static const float zero[3] = { 0, 0, 0 };
            ((AdjustFn)AT(g_build->adjust_position))(cmc, ts, loc, zero, NULL, 0, 0, 0, packed_move_mode(cmc));
            g_moves_adjusted++;
            hlog("AdjustPosition: joiner at (%.0f %.0f %.0f)%s, host has (%.0f %.0f %.0f) mode %u; corrected (%u so far)",
                 client_loc[0], client_loc[1], client_loc[2], base ? " on a base" : "",
                 loc[0], loc[1], loc[2], cmc[CMC_MOVEMODE], g_moves_adjusted);
            return;
        }
    }
ack:
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
    uint8_t *base = NULL;
    if (!peek_param(stack, 7, &base, sizeof base)) base = NULL;   /* ClientMovementBase */
    uint8_t cm = 0;
    int have_cm = peek_param(stack, 9, &cm, 1);           /* ClientMovementMode */
    o_exec_move(cmc, stack, result);
    answer_move(cmc, ok, ts, have_loc, loc, base, have_cm ? cm : -1);
}

static void h_exec_dual(void *cmc, uint8_t *stack, void *result)
{
    float ts = 0, loc[3];
    int ok = peek_param(stack, 5, &ts, sizeof ts);
    int have_loc = peek_param(stack, 7, loc, sizeof loc);
    uint8_t *base = NULL;
    if (!peek_param(stack, 11, &base, sizeof base)) base = NULL;  /* ClientMovementBase */
    uint8_t cm = 0;
    int have_cm = peek_param(stack, 13, &cm, 1);          /* ClientMovementMode */
    o_exec_dual(cmc, stack, result);
    answer_move(cmc, ok, ts, have_loc, loc, base, have_cm ? cm : -1);
}

static void h_exec_hybrid(void *cmc, uint8_t *stack, void *result)
{
    float ts = 0, loc[3];
    int ok = peek_param(stack, 5, &ts, sizeof ts);
    int have_loc = peek_param(stack, 7, loc, sizeof loc);
    uint8_t *base = NULL;
    if (!peek_param(stack, 11, &base, sizeof base)) base = NULL;  /* ClientMovementBase */
    uint8_t cm = 0;
    int have_cm = peek_param(stack, 13, &cm, 1);          /* ClientMovementMode */
    o_exec_hybrid(cmc, stack, result);
    answer_move(cmc, ok, ts, have_loc, loc, base, have_cm ? cm : -1);
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
        if ((cfg.replicate_actors || cfg.max_fps > 0) && g_build->tick_flush) {
            static const uint8_t p_flush[15] = { 0x48, 0x8B, 0xC4, 0x48, 0x89, 0x58, 0x10, 0x48,
                                                 0x89, 0x70, 0x18, 0x48, 0x89, 0x78, 0x20 };
            o_tick_flush = (TickFlushFn)hook_entry(&cursor, g_build->tick_flush, p_flush, 15,
                                                   (void *)h_tick_flush, "UNetDriver::TickFlush");
        }
        if (o_tick_flush && cfg.replicate_actors && g_build->notify_destroyed) {
            static const uint8_t p_destroyed[9] = { 0x40, 0x53, 0x48, 0x83, 0xEC, 0x40, 0x48, 0x8B, 0xD9 };
            o_notify_destroyed = (NotifyDestroyedFn)hook_entry(&cursor, g_build->notify_destroyed, p_destroyed, 9,
                                                               (void *)h_notify_destroyed, "UNetDriver::NotifyActorDestroyed");
        }
        if (o_tick_flush && cfg.replicate_actors && g_build->gm_killed) {
            /* mov [rsp+8],rbx; mov [rsp+10h],rbp */
            static const uint8_t p_killed[10] = { 0x48, 0x89, 0x5C, 0x24, 0x08, 0x48, 0x89, 0x6C, 0x24, 0x10 };
            o_killed = (KilledFn)hook_entry(&cursor, g_build->gm_killed, p_killed, 10,
                                            (void *)h_killed, "GameMode::Killed");
        }
        if (o_tick_flush && cfg.replicate_actors && g_build->escaped_call) {
            /* Redirect the thunk's call to LogPlayerEscaped (E8 rel32) through a stub. */
            uint8_t *call = g_base + g_build->escaped_call;
            if (call[0] == 0xE8 && cursor) {
                int32_t rel; memcpy(&rel, call + 1, 4);
                o_escaped = (EscapedFn)(call + 5 + rel);
                uint8_t *stub = cursor;
                uint64_t to = (uint64_t)(uintptr_t)h_escaped;
                stub[0] = 0x48; stub[1] = 0xB8; memcpy(stub + 2, &to, 8); stub[10] = 0xFF; stub[11] = 0xE0;
                FlushInstructionCache(GetCurrentProcess(), stub, 16);
                cursor += 16;
                int64_t nrel = (int64_t)(stub - (call + 5));
                int32_t nrel32 = (int32_t)nrel;
                uint8_t patch[5] = { 0xE8 };
                memcpy(patch + 1, &nrel32, 4);
                if (nrel == nrel32 && write_code(call, patch, 5)) hlog("LogPlayerEscaped call redirected at +%07x", g_build->escaped_call);
                else { o_escaped = NULL; hlog("LogPlayerEscaped: patch failed"); }
            } else hlog("LogPlayerEscaped: no call at +%07x; not hooked", g_build->escaped_call);
        }
        hlog("ReplicateActors=%d ReplicateStartupActors=%d TickCharacterRadius=%d MaxFPS=%d",
             cfg.replicate_actors && o_tick_flush, cfg.replicate_startup, cfg.tick_char_radius,
             o_tick_flush ? cfg.max_fps : 0);
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
