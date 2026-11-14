package app.koru.reader.backend;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Chapter downloads (a small queue, two chapters at a time, three pages at a time each), the downloaded library,
 * downloaded files and .cbz export. Same folder layout as the desktop:
 * downloads/<provider>-<series>/series.json + cover.<ext>, and downloads/<provider>-<series>/<chapter>/chapter.json + 0001.jpg...
 */
final class Downloads {
  static final Map<String, String> IMG_TYPES = new HashMap<>();
  static final Map<String, String> MIME = new HashMap<>();
  static {
    IMG_TYPES.put("image/jpeg", "jpg"); IMG_TYPES.put("image/png", "png"); IMG_TYPES.put("image/webp", "webp");
    IMG_TYPES.put("image/gif", "gif"); IMG_TYPES.put("image/avif", "avif");
    MIME.put("jpg", "image/jpeg"); MIME.put("jpeg", "image/jpeg"); MIME.put("png", "image/png"); MIME.put("webp", "image/webp");
    MIME.put("gif", "image/gif"); MIME.put("avif", "image/avif"); MIME.put("json", "application/json");
  }
  static final Pattern PAGE_RE = Pattern.compile("^[\\w-][\\w.-]*\\.(jpe?g|png|webp|gif|avif)$", Pattern.CASE_INSENSITIVE);
  private static final Pattern URL_EXT = Pattern.compile("\\.(jpe?g|png|webp|gif|avif)(?:$|\\?)", Pattern.CASE_INSENSITIVE);
  private static final Pattern BAD_NAME = Pattern.compile("[\\\\/:*?\"<>|\\x00-\\x1F]");
  private static final long MAX_PAGE = 64L << 20;
  private static final long KEEP_FINISHED_MS = 60000;

  final File root;
  private final String rootCanon;
  private final ExecutorService runner = Executors.newFixedThreadPool(2, daemon("koru-dl"));
  private final ExecutorService io = Executors.newCachedThreadPool(daemon("koru-io"));
  private final List<Job> queue = new ArrayList<>();   // jobs waiting or running, in order (guarded by itself)
  private final ConcurrentHashMap<String, Object> locks = new ConcurrentHashMap<>();

  Downloads(File root) {
    this.root = root;
    //noinspection ResultOfMethodCallIgnored
    root.mkdirs();
    String c;
    try { c = root.getCanonicalPath(); } catch (IOException e) { c = root.getAbsolutePath(); }
    rootCanon = c;
  }

  static ThreadFactory daemon(final String name) {
    final AtomicInteger n = new AtomicInteger();
    return r -> { Thread t = new Thread(r, name + "-" + n.incrementAndGet()); t.setDaemon(true); return t; };
  }

  static String safe(String s) {
    String r = String.valueOf(s).replaceAll("[^a-zA-Z0-9._-]+", "_").replaceFirst("^\\.+", "_");
    if (r.length() > 90) r = r.substring(0, 90);
    return r.isEmpty() ? "_" : r;
  }

  File seriesDir(String provider, String slug) { return new File(root, safe(provider + "-" + slug)); }

  File chapterDir(String provider, String slug, String ch) { return new File(seriesDir(provider, slug), safe(ch)); }

  private Object lockFor(String key) {
    Object fresh = new Object();
    Object had = locks.putIfAbsent(key, fresh);
    return had != null ? had : fresh;
  }

  // ---------- the queue ----------
  static final class Job {
    String id, provider, seriesSlug, seriesTitle, cover, chapterSlug, chapterName;
    Object number;
    List<String> pages;
    boolean auto;
    final AtomicInteger done = new AtomicInteger();
    volatile String state = "queued";
    volatile String error;
    volatile boolean cancelled;
    volatile long finishedAt;
  }

  private static JSONObject jobView(Job j) {
    return Js.obj("id", j.id, "seriesTitle", j.seriesTitle, "chapterName", j.chapterName, "provider", j.provider, "seriesSlug", j.seriesSlug,
      "chapterSlug", j.chapterSlug, "done", j.done.get(), "total", j.pages.size(), "state", j.state, "error", j.error, "auto", j.auto);
  }

  /** Finished jobs stay visible for a minute so the Downloads page can show them. Call with the queue locked. */
  private void prune() {
    long now = System.currentTimeMillis();
    for (Iterator<Job> it = queue.iterator(); it.hasNext(); ) {
      Job j = it.next();
      if (j.finishedAt > 0 && now - j.finishedAt > KEEP_FINISHED_MS && !"queued".equals(j.state) && !"downloading".equals(j.state)) it.remove();
    }
  }

