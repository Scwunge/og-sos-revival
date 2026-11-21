/* Core-side self-update (included into sos_client.c in the SOS_CORE build only).
 *
 * Once per game start, 15 s after launch: GET /mod/manifest.json and /mod/manifest.sig from the backend, check the
 * signature and that the version is higher than the installed core's, download /mod/<file>, check size and SHA-256,
 * then stage it next to the core as sos_client_core.new (+ .new.manifest, .new.sig). The loader (xinput1_3.dll)
 * re-verifies everything and swaps the files at the next launch; the running core is never touched.
 * Needs a signed manifest for the installed core (sos_client_core.manifest/.sig): a development build has none and
 * never updates. 60 s after launch this thread also removes sos_client_core.trial, which tells the loader the core
 * is stable (see loader.c).
 */
#include "update_common.h"


static int upd_get(const char *path_a, char **resp, size_t *len)
{
    wchar_t pw[160];
    MultiByteToWideChar(CP_UTF8, 0, path_a, -1, pw, 160);
    int st = http_do(L"GET", pw, NULL, NULL, resp, len);
    if (st != 200) { free(*resp); *resp = NULL; }
    return st;
}

static void upd_path(wchar_t *out, const wchar_t *name)
{
    _snwprintf(out, MAX_PATH - 1, L"%ls%ls", g_dir, name);
    out[MAX_PATH - 1] = 0;
}

static void upd_check(void)
{
    wchar_t pm[MAX_PATH], ps[MAX_PATH], pnew[MAX_PATH], pnm[MAX_PATH], pns[MAX_PATH], ptmp[MAX_PATH];
    upd_path(pm, L"sos_client_core.manifest");
    upd_path(ps, L"sos_client_core.sig");
    upd_path(pnew, L"sos_client_core.new");
    upd_path(pnm, L"sos_client_core.new.manifest");
    upd_path(pns, L"sos_client_core.new.sig");
    upd_path(ptmp, L"sos_client_core.new.tmp");
    UpdManifest cur;
    if (!upd_load_manifest(pm, ps, &cur)) { slog("update: no signed manifest for the installed core (development build); skipping"); return; }

    char *mb = NULL, *sb = NULL, *bin = NULL;
    size_t ml = 0, sl = 0, bl = 0;
    int st = upd_get("/mod/manifest.json", &mb, &ml);
    if (st != 200) { slog("update: no manifest (HTTP %d)", st); goto out; }
    st = upd_get("/mod/manifest.sig", &sb, &sl);
    if (st != 200) { slog("update: no signature (HTTP %d)", st); goto out; }
    UpdManifest nw;
    if (ml > 4096 || sl > 512 || !upd_verify((const uint8_t *)mb, ml, sb) || !upd_parse(mb, &nw)) {
        slog("update: manifest signature invalid; ignoring");
        goto out;
    }
    if (nw.version <= cur.version) { slog("update: up to date (v%lu)", cur.version); goto out; }
    if (nw.size > 1900u * 1024) { slog("update: core too large for this updater"); goto out; }
    char path[96];
    snprintf(path, sizeof path, "/mod/%s", nw.file);
    st = upd_get(path, &bin, &bl);
    if (st != 200) { slog("update: download failed (HTTP %d)", st); goto out; }
    uint8_t h[32];
    sha256((const uint8_t *)bin, bl, h);
    if (bl != nw.size || memcmp(h, nw.sha, 32) != 0) { slog("update: download does not match the manifest; discarded"); goto out; }
    if (!upd_write_file(pnm, mb, ml) || !upd_write_file(pns, sb, sl) || !upd_write_file(ptmp, bin, bl)
        || !MoveFileExW(ptmp, pnew, MOVEFILE_REPLACE_EXISTING)) {
        slog("update: could not stage v%lu (%lu)", nw.version, GetLastError());
        DeleteFileW(ptmp);
        goto out;
    }
    slog("update: v%lu staged (%lu bytes); it takes effect the next time the game starts", nw.version, (unsigned long)bl);
out:
    free(mb);
    free(sb);
    free(bin);
}

static DWORD WINAPI upd_thread(LPVOID unused)
{
    (void)unused;
    Sleep(15000);
    if (g_auto_update) {
        for (int i = 0; i < 20 && !g_wh_session; i++) Sleep(500);
        if (g_wh_session) upd_check();
        else slog("update: no HTTP session");
    }
    Sleep(45000);
    wchar_t p[MAX_PATH];
    upd_path(p, L"sos_client_core.trial");
    DeleteFileW(p);   /* the core stayed up for a minute: the loader may keep it */
    return 0;
}

static void upd_start(void)
{
    if (g_auto_update) ensure_worker();   /* creates the WinHTTP session the check uses */
    HANDLE t = CreateThread(NULL, 0, upd_thread, NULL, 0, NULL);
    if (t) CloseHandle(t);
}
