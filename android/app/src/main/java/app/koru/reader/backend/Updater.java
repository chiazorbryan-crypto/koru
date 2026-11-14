package app.koru.reader.backend;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * App updates (a port of electron/updater.js): Koru looks at its GitHub releases, and "Update now" downloads the
 * release's .apk and hands it to Android's installer. Only .apk files attached to this repo's releases are used.
 */
final class Updater {
  static final String REPO = "chiazorbryan-crypto/koru";
  private static final String KEY_NAME = "update-key";
  private static final Pattern KEY_RE = Pattern.compile("^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$");

  private final String current;
  private final File cacheDir;
  private final SecretStore secrets;
  private final KoruBackend backend;

  private Info latest;
  private long checkedAt;
  private Job job;            // guarded by this
  private File installFile;   // the downloaded .apk once it's complete

  Updater(KoruBackend backend, String current, File cacheDir, SecretStore secrets) {
    this.backend = backend;
    this.current = current;
    this.cacheDir = cacheDir;
    this.secrets = secrets;
  }

  static String api() { return KoruBackend.GH_API + "/repos/" + REPO; }

  private static final class Info {
    String version, name, notes, url, assetName, assetApi;
    long assetSize;
    boolean hasAsset;
  }

  private static final class Job {
    volatile String state;
    volatile long done, total;
    volatile String error;
    Job(String state, long total) { this.state = state; this.total = total; }
    JSONObject view() {
      JSONObject o = Js.obj("state", state, "done", done, "total", total);
      if (error != null) Js.put(o, "error", error);
      return o;
    }
  }

  private static final class KeyError extends Exception { private static final long serialVersionUID = 1L; KeyError(String m) { super(m); } }

  private static int[] parse(String v) {
    String[] p = String.valueOf(v == null ? "" : v).replaceFirst("^v", "").split("\\.", -1);
    int[] out = new int[3];
    for (int i = 0; i < 3 && i < p.length; i++) {
      String s = p[i].trim();
      int j = 0;
      if (j < s.length() && (s.charAt(j) == '+' || s.charAt(j) == '-')) j++;
      while (j < s.length() && Character.isDigit(s.charAt(j))) j++;
      try { out[i] = Integer.parseInt(s.substring(0, j)); } catch (Exception e) { out[i] = 0; }
    }
    return out;
  }

  static boolean newer(String a, String b) {
    int[] x = parse(a), y = parse(b);
    for (int i = 0; i < 3; i++) if (x[i] != y[i]) return x[i] > y[i];
    return false;
  }

  private String key() { return secrets.get(KEY_NAME); }

  private Info check(boolean force) throws Exception {
    synchronized (this) {
      if (latest != null && !force && System.currentTimeMillis() - checkedAt < 30 * 60_000L) return latest;
    }
    String k = key();
    GitHub.Answer r;
    try { r = GitHub.call(api() + "/releases/latest", "GET", null, k, "application/vnd.github+json", 30000); }
    catch (IOException e) { throw new Exception("Couldn't reach GitHub. Check your connection and try again."); }
    if (r.status == 404 || r.status == 401) throw new KeyError(k != null ? "That GitHub key can't read the Koru repo. Check its access, or make a new one." : "Your Koru repo is private, so Koru needs a read-only GitHub key to see new versions.");
    if (!r.ok()) throw new Exception(r.status == 403 ? "GitHub is busy, try again in a bit." : "Couldn't reach GitHub (" + r.status + ").");
    Object parsed = Js.parseJson(r.text);
    JSONObject rel = parsed instanceof JSONObject ? (JSONObject) parsed : new JSONObject();
    Info info = new Info();
    JSONArray assets = rel.optJSONArray("assets");
    if (assets != null) for (int i = 0; i < assets.length(); i++) {
      JSONObject a = assets.optJSONObject(i);
      if (a == null) continue;
      String n = a.optString("name", "");
      if (n.toLowerCase(java.util.Locale.ROOT).endsWith(".apk")) {
        info.hasAsset = true; info.assetName = n; info.assetSize = a.optLong("size", 0); info.assetApi = a.optString("url", "");
        break;
      }
    }
    info.version = rel.optString("tag_name", "").replaceFirst("^v", "");
    info.name = Js.truthy(rel.opt("name")) ? Js.str(rel.opt("name")) : "Koru " + info.version;
    String notes = Js.truthy(rel.opt("body")) ? Js.str(rel.opt("body")) : "";
    info.notes = notes.length() > 4000 ? notes.substring(0, 4000) : notes;
    info.url = Js.truthy(rel.opt("html_url")) ? Js.str(rel.opt("html_url")) : null;
    synchronized (this) { latest = info; checkedAt = System.currentTimeMillis(); }
    return info;
  }