  Res start(JSONObject b) {
    String cover = null;
    Object co = b.opt("cover");
    if (co instanceof String && Js.truthy(co)) { String u = SiteFetch.unwrap((String) co); cover = Js.truthy(u) ? u : null; }
    List<String> pages = new ArrayList<>();
    JSONArray pa = b.optJSONArray("pages");
    if (pa != null) for (int i = 0; i < pa.length(); i++) {
      Object p = pa.opt(i);
      if (!(p instanceof String)) continue;
      String u = SiteFetch.unwrap((String) p);
      if (SiteFetch.allowedUrl(u)) pages.add(u);
    }
    Object provider = b.opt("provider"), seriesSlug = b.opt("seriesSlug"), chapterSlug = b.opt("chapterSlug");
    if (!Js.truthy(provider) || !Js.truthy(seriesSlug) || !Js.truthy(chapterSlug) || pages.isEmpty()) return Res.error(400, "Nothing to download.");
    String id = Js.str(provider) + ":" + Js.str(seriesSlug) + ":" + Js.str(chapterSlug);
    synchronized (queue) {
      prune();
      boolean active = false;
      for (Job j : queue) if (j.id.equals(id) && ("queued".equals(j.state) || "downloading".equals(j.state))) { active = true; break; }
      if (!active) {
        final Job job = new Job();
        job.id = id;
        job.provider = Js.str(provider);
        job.seriesSlug = Js.str(seriesSlug);
        job.seriesTitle = Js.str(Js.truthy(b.opt("seriesTitle")) ? b.opt("seriesTitle") : seriesSlug);
        job.cover = cover;
        job.chapterSlug = Js.str(chapterSlug);
        job.chapterName = Js.str(Js.truthy(b.opt("chapterName")) ? b.opt("chapterName") : chapterSlug);
        job.number = Js.nullish(b.opt("number"));
        job.pages = pages;
        job.auto = Js.truthy(b.opt("auto"));
        queue.add(job);
        runner.execute(() -> run(job));
      }
    }
    return json200("ok", true, "id", id);
  }

  Res cancel(JSONObject b) {
    Object id = b.opt("id");
    synchronized (queue) {
      for (Job j : queue) {
        if (j.id.equals(id) || "*".equals(id)) {
          j.cancelled = true;
          if ("queued".equals(j.state)) { j.state = "cancelled"; j.finishedAt = System.currentTimeMillis(); }
        }
      }
    }
    return Res.ok();
  }

  Res queueView() {
    JSONArray jobs = new JSONArray();
    synchronized (queue) {
      prune();
      for (Job j : queue) jobs.put(jobView(j));
    }
    return json200("jobs", jobs);
  }

  private void run(Job job) {
    if (job.cancelled || !"queued".equals(job.state)) return;
    try {
      runJob(job);
    } catch (Throwable t) {
      job.state = job.cancelled ? "cancelled" : "failed";
      job.error = job.cancelled ? null : "Some pages wouldn't download. Try again.";
    } finally {
      job.finishedAt = System.currentTimeMillis();
    }
  }

