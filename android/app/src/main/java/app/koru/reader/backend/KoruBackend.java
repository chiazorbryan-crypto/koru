package app.koru.reader.backend;

import android.content.Context;
import android.net.Uri;
import android.webkit.WebResourceResponse;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Koru's background side on Android: answers the page's /k/... requests like electron/backend.js, sync.js and
 * updater.js do on Windows (same routes, JSON shapes, status codes and messages).
 *
 * Routes (all under /k/):
 *   GET  /k/info                    app version, platform ("android"), downloads folder
 *   GET  /k/fetch?u=&lt;url&gt;&amp;accept=  a site request (only the allowed sites), returned as-is
 *   GET  /k/store/&lt;key&gt;, PUT        saved JSON (library, history, settings)
 *   POST /k/dl/start|cancel|delete, GET /k/dl/queue|list, GET /k/dl/file/&lt;series&gt;/&lt;chapter&gt;/&lt;file&gt;, GET /k/dl/cbz?...
 *   POST /k/dl/share?(same as cbz)  Android only: writes the .cbz to the external cache and opens the share sheet
 *   GET  /k/gpu, PUT /k/gpu         fixed answer (the WebView always draws with the GPU)
 *   POST /k/open-external {url}, /k/open-downloads, /k/window-icon, /k/fullscreen, /k/relaunch
 *   /k/sync/*                       GitHub sync (no folder mode on Android)
 *   /k/app-update/*                 updates from the GitHub releases' .apk
 *
 * handle() is safe to call from several WebView threads at once and never returns null.
 */
public final class KoruBackend {
  /** GitHub API base for sync and updates; point it at a stand-in server for tests. */
  public static String GH_API = "https://api.github.com";

  public interface Opener {
    void openExternal(String url);
    void installApk(File apk);
    void share(File file, String mime);
  }

  private static final Pattern STORE = Pattern.compile("^/k/store/([a-z0-9-]{1,40})$");
  private static final Pattern DL_FILE = Pattern.compile("^/k/dl/file/([^/]+)/([^/]+)(?:/([^/]+))?$");
  private static final String CBZ_MIME = "application/vnd.comicbook+zip";

  private final Context ctx;
  private final String version;
  private final File dataDir;
  private final Downloads downloads;
  private final Sync sync;
  private final Updater updater;
  private volatile Opener opener;

  public KoruBackend(Context ctx, String versionName) {
    this.ctx = ctx.getApplicationContext() != null ? ctx.getApplicationContext() : ctx;
    this.version = versionName == null || versionName.isEmpty() ? "0.0.0" : versionName;
    File files = this.ctx.getFilesDir();
    this.dataDir = new File(files, "data");
    //noinspection ResultOfMethodCallIgnored
    dataDir.mkdirs();
    File dl = null;
    try { dl = this.ctx.getExternalFilesDir("downloads"); } catch (Exception ignored) {}
    if (dl == null) dl = new File(files, "downloads");
    this.downloads = new Downloads(dl);
    SecretStore secrets = new SecretStore(this.ctx);
    this.sync = new Sync(new File(files, "sync.json"), secrets);
    this.updater = new Updater(this, this.version, cacheDir(), secrets);
  }

  public void setOpener(Opener o) { this.opener = o; }

  Opener opener() { return opener; }

  private File cacheDir() {
    File c = null;
    try { c = ctx.getExternalCacheDir(); } catch (Exception ignored) {}
    return c != null ? c : ctx.getCacheDir();
  }

  public WebResourceResponse handle(String method, Uri url, Map<String, String> headers, byte[] body) {
    Res r;
    try {
      r = route(method == null ? "GET" : method.toUpperCase(Locale.ROOT), url, body);
      if (r == null) r = Res.error(404, "Not found");
    } catch (KError e) {
      r = Res.error(e.status, Js.message(e, "Something went wrong."));
    } catch (Throwable t) {
      r = Res.error(500, Js.message(t, "Something went wrong."));
    }
    try {
      return r.toWeb();
    } catch (Throwable t) {
      Res.closeQuietly(r.stream);
      byte[] b = "{\"error\":\"Something went wrong.\"}".getBytes(StandardCharsets.UTF_8);
      Map<String, String> h = new java.util.HashMap<>();
      h.put("Cache-Control", "no-store");
      h.put("Access-Control-Allow-Origin", "*");
      return new WebResourceResponse("application/json", "utf-8", 500, "Internal Server Error", h, new ByteArrayInputStream(b));
    }
  }

  /**
   * The .cbz for a /k/dl/cbz (or /k/dl/share) URL written to the external cache (exports/), for a DownloadListener
   * or a share sheet. Blocks while it writes; call it off the main thread.
   */
  public File exportCbz(Uri url) throws Exception {
    try {
      return downloads.exportCbz(Js.query(url.getEncodedQuery()), new File(cacheDir(), "exports"));
    } catch (KError e) {
      throw new Exception(e.getMessage());
    }
  }

