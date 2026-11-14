package app.koru.reader.backend;

import android.os.Build;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * Library sync through a private GitHub repo of your own (a port of the GitHub half of electron/sync.js; the folder
 * mode doesn't exist on Android). Each device writes only its own file (koru-sync/<device>-<id>.json) and reads the
 * others; the merging itself happens in the page (web/js/sync.js). The key is kept encrypted (SecretStore) and is
 * only ever sent to GitHub.
 */
final class Sync {
  private static final String KEY_NAME = "sync-gh-key";
  private static final Pattern KEY_RE = Pattern.compile("^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$");
  private static final Pattern REPO_RE = Pattern.compile("^[\\w.-]+/[\\w.-]+$");

  private final File confFile;
  private final SecretStore secrets;
  private final Object confLock = new Object();
  private final Map<String, String> shas = new ConcurrentHashMap<>();       // file -> sha GitHub gave us last time
  private final Map<String, Object[]> cache = new ConcurrentHashMap<>();    // file -> { sha, data }

  Sync(File confFile, SecretStore secrets) {
    this.confFile = confFile;
    this.secrets = secrets;
  }

  private JSONObject conf() {
    synchronized (confLock) {
      JSONObject c = Js.readJsonObject(confFile);
      if (c == null) c = new JSONObject();
      if (!Js.truthy(c.opt("device"))) {
        byte[] b = new byte[6];
        new SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x & 0xFF));
        Js.put(c, "device", sb.toString());
        save(c);
      }
      return c;
    }
  }

  private void save(JSONObject c) {
    synchronized (confLock) {
      try { Js.writeAtomic(confFile, c.toString().getBytes(StandardCharsets.UTF_8)); } catch (Exception ignored) {}
    }
  }

  static String deviceName() {
    String m = Build.MODEL;
    return m == null || m.trim().isEmpty() ? "Android" : m.trim();
  }

  private static String safeName(String s) {
    String r = String.valueOf(s == null ? "" : s).replaceAll("(?i)[^a-z0-9 _-]", "").trim();
    if (r.length() > 30) r = r.substring(0, 30);
    return r.isEmpty() ? "Android" : r;
  }

  private static String myFile(JSONObject c) { return safeName(deviceName()) + "-" + Js.str(c.opt("device")) + ".json"; }

  private static String repoOf(JSONObject c) {
    JSONObject gh = c.optJSONObject("gh");
    return gh != null && Js.truthy(gh.opt("repo")) ? Js.str(gh.opt("repo")) : null;
  }

  private static String repoPath(String repo) {
    StringBuilder sb = new StringBuilder("/repos");
    for (String p : repo.split("/", -1)) sb.append('/').append(Js.encodeURIComponent(p));
    return sb.toString();
  }

  private String ghKey() { return secrets.get(KEY_NAME); }

  private Object gh(String path, String method, JSONObject body, String key, boolean raw) throws KError, IOException {
    GitHub.Answer a = GitHub.call(KoruBackend.GH_API + path, method, body == null ? null : body.toString().getBytes(StandardCharsets.UTF_8), key,
      raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", 20000);
    Object j = null;
    if (!raw) { try { j = Js.parseJson(a.text); } catch (Exception ignored) {} }
    if (!a.ok()) {
      String jm = j instanceof JSONObject ? ((JSONObject) j).optString("message", "") : "";
      String msg = a.status == 401 ? "GitHub didn't accept the key. It may have expired; make a new one."
        : a.status == 403 ? (jm.toLowerCase(java.util.Locale.ROOT).contains("rate limit") ? "GitHub says to slow down. Koru will try again later." : "That key can't write to the repo. Give it Contents: Read and write on this repo.")
        : a.status == 404 ? "GitHub can't find that repo with this key. Check the name (owner/repo) and that the key has access to it."
        : (!jm.isEmpty() ? jm : "GitHub answered " + a.status);
      throw new KError(a.status, msg);
    }
    return raw ? a.text : j;
  }

  private List<JSONObject> ghList(String repo, String key) throws KError, IOException {
    List<JSONObject> out = new ArrayList<>();
    Object r;
    try { r = gh(repoPath(repo) + "/contents/koru-sync", "GET", null, key, false); }
    catch (KError e) { if (e.status == 404) return out; throw e; }   // no koru-sync folder yet
    if (r instanceof JSONArray) {
      JSONArray a = (JSONArray) r;
      for (int i = 0; i < a.length(); i++) {
        JSONObject f = a.optJSONObject(i);
        if (f != null && "file".equals(f.optString("type")) && f.optString("name").endsWith(".json")) out.add(f);
      }
    }
    return out;
  }

  private static String otherName(String f) { return f.replaceFirst("-[0-9a-f]{12}\\.json$", "").replaceFirst("\\.json$", ""); }

  Res route(String sub, String method, Map<String, String> q, String body) {
    try {
      JSONObject c = conf();
      String repo = repoOf(c);
      String mode = repo != null ? "github" : null;
      String device = Js.str(c.opt("device"));

      if (sub.equals("/info")) {
        JSONArray others = new JSONArray();
        String key = ghKey();
        if (mode != null && Js.truthy(q.get("others")) && key != null) {
          try { for (JSONObject f : ghList(repo, key)) { String n = f.optString("name"); if (!n.contains(device)) others.put(Js.obj("name", otherName(n))); } } catch (Exception ignored) {}
        }
        return Res.json(200, Js.obj("mode", mode, "dir", null, "repo", repo, "hasKey", key != null, "reachable", mode != null,
          "device", device, "name", deviceName(), "others", others));
      }
      if (sub.equals("/pick")) return Res.error(400, "Sync with a folder isn't available on Android. Use your own private GitHub repo instead.");

      // connect a private GitHub repo: { repo: 'owner/name', key }
      if (sub.equals("/github") && method.equals("POST")) {
        JSONObject b;
        try { b = Js.parseBody(body); } catch (Exception e) { b = new JSONObject(); }
        String r = (Js.truthy(b.opt("repo")) ? Js.str(b.opt("repo")) : "").trim().replaceFirst("(?i)^https?://github\\.com/", "").replaceFirst("\\.git$", "").replaceFirst("/+$", "");
        String k = (Js.truthy(b.opt("key")) ? Js.str(b.opt("key")) : "").trim();
        if (k.isEmpty()) k = ghKey();
        if (!REPO_RE.matcher(r).matches()) return Res.error(400, "Write the repo as owner/name, like yourname/koru-sync.");
        if (k == null || !KEY_RE.matcher(k).matches()) return Res.error(400, "That doesn't look like a GitHub key. It starts with github_pat_.");
        Object infoO = gh(repoPath(r), "GET", null, k, false);
        JSONObject info = infoO instanceof JSONObject ? (JSONObject) infoO : new JSONObject();
        if (!Js.truthy(info.opt("private"))) return Res.error(400, "That repo is public. Use a private repo so your reading history stays yours.");
        JSONObject perms = info.optJSONObject("permissions");
        if (perms != null && !Js.truthy(perms.opt("push"))) return Res.error(400, "That key can read the repo but can't write to it. Give it Contents: Read and write.");
        secrets.set(KEY_NAME, k);
        String full = Js.truthy(info.opt("full_name")) ? Js.str(info.opt("full_name")) : r;
        synchronized (confLock) {
          JSONObject c2 = conf();
          Js.put(c2, "gh", Js.obj("repo", full));
          c2.remove("dir");
          save(c2);
        }
        shas.clear(); cache.clear();
        return Res.json(200, Js.obj("repo", full));
      }
      if (sub.equals("/off") && method.equals("POST")) {
        synchronized (confLock) {
          JSONObject c2 = conf();
          c2.remove("dir"); c2.remove("gh");
          save(c2);
        }
        try { secrets.set(KEY_NAME, null); } catch (Exception ignored) {}
        shas.clear(); cache.clear();
        return Res.ok();
      }

      if (mode == null) return Res.error(409, "Sync is off.");
      String key = ghKey();
      if (key == null) return Res.error(409, "The GitHub key is missing on this PC. Connect the repo again.");

      if (sub.equals("/read")) {
        JSONArray files = new JSONArray();
        String mine = myFile(c);
        for (JSONObject f : ghList(repo, key)) {
          String name = f.optString("name"), sha = f.optString("sha");
          if (name.equals(mine)) { shas.put(name, sha); continue; }
          if (name.contains(device)) continue;
          Object[] hit = cache.get(name);
          if (hit != null && sha.equals(hit[0])) { files.put(hit[1]); continue; }
          try {
            Object data = Js.parseJson((String) gh(repoPath(repo) + "/contents/koru-sync/" + Js.encodeURIComponent(name), "GET", null, key, true));
            cache.put(name, new Object[]{sha, data});
            files.put(data);
          } catch (Exception ignored) {}
        }
        return Res.json(200, Js.obj("files", files));
      }
      if (sub.equals("/write") && method.equals("PUT")) {
        Js.parseJson(body);
        String name = myFile(c);
        String p = repoPath(repo) + "/contents/koru-sync/" + Js.encodeURIComponent(name);
        String content = Base64.encodeToString(body.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        Object r;
        try {
          r = gh(p, "PUT", putBody(content, shas.get(name)), key, false);
        } catch (KError e) {
          if (e.status != 409 && e.status != 422) throw e;   // our idea of the file's version was out of date
          String sha = null;
          try { Object cur = gh(p, "GET", null, key, false); if (cur instanceof JSONObject) sha = ((JSONObject) cur).optString("sha", null); } catch (Exception ignored) {}
          r = gh(p, "PUT", putBody(content, sha), key, false);
        }
        if (r instanceof JSONObject) {
          JSONObject ct = ((JSONObject) r).optJSONObject("content");
          if (ct != null && ct.optString("sha", null) != null) shas.put(name, ct.optString("sha"));
        }
        return Res.ok();
      }
      return Res.error(404, "Not found");
    } catch (KError e) {
      return Res.error(e.status == 401 || e.status == 403 || e.status == 404 ? 400 : 500, Js.message(e, "Sync error"));
    } catch (IOException e) {
      return Res.error(500, "Couldn't reach GitHub. Check your connection and try again.");
    } catch (Throwable t) {
      return Res.error(500, Js.message(t, "Sync error"));
    }
  }

  private static JSONObject putBody(String content, String sha) {
    JSONObject o = Js.obj("message", "Koru sync from " + safeName(deviceName()), "content", content);
    if (sha != null && !sha.isEmpty()) Js.put(o, "sha", sha);
    return o;
  }
}