  private void saveCover(Job job) throws IOException {
    File dir = seriesDir(job.provider, job.seriesSlug);
    synchronized (lockFor(dir.getName())) {
      if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) throw new IOException("Couldn't create the folder");
      File metaFile = new File(dir, "series.json");
      JSONObject meta = Js.readJsonObject(metaFile);
      if (meta == null) meta = new JSONObject();
      if (!Js.truthy(meta.opt("cover")) && job.cover != null && SiteFetch.allowedUrl(job.cover)) {
        try (SiteFetch.Resp r = SiteFetch.fetch(job.cover, "image/*")) {
          String ext = IMG_TYPES.get(r.mime());
          if (r.ok() && ext != null) {
            byte[] data = r.readAll(MAX_PAGE);
            Js.writeAtomic(new File(dir, "cover." + ext), data);
            Js.put(meta, "cover", "cover." + ext);
          }
        } catch (Exception ignored) {}
      }
      Js.put(meta, "provider", job.provider);
      Js.put(meta, "seriesSlug", job.seriesSlug);
      Js.put(meta, "title", job.seriesTitle);
      Js.writeAtomic(metaFile, meta.toString().getBytes(StandardCharsets.UTF_8));
    }
  }

  private void runJob(final Job job) throws Exception {
    job.state = "downloading";
    saveCover(job);
    File dir = chapterDir(job.provider, job.seriesSlug, job.chapterSlug);
    final File part = new File(dir.getPath() + ".part");
    Js.deleteRecursive(part);
    if (!part.mkdirs() && !part.isDirectory()) throw new IOException("Couldn't create the folder");
    final int n = job.pages.size();
    final String[] files = new String[n];
    final AtomicLong bytes = new AtomicLong();
    final AtomicInteger next = new AtomicInteger();
    final AtomicReference<Exception> fail = new AtomicReference<>();
    try {
      List<Future<?>> workers = new ArrayList<>();
      for (int w = 0; w < Math.min(3, n); w++) workers.add(io.submit(() -> {
        while (!job.cancelled && fail.get() == null) {
          int i = next.getAndIncrement();
          if (i >= n) break;
          Exception last = null;
          for (int attempt = 0; attempt < 3 && !job.cancelled; attempt++) {
            try {
              String url = job.pages.get(i);
              try (SiteFetch.Resp r = SiteFetch.fetch(url, "image/*")) {
                if (!r.ok()) throw new IOException("HTTP " + r.status);
                String ext = IMG_TYPES.get(r.mime());
                if (ext == null) {
                  Matcher m = URL_EXT.matcher(url);
                  ext = m.find() ? m.group(1).toLowerCase(Locale.ROOT).replace("jpeg", "jpg") : "jpg";
                }
                String name = Js.pad4(i + 1) + "." + ext;
                long got;
                try (OutputStream out = new FileOutputStream(new File(part, name))) { got = r.copyTo(out, MAX_PAGE); }
                files[i] = name;
                bytes.addAndGet(got);
                job.done.incrementAndGet();
              }
              last = null;
              break;
            } catch (Exception e) {
              last = e;
              try { Js.sleep(800L * (attempt + 1)); } catch (IOException ie) { break; }
            }
          }
          if (last != null) { fail.compareAndSet(null, last); break; }
        }
      }));
      for (Future<?> f : workers) f.get();
      if (job.cancelled) throw new IOException("cancelled");
      if (fail.get() != null) throw fail.get();
      for (String f : files) if (f == null) throw new IOException("missing page");
      JSONArray fa = new JSONArray();
      for (String f : files) fa.put(f);
      SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
      iso.setTimeZone(TimeZone.getTimeZone("UTC"));
      JSONObject meta = Js.obj("id", job.id, "provider", job.provider, "seriesSlug", job.seriesSlug, "seriesTitle", job.seriesTitle,
        "chapterSlug", job.chapterSlug, "chapterName", job.chapterName, "number", job.number,
        "files", fa, "bytes", bytes.get(), "savedAt", iso.format(new Date()), "auto", job.auto);
      Js.writeAtomic(new File(part, "chapter.json"), meta.toString().getBytes(StandardCharsets.UTF_8));
      synchronized (lockFor(dir.getParentFile().getName())) {
        Js.deleteRecursive(dir);
        if (!part.renameTo(dir)) throw new IOException("Couldn't move the chapter into place");
      }
      job.state = "done";
    } catch (Exception e) {
      Js.deleteRecursive(part);
      job.state = job.cancelled ? "cancelled" : "failed";
      job.error = job.cancelled ? null : "Some pages wouldn't download. Try again.";
    }
  }

  // ---------- what's downloaded ----------
  private static File[] sortedKids(File dir) {
    File[] k = dir.listFiles();
    if (k == null) return new File[0];
    Arrays.sort(k, (a, b) -> a.getName().compareTo(b.getName()));
    return k;
  }

  Res list() {
    JSONArray out = new JSONArray();
    for (File s : sortedKids(root)) {
      if (!s.isDirectory() || Js.isSymlink(s)) continue;
      JSONObject meta = Js.readJsonObject(new File(s, "series.json"));
      if (meta == null) continue;
      JSONArray chapters = new JSONArray();
      double bytes = 0;
      for (File c : sortedKids(s)) {
        if (!c.isDirectory() || c.getName().endsWith(".part")) continue;
        JSONObject m = Js.readJsonObject(new File(c, "chapter.json"));
        if (m == null) continue;
        JSONObject copy = new JSONObject();
        for (Iterator<String> it = m.keys(); it.hasNext(); ) { String k = it.next(); Js.put(copy, k, m.opt(k)); }
        Js.put(copy, "dir", s.getName() + "/" + c.getName());
        chapters.put(copy);
        Object b = m.opt("bytes");
        if (b instanceof Number) bytes += ((Number) b).doubleValue();
      }
      if (chapters.length() == 0) continue;
      Object cover = meta.opt("cover");
      out.put(Js.obj("provider", Js.nullish(meta.opt("provider")), "seriesSlug", Js.nullish(meta.opt("seriesSlug")), "title", Js.nullish(meta.opt("title")),
        "cover", Js.truthy(cover) ? "/k/dl/file/" + Js.encodeURIComponent(s.getName()) + "/" + Js.encodeURIComponent(Js.str(cover)) : null,
        "bytes", bytes == Math.rint(bytes) ? (Object) (long) bytes : (Object) bytes, "chapters", chapters));
    }
    Object disk = null;
    try {
      //noinspection ResultOfMethodCallIgnored
      root.mkdirs();
      disk = Js.obj("free", root.getUsableSpace(), "total", root.getTotalSpace());
    } catch (Exception ignored) {}
    return json200("series", out, "disk", disk);
  }

  Res delete(JSONObject b) {
    Object id = b.opt("id"), series = b.opt("series");
    if (Js.truthy(id)) {
      String[] p = Js.str(id).split(":", -1);
      String provider = p[0], seriesSlug = p.length > 1 ? p[1] : "undefined";
      String rest = p.length > 2 ? join(p, 2) : "";
      File sdir = seriesDir(provider, seriesSlug);
      synchronized (lockFor(sdir.getName())) {
        Js.deleteRecursive(chapterDir(provider, seriesSlug, rest));
        File[] left = sdir.listFiles(File::isDirectory);
        if (left == null || left.length == 0) Js.deleteRecursive(sdir);
      }
    } else if (Js.truthy(series)) {
      String[] p = Js.str(series).split(":", -1);
      File sdir = seriesDir(p[0], p.length > 1 ? join(p, 1) : "");
      synchronized (lockFor(sdir.getName())) { Js.deleteRecursive(sdir); }
    }
    return Res.ok();
  }

  private static String join(String[] p, int from) {
    StringBuilder sb = new StringBuilder();
    for (int i = from; i < p.length; i++) { if (i > from) sb.append(':'); sb.append(p[i]); }
    return sb.toString();
  }

  /** GET /k/dl/file/<series>/<chapter>/<file> (or /<series>/<cover>): parts still percent-encoded. */
  Res file(List<String> encodedParts) throws IOException {
    File full = root;
    for (String e : encodedParts) {
      String x = Js.decodeComponent(e, false);
      if (x == null || x.isEmpty() || x.equals("..") || x.equals(".") || x.contains("/") || x.contains("\\") || x.indexOf('\0') >= 0) return Res.error(400, "Bad path");
      full = new File(full, x);
    }
    if (!full.getCanonicalPath().startsWith(rootCanon + File.separator)) return Res.error(400, "Bad path");
    String name = full.getName();
    int dot = name.lastIndexOf('.');
    String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    if (!full.isFile()) return Res.error(404, "Not downloaded");
    String type = MIME.get(ext);
    Res r = new Res(200, type == null ? "application/octet-stream" : type, new FileInputStream(full));
    r.cache = Res.FILE_CACHE;
    r.headers.put("Content-Length", Long.toString(full.length()));
    return r;
  }

  // ---------- CBZ export ----------
  /** A folder name straight under the downloads folder (or one level deeper): no separators, no dots-only names, no links. */
  private static boolean okName(String n) {
    return n != null && n.length() > 0 && n.length() < 200 && !BAD_NAME.matcher(n).find() && !n.matches("^\\.+$");
  }

  private File realDir(String... names) {
    File cur = root;
    for (String n : names) {
      if (!okName(n)) return null;
      cur = new File(cur, n);
      if (Js.isSymlink(cur)) return null;
    }
    if (cur.getName().endsWith(".part") || !cur.isDirectory()) return null;
    return cur;
  }

  private static final class Chapter {
    final JSONObject meta;
    final List<File> files;
    Chapter(JSONObject meta, List<File> files) { this.meta = meta; this.files = files; }
  }

  /** The pages of one downloaded chapter folder, in reading order (as chapter.json lists them). */
  private static Chapter chapterPages(File dir) {
    JSONObject meta = Js.readJsonObject(new File(dir, "chapter.json"));
    if (meta == null) return null;
    List<String> names = new ArrayList<>();
    JSONArray fa = meta.optJSONArray("files");
    if (fa != null) for (int i = 0; i < fa.length(); i++) { Object f = fa.opt(i); if (f instanceof String && PAGE_RE.matcher((String) f).matches()) names.add((String) f); }
    if (names.isEmpty()) {
      String[] all = dir.list();
      if (all != null) for (String f : all) if (PAGE_RE.matcher(f).matches()) names.add(f);
      Collections.sort(names, Js::naturalCompare);
    }
    List<File> files = new ArrayList<>();
    for (String n : names) { File f = new File(dir, n); if (f.isFile() && !Js.isSymlink(f)) files.add(f); }
    return files.isEmpty() ? null : new Chapter(meta, files);
  }

  private static double sortNum(JSONObject meta) {
    Object n = Js.nullish(meta.opt("number"));
    if (n == null) return 1e9;
    if (n instanceof Number) return ((Number) n).doubleValue();
    try { return Double.parseDouble(Js.str(n).trim()); } catch (Exception e) { return Double.NaN; }
  }

  static String fileName(String s) {
    String r = (s == null || s.isEmpty() ? "Koru" : s).replaceAll("[\\\\/:*?\"<>|\\x00-\\x1F]+", " ").replaceAll("\\s+", " ").replaceAll("^\\s+|\\s+$", "");
    if (r.length() > 120) r = r.substring(0, 120);
    return r.isEmpty() ? "Koru" : r;
  }

  static final class Plan {
    final List<CbzWriter.Entry> entries;
    final String name;
    Plan(List<CbzWriter.Entry> entries, String name) { this.entries = entries; this.name = name; }

    String contentDisposition() {
      return "attachment; filename=\"" + name.replaceAll("[^\\x20-\\x7E]", "_") + "\"; filename*=UTF-8''" + Js.encodeURIComponent(name);
    }
  }

  Plan plan(Map<String, String> q) throws KError {
    File sdir = null;
    List<File> cdirs = new ArrayList<>();
    String id = q.get("id"), dir = q.get("dir"), series = q.get("series");
    if (Js.truthy(dir)) {
      String[] p = dir.split("/", -1);
      if (p.length != 2 || p[1].isEmpty()) throw new KError(400, "Bad path");
      sdir = realDir(p[0]);
      File c = realDir(p[0], p[1]);
      if (c != null) cdirs.add(c);
    } else if (Js.truthy(id)) {
      String[] p = id.split(":", -1);
      if (p.length < 3 || p[0].isEmpty() || p[1].isEmpty()) throw new KError(400, "Bad id");
      sdir = realDir(safe(p[0] + "-" + p[1]));
      File c = sdir == null ? null : realDir(sdir.getName(), safe(join(p, 2)));
      if (c != null) cdirs.add(c);
    } else if (Js.truthy(series)) {
      // the series folder name, or "provider:slug" like /k/dl/delete takes
      String[] p = series.split(":", -1);
      sdir = realDir(series);
      if (sdir == null && p.length > 1) sdir = realDir(safe(p[0] + "-" + join(p, 1)));
      if (sdir != null) for (File d : sortedKids(sdir)) if (d.isDirectory() && !Js.isSymlink(d) && !d.getName().endsWith(".part")) cdirs.add(d);
    } else throw new KError(400, "Say which download to export.");
    if (sdir == null || cdirs.isEmpty()) throw new KError(404, "Not downloaded");
    JSONObject smeta = Js.readJsonObject(new File(sdir, "series.json"));
    if (smeta == null) smeta = new JSONObject();
    List<Chapter> chapters = new ArrayList<>();
    for (File c : cdirs) { Chapter ch = chapterPages(c); if (ch != null) chapters.add(ch); }
    Collections.sort(chapters, (a, b) -> {
      double d = sortNum(a.meta) - sortNum(b.meta);
      if (d != 0 && !Double.isNaN(d)) return d < 0 ? -1 : 1;
      return Js.naturalCompare(Js.truthy(a.meta.opt("chapterName")) ? Js.str(a.meta.opt("chapterName")) : "",
        Js.truthy(b.meta.opt("chapterName")) ? Js.str(b.meta.opt("chapterName")) : "");
    });
    if (chapters.isEmpty()) throw new KError(404, "Not downloaded");
    String title = Js.truthy(smeta.opt("title")) ? Js.str(smeta.opt("title"))
      : Js.truthy(chapters.get(0).meta.opt("seriesTitle")) ? Js.str(chapters.get(0).meta.opt("seriesTitle")) : sdir.getName();
    JSONObject one = !Js.truthy(series) && chapters.size() == 1 ? chapters.get(0).meta : null;
    List<CbzWriter.Entry> entries = new ArrayList<>();
    for (int ci = 0; ci < chapters.size(); ci++) {
      List<File> fs = chapters.get(ci).files;
      for (int pi = 0; pi < fs.size(); pi++) {
        String fname = fs.get(pi).getName();
        int dot = fname.lastIndexOf('.');
        String ext = (dot <= 0 ? "" : fname.substring(dot)).toLowerCase(Locale.ROOT).replace(".jpeg", ".jpg");
        // one chapter: 0001.jpg...; a series: 0001-0001.jpg... (chapter, page), flat so every reader keeps the order
        entries.add(new CbzWriter.Entry((one != null ? "" : Js.pad4(ci + 1) + "-") + Js.pad4(pi + 1) + ext, fs.get(pi)));
      }
    }
    int pages = entries.size();
    double min = Double.POSITIVE_INFINITY, max = Double.NEGATIVE_INFINITY;
    int nums = 0;
    for (Chapter c : chapters) {
      Object n = c.meta.opt("number");
      if (n instanceof Number) { double v = ((Number) n).doubleValue(); if (!Double.isNaN(v) && !Double.isInfinite(v)) { nums++; min = Math.min(min, v); max = Math.max(max, v); } }
    }
    String info;
    if (one != null) {
      Object num = Js.nullish(one.opt("number"));
      info = CbzWriter.comicInfo("Title", Js.truthy(one.opt("chapterName")) ? Js.str(one.opt("chapterName")) : "", "Series", title,
        "Number", num == null ? "" : Js.str(num), "PageCount", pages, "Notes", "Exported by Koru");
    } else {
      int n = chapters.size();
      info = CbzWriter.comicInfo("Title", title, "Series", title, "Count", n, "PageCount", pages,
        "Notes", "Exported by Koru: " + n + " chapter" + (n > 1 ? "s" : "") + (nums > 0 ? " (" + Js.num(min) + (char) 0x2013 + Js.num(max) + ")" : ""));
    }
    entries.add(new CbzWriter.Entry("ComicInfo.xml", info.getBytes(StandardCharsets.UTF_8)));
    String name;
    if (one != null) {
      Object num = Js.nullish(one.opt("number"));
      String chName = Js.truthy(one.opt("chapterName")) ? Js.str(one.opt("chapterName")) : "Chapter " + (num == null ? "" : Js.str(num));
      name = fileName(title + " - " + chName) + ".cbz";
    } else name = fileName(title) + ".cbz";
    return new Plan(entries, name);
  }

  /** GET /k/dl/cbz: the .cbz is written by a worker thread into a pipe the WebView reads from. */
  Res cbz(Map<String, String> q) throws KError {
    final Plan plan = plan(q);
    final Pipe pipe = new Pipe(256 * 1024);
    io.execute(() -> {
      try {
        CbzWriter.write(plan.entries, pipe.out);
        pipe.out.close();
      } catch (Throwable t) {
        pipe.fail();
      }
    });
    Res r = new Res(200, "application/vnd.comicbook+zip", pipe.in);
    r.headers.put("Content-Disposition", plan.contentDisposition());
    return r;
  }

  /** The same .cbz written to a file in `dir` (for sharing). Old exports there are cleaned up after an hour. */
  File exportCbz(Map<String, String> q, File dir) throws KError, IOException {
    Plan plan = plan(q);
    if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) throw new IOException("Couldn't create the export folder");
    File[] old = dir.listFiles();
    long now = System.currentTimeMillis();
    if (old != null) for (File f : old) if (now - f.lastModified() > 3600_000L) Js.deleteRecursive(f);
    File out = new File(dir, plan.name);
    File part = new File(dir, plan.name + "." + Thread.currentThread().getId() + ".part");
    try {
      try (OutputStream os = new java.io.BufferedOutputStream(new FileOutputStream(part), 256 * 1024)) { CbzWriter.write(plan.entries, os); }
      if (out.exists()) //noinspection ResultOfMethodCallIgnored
        out.delete();
      if (!part.renameTo(out)) throw new IOException("Couldn't save the export");
    } finally {
      if (part.exists()) //noinspection ResultOfMethodCallIgnored
        part.delete();
    }
    return out;
  }

  private static Res json200(Object... kv) { return Res.json(200, Js.obj(kv)); }
}