  private Res route(String method, Uri url, byte[] bodyBytes) throws Exception {
    String p = url == null ? null : url.getEncodedPath();
    if (p == null || p.isEmpty()) p = "/";
    Map<String, String> q = url == null ? Collections.<String, String>emptyMap() : Js.query(url.getEncodedQuery());
    String body = bodyBytes == null ? "" : new String(bodyBytes, StandardCharsets.UTF_8);

    if (method.equals("OPTIONS")) {
      Res r = new Res(204, "text/plain", new byte[0]);
      r.headers.put("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      r.headers.put("Access-Control-Allow-Headers", "Content-Type");
      return r;
    }
    if (p.startsWith("/k/app-update/")) return updater.route(p.substring("/k/app-update".length()), method, q, body);
    if (p.startsWith("/k/sync/")) return sync.route(p.substring("/k/sync".length()), method, q, body);

    if (p.equals("/k/info") && method.equals("GET"))
      return Res.json(200, Js.obj("version", version, "platform", "android", "downloadsDir", downloads.root.getAbsolutePath()));

    if (p.equals("/k/fetch") && method.equals("GET")) return siteFetch(q);

    Matcher store = STORE.matcher(p);
    if (store.matches()) {
      File file = new File(dataDir, store.group(1) + ".json");
      if (method.equals("GET")) {
        try {
          if (file.isFile()) return new Res(200, "application/json", Js.readFile(file, 256L << 20));
        } catch (IOException ignored) {}
        return new Res(200, "application/json", "null".getBytes(StandardCharsets.UTF_8));
      }
      if (method.equals("PUT")) {
        Js.parseJson(body);   // only valid JSON is saved
        synchronized (this) { Js.writeAtomic(file, body.getBytes(StandardCharsets.UTF_8)); }
        return Res.ok();
      }
    }

    if (p.equals("/k/dl/start") && method.equals("POST")) return downloads.start(Js.parseBody(body));
    if (p.equals("/k/dl/cancel") && method.equals("POST")) return downloads.cancel(Js.parseBody(body));
    if (p.equals("/k/dl/queue") && method.equals("GET")) return downloads.queueView();
    if (p.equals("/k/dl/list") && method.equals("GET")) return downloads.list();
    if (p.equals("/k/dl/delete") && method.equals("POST")) return downloads.delete(Js.parseBody(body));
    if (p.equals("/k/dl/cbz") && method.equals("GET")) return downloads.cbz(q);
    if (p.equals("/k/dl/share") && method.equals("POST")) {
      Opener o = opener;
      if (o == null) return Res.error(503, "Sharing isn't available right now.");
      File f = downloads.exportCbz(q, new File(cacheDir(), "exports"));
      o.share(f, CBZ_MIME);
      return Res.json(200, Js.obj("ok", true, "name", f.getName()));
    }
    Matcher file = DL_FILE.matcher(p);
    if (file.matches() && method.equals("GET")) {
      List<String> parts = new ArrayList<>();
      for (int i = 1; i <= 3; i++) if (file.group(i) != null && !file.group(i).isEmpty()) parts.add(file.group(i));
      return downloads.file(parts);
    }

    if (p.equals("/k/gpu")) {
      JSONObject now = Js.obj("accel", true);
      if (method.equals("GET"))
        return Res.json(200, Js.obj("now", now, "saved", Js.obj("accel", true),
          "status", Js.obj("gpu_compositing", "enabled", "rasterization", "enabled"), "devices", new org.json.JSONArray()));
      if (method.equals("PUT")) return Res.json(200, Js.obj("saved", now));   // nothing to change on Android
    }
    if (p.equals("/k/window-icon") && method.equals("POST")) return Res.ok();
    if (p.equals("/k/open-downloads") && method.equals("POST")) return Res.ok();
    if (p.equals("/k/fullscreen") && method.equals("POST")) return Res.ok();
    if (p.equals("/k/relaunch") && method.equals("POST")) return Res.ok();
    if (p.equals("/k/open-external") && method.equals("POST")) {
      Object u = Js.parseBody(body).opt("url");
      String s = u instanceof String ? (String) u : "";
      if (!SiteFetch.allowedUrl(s) && !(s.startsWith("https://github.com/") && SiteFetch.httpsHost(s) != null)) return Res.error(400, "Not allowed");
      Opener o = opener;
      if (o != null) o.openExternal(s);
      return Res.ok();
    }
    return Res.error(404, "Not found");
  }

  private Res siteFetch(Map<String, String> q) throws KError {
    String u = q.get("u");
    String accept = q.get("accept");
    if (u == null) u = "";
    if (accept == null || accept.isEmpty()) accept = "application/json";
    try (SiteFetch.Resp r = SiteFetch.fetch(u, accept)) {
      String type = r.type == null || r.type.isEmpty() ? "application/octet-stream" : r.type;
      byte[] data = r.readAll(100L << 20);
      Res res = new Res(r.status, type, data);
      if (r.ok() && Js.lower(type).startsWith("image/")) res.cache = Res.FILE_CACHE;
      return res;
    } catch (IOException e) {
      throw SiteFetch.unreachable(u);
    }
  }
}