  /** GitHub answers the asset request with a redirect to its file storage. The key goes to GitHub only. */
  private HttpURLConnection openAsset(String apiUrl, String k) throws Exception {
    HttpURLConnection c = (HttpURLConnection) new URL(apiUrl).openConnection();
    c.setInstanceFollowRedirects(false);
    c.setConnectTimeout(30000);
    c.setReadTimeout(30000);
    c.setRequestProperty("User-Agent", GitHub.UA);
    c.setRequestProperty("X-GitHub-Api-Version", GitHub.API_VERSION);
    c.setRequestProperty("Accept", "application/octet-stream");
    if (k != null) c.setRequestProperty("Authorization", "Bearer " + k);
    int code;
    try { code = c.getResponseCode(); } catch (IOException e) { c.disconnect(); throw new Exception("GitHub took too long to answer."); }
    if (code >= 300 && code < 400) {
      String loc = c.getHeaderField("Location");
      c.disconnect();
      if (loc == null || !loc.startsWith("https://")) throw new Exception("Unexpected download address.");
      HttpURLConnection d = (HttpURLConnection) new URL(loc).openConnection();
      d.setInstanceFollowRedirects(true);
      d.setConnectTimeout(30000);
      d.setReadTimeout(60000);
      d.setRequestProperty("User-Agent", GitHub.UA);
      int dc;
      try { dc = d.getResponseCode(); } catch (IOException e) { d.disconnect(); throw new Exception("Download failed. Check your connection and try again."); }
      if (dc != 200) { d.disconnect(); throw new Exception("Download failed (" + dc + ")."); }
      return d;
    }
    if (code == 200) return c;   // served straight from GitHub
    c.disconnect();
    throw new Exception("Download failed (" + code + ").");
  }

  private File download(Info info, Job j) throws Exception {
    if (!info.hasAsset || info.assetApi == null || !info.assetApi.startsWith(api() + "/releases/assets/")) throw new Exception("No installer found in that release.");
    if (!cacheDir.isDirectory() && !cacheDir.mkdirs() && !cacheDir.isDirectory()) throw new Exception("Couldn't save the update.");
    File file = new File(cacheDir, "Koru-update.apk");
    File part = new File(cacheDir, "Koru-update.apk.part");
    HttpURLConnection c = openAsset(info.assetApi, key());
    try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(part)) {
      byte[] buf = new byte[64 * 1024];
      int n;
      while ((n = in.read(buf)) != -1) {
        out.write(buf, 0, n);
        j.done += n;
        if (j.done > info.assetSize) break;
      }
    } catch (IOException e) {
      //noinspection ResultOfMethodCallIgnored
      part.delete();
      throw new Exception("The download was incomplete. Try again.");
    } finally {
      c.disconnect();
    }
    if (j.done != info.assetSize) {
      //noinspection ResultOfMethodCallIgnored
      part.delete();
      throw new Exception("The download was incomplete. Try again.");
    }
    //noinspection ResultOfMethodCallIgnored
    file.delete();
    if (!part.renameTo(file)) throw new Exception("Couldn't save the update.");
    return file;
  }

  Res route(String sub, String method, Map<String, String> q, String body) {
    try {
      if (sub.equals("/check")) {
        Info info;
        try { info = check("1".equals(q.get("force"))); }
        catch (KeyError e) { return Res.json(200, Js.obj("current", current, "needKey", true, "hasKey", key() != null, "error", e.getMessage())); }
        catch (Exception e) { return Res.json(502, Js.obj("current", current, "needKey", false, "hasKey", key() != null, "error", Js.message(e, "Update error"))); }
        return Res.json(200, Js.obj("current", current, "latest", info.version, "newer", newer(info.version, current) && info.hasAsset, "name", info.name,
          "notes", info.notes, "page", info.url, "size", info.hasAsset ? info.assetSize : 0, "hasKey", key() != null, "canInstall", true));
      }
      if (sub.equals("/key") && method.equals("POST")) {
        String k = "";
        try { JSONObject b = Js.parseBody(body); k = (Js.truthy(b.opt("key")) ? Js.str(b.opt("key")) : "").trim(); } catch (Exception ignored) {}
        if (!k.isEmpty() && !KEY_RE.matcher(k).matches()) return Res.error(400, "That doesn't look like a GitHub key. It starts with github_pat_.");
        secrets.set(KEY_NAME, k.isEmpty() ? null : k);
        synchronized (this) { latest = null; }
        return Res.json(200, Js.obj("ok", true, "hasKey", !k.isEmpty()));
      }
      if (sub.equals("/status")) {
        synchronized (this) { return Res.json(200, job != null ? job.view() : Js.obj("state", "idle")); }
      }
      if (sub.equals("/install") && method.equals("POST")) {
        synchronized (this) {
          if (job != null && "downloading".equals(job.state)) return Res.ok();
          if (job != null && "installing".equals(job.state) && installFile != null && installFile.isFile()) {
            // the installer was closed without installing: open it again
            KoruBackend.Opener o = backend.opener();
            if (o != null) o.installApk(installFile);
            return Res.ok();
          }
        }
        final Info info = check(true);
        if (!newer(info.version, current)) return Res.error(400, "You already have the newest Koru.");
        final Job j = new Job("downloading", info.assetSize);
        synchronized (this) {
          if (job != null && "downloading".equals(job.state)) return Res.ok();
          job = j;
          installFile = null;
        }
        Thread t = new Thread(() -> {
          try {
            File file = download(info, j);
            KoruBackend.Opener o = backend.opener();
            if (o == null) throw new Exception("Koru can't open Android's installer right now. Try again.");
            synchronized (Updater.this) { installFile = file; }
            j.state = "installing";
            o.installApk(file);
          } catch (Throwable e) {
            Job failed = new Job("failed", 0);
            failed.error = Js.message(e, "Update failed");
            synchronized (Updater.this) { if (job == j) job = failed; }
          }
        }, "koru-update");
        t.setDaemon(true);
        t.start();
        return Res.ok();
      }
      return Res.error(404, "Not found");
    } catch (Throwable e) {
      return Res.error(502, Js.message(e, "Update error"));
    }
  }
}
